/**
 * connection_status: checks the connection step by step and reports the first step that fails,
 * with the likely cause and the fix.
 *
 * 1. Settings: the connection settings resolve, including IAM or Secrets Manager credentials.
 * 2. An existing connection pool answers a small query (the usual, fast path).
 * 3. DNS: the host name resolves (private addresses need a VPN, peered network or tunnel).
 * 4. Network: a TCP connection to the database port opens.
 * 5. Login: a new connection logs in and answers the query.
 *
 * The first lines of a success stay `Connected`, `Database:`, `User:` and `Host:`, as before.
 */
import { Client, Pool } from 'pg';
import {
  resolveConnectionConfig,
  getActivePool,
  ensurePool,
  discardPool,
  isConnectionLevelError,
  connectTimeoutMs,
  withConnectTimeout,
  getPoolMax,
  ConnectionConfig,
} from './db/pool';
import { diagnose, renderDiagnosis, errorText, formatSeconds, addressKind, Diagnosis, NetworkFacts } from './errors/describe';
import { lookupHost, probeTcp, ProbeResult } from './errors/network';
import { annotate } from './errors/context';

export const INFO_SQL = 'SELECT current_database() as database, current_user as user, inet_server_addr() as host, version() as version';

/** Time limits for the checks (a test seam). */
export const statusLimits = { queryLimitMs: 5_000, probeTimeoutMs: 5_000 };

interface InfoRow {
  database?: unknown;
  user?: unknown;
  host?: unknown;
  version?: unknown;
}

interface Info {
  row: InfoRow;
  ms: number;
}

class CheckTimeout extends Error {
  constructor(readonly ms: number) {
    super(`no answer within ${formatSeconds(ms)}`);
    this.name = 'CheckTimeout';
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CheckTimeout(ms)), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function queryInfo(pool: Pool): Promise<Info> {
  const started = Date.now();
  const result = await pool.query(INFO_SQL);
  return { row: (result.rows?.[0] ?? {}) as InfoRow, ms: Date.now() - started };
}

/** Logs in on a new connection outside the pool (used when the pool is busy or not answering). */
async function sideClientInfo(config: ConnectionConfig): Promise<Info> {
  const timeout = connectTimeoutMs() || 10_000;
  const client = new Client(withConnectTimeout(config as unknown as Record<string, unknown>, timeout) as never) as unknown as {
    connect: () => Promise<unknown>;
    query: (text: string) => Promise<{ rows?: unknown[] }>;
    end: () => Promise<void>;
    on?: (event: string, fn: () => void) => void;
  };
  client.on?.('error', () => undefined);
  try {
    try {
      await client.connect();
    } catch (err) {
      throw annotate(err, { phase: 'connect', target: { host: config.host, port: config.port }, connectTimeoutMs: timeout });
    }
    const started = Date.now();
    const result = await within(client.query(INFO_SQL), statusLimits.queryLimitMs);
    return { row: (result.rows?.[0] ?? {}) as InfoRow, ms: Date.now() - started };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function poolLine(pool: Pool): string {
  const p = pool as unknown as { totalCount?: number; idleCount?: number; waitingCount?: number; options?: { max?: number } };
  const total = p.totalCount ?? 0;
  const idle = p.idleCount ?? 0;
  return `${Math.max(0, total - idle)} in use, ${idle} idle, ${p.waitingCount ?? 0} waiting (max ${p.options?.max ?? getPoolMax()})`;
}

function connected(info: Info, pool: Pool, config: ConnectionConfig, note: string | null): string {
  const row = info.row;
  const lines = [
    'Connected',
    `Database: ${row.database}`,
    `User: ${row.user}`,
    `Host: ${row.host || config.host}`,
  ];
  if (row.version) {
    const version = String(row.version);
    lines.push(`Server: ${version.length > 300 ? `${version.slice(0, 299)}…` : version}`);
  }
  lines.push(`Round trip: ${info.ms} ms`, `Pool: ${poolLine(pool)}`);
  if (note) lines.push(note);
  return lines.join('\n');
}

function region(): string {
  return process.env.SQL_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
}

function settingsSummary(config: ConnectionConfig): string {
  const auth = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase();
  const where = `database ${config.database} at ${config.host}:${config.port}, SSL mode ${process.env.SQL_SSL_MODE || 'require'}`;
  if (auth === 'iam') return `IAM credentials for cluster ${process.env.SQL_CLUSTER_ID} in ${region()}, user ${config.user}, ${where}`;
  if (auth === 'secrets_manager') return `secret ${process.env.SQL_SECRET_ID} in ${region()}, user ${config.user}, ${where}`;
  return `password login, user ${config.user}, ${where}`;
}

function addressesText(addresses: string[]): string {
  const shown = addresses.slice(0, 4).join(', ') + (addresses.length > 4 ? `, and ${addresses.length - 4} more` : '');
  return `${shown}, ${addressKind(addresses)}`;
}

function probeText(probe: ProbeResult): string {
  const where = `${probe.address}:${probe.port}`;
  switch (probe.outcome) {
    case 'open':
      return `TCP connection to ${where} in ${formatSeconds(probe.ms)}`;
    case 'timeout':
      return `no answer from ${where} within ${formatSeconds(probe.timeoutMs)}`;
    case 'refused':
      return `${where} refused the connection`;
    case 'unreachable':
      return `no route to ${where} (${probe.code ?? 'unreachable'})`;
    default:
      return `${where}: ${probe.code ?? probe.message ?? 'error'}`;
  }
}

/** An error standing for a failed network check, so it is described like the same failure in a query. */
function networkError(probe: ProbeResult, config: ConnectionConfig): Error {
  const code =
    probe.outcome === 'refused' ? 'ECONNREFUSED' : probe.outcome === 'timeout' ? 'ETIMEDOUT' : probe.code ?? 'EHOSTUNREACH';
  const message = probe.message ?? `connect ${code} ${probe.address}:${probe.port}`;
  return annotate(Object.assign(new Error(message), { code, syscall: 'connect' }), {
    phase: 'connect',
    target: { host: config.host, port: config.port },
  });
}

function dnsError(code: string | undefined, message: string | undefined, config: ConnectionConfig): Error {
  const c = code ?? 'ENOTFOUND';
  return annotate(Object.assign(new Error(message ?? `getaddrinfo ${c} ${config.host}`), { code: c, syscall: 'getaddrinfo' }), {
    phase: 'connect',
    target: { host: config.host, port: config.port },
  });
}

async function notConnected(
  err: unknown,
  checks: string[],
  failed: { step: string; detail?: string },
  network: NetworkFacts,
  skipped: string[],
): Promise<string> {
  const d: Diagnosis | null = await diagnose(err, { network, checks: false }).catch(() => null);
  const block = [
    'Checks:',
    ...checks.map((c) => `  ${c}`),
    `  ${failed.step}: failed${failed.detail ? ` (${failed.detail})` : ''}`,
    ...skipped.map((s) => `  ${s}: not checked`),
  ];
  if (!d) return [`Not connected: ${errorText(err)}`, ...block].join('\n');
  // The Checks block replaces the diagnosis's own "Checked:" line; DNS and network failures come
  // from this check itself, so there is no driver message to show.
  const own = failed.step === 'DNS' || failed.step === 'Network';
  const lines = d.lines.filter((l) => !l.startsWith('Checked: ') && !(own && l.startsWith('Driver message: ')));
  return renderDiagnosis({ ...d, lines }, { prefix: 'Not connected', before: block });
}

/** The connection_status text (never throws). */
export async function connectionStatus(): Promise<string> {
  try {
    return await check();
  } catch (err) {
    return `Not connected: ${errorText(err)}`;
  }
}

async function check(): Promise<string> {
  const checks: string[] = [];
  let config: ConnectionConfig;
  try {
    config = await resolveConnectionConfig();
  } catch (err) {
    return notConnected(err, checks, { step: 'Settings' }, {}, ['DNS', 'Network', 'Login']);
  }
  checks.push(`Settings: ok (${settingsSummary(config)})`);

  // The usual case: the pool answers right away.
  const existing = getActivePool();
  let poolTrouble: string | null = null;
  if (existing) {
    const limit = (connectTimeoutMs() || 10_000) + statusLimits.queryLimitMs;
    try {
      return connected(await within(queryInfo(existing), limit), existing, config, null);
    } catch (err) {
      if (err instanceof CheckTimeout) {
        poolTrouble = `the existing connection pool did not answer within ${formatSeconds(limit)} (${poolLine(existing)})`;
      } else if (isConnectionLevelError(err)) {
        discardPool(existing);
      }
    }
  }

  const network: NetworkFacts = {};
  if (config.host.startsWith('/')) {
    checks.push('DNS: not needed (Unix socket)', 'Network: not needed (Unix socket)');
  } else {
    const lookup = await lookupHost(config.host, 2_000);
    network.lookup = lookup;
    if (!lookup.ok) {
      const detail = `${config.host}: ${lookup.code ?? lookup.message ?? 'no answer'}`;
      return notConnected(dnsError(lookup.code, lookup.message, config), checks, { step: 'DNS', detail }, network, ['Network', 'Login']);
    }
    const addresses = lookup.addresses.map((a) => a.address);
    checks.push(addresses.length === 1 && addresses[0] === config.host
      ? 'DNS: not needed (SQL_HOST is an IP address)'
      : `DNS: ok (resolves to ${addressesText(addresses)})`);
    const probe = await probeTcp(addresses[0], config.port, statusLimits.probeTimeoutMs);
    network.probe = probe;
    if (probe.outcome !== 'open') {
      return notConnected(networkError(probe, config), checks, { step: 'Network', detail: probeText(probe) }, network, ['Login']);
    }
    checks.push(`Network: ok (${probeText(probe)})`);
  }

  try {
    const current = getActivePool();
    if (!current) {
      const started = Date.now();
      const created = await ensurePool();
      const loginMs = Date.now() - started;
      const info = await within(queryInfo(created), statusLimits.queryLimitMs);
      return connected(info, created, config, loginMs > 5_000 ? `Note: logging in took ${formatSeconds(loginMs)}.` : null);
    }
    const info = await sideClientInfo(config);
    const note = poolTrouble
      ? `Note: a new connection works, but ${poolTrouble}. Long-running queries or open results may be holding every connection.`
      : null;
    return connected(info, current, config, note);
  } catch (err) {
    return notConnected(err, checks, { step: 'Login' }, network, []);
  }
}
