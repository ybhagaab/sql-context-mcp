/**
 * Error descriptions: what failed, the likely cause, how to fix it, and whether any SQL ran.
 *
 * Every tool error is one text block:
 *
 *   Error: <summary>
 *   Likely cause: <cause>
 *   To fix: <action>
 *   <Detail:, Hint:, Where:, "At line L, column C:" with a caret, Checked: ...>
 *   Error type: <type>. <what happened to the SQL>
 *
 * The first line keeps the `Error: ` prefix, and database errors keep the database's own message
 * there. The server's own errors (cancellation, timeouts, paging and export limits, validation)
 * are already specific and stay one line.
 *
 * Connection failures are explained with facts, not guesses: the error code, the phase it
 * happened in (settings, AWS credentials, connecting, running SQL), a DNS lookup (private
 * addresses mean a VPN, peered network or tunnel is needed) and, when the driver only reports a
 * timeout, a plain TCP connection to the database port.
 */
import * as net from 'net';
import { contextOf, ErrorContext, ConnectTarget, StatementRef } from './context';
import { lookupHost, probeTcp, isPrivateAddress, isLoopbackHost, isLoopbackAddress, LookupResult, ProbeResult } from './network';
import { sqlStateLabel } from './sqlstate';
import { mayChangeData } from '../sql/classify';

export type ErrorType =
  | 'config'
  | 'aws_credentials'
  | 'dns'
  | 'network_timeout'
  | 'network_unreachable'
  | 'connection_refused'
  | 'connect_timeout'
  | 'tls'
  | 'auth'
  | 'database_not_found'
  | 'too_many_connections'
  | 'server_unavailable'
  | 'connection_lost'
  | 'sql_error'
  | 'permission_denied'
  | 'server_timeout';

export interface Diagnosis {
  type: ErrorType;
  summary: string;
  cause?: string;
  fix?: string;
  /** Extra lines: Detail, Hint, Where, the error position, Checked. */
  lines: string[];
  /** "SQLSTATE 42P01 undefined_table" for database errors. */
  sqlstate?: string;
}

export interface NetworkFacts {
  lookup?: LookupResult;
  probe?: ProbeResult;
}

export interface RenderedError {
  /** null for the server's own one-line errors and for errors that can't be classified. */
  type: ErrorType | null;
  text: string;
}

/** Errors that don't take the SQL status sentence: nothing reached the database. */
const NO_SQL_TYPES = new Set<ErrorType>([
  'config', 'aws_credentials', 'dns', 'network_timeout', 'network_unreachable', 'connection_refused', 'connect_timeout',
  'tls', 'auth', 'database_not_found', 'too_many_connections', 'server_unavailable',
]);

/** The server's own errors: their message already says what happened and what to do. */
const CLEAR_ERRORS = new Set([
  'QueryCancelledError', 'QueryTimeoutError', 'RowTooLargeError', 'ResultUnavailableError', 'ForwardOnlyError',
  'OffsetOutOfRangeError', 'EmptySqlError', 'SpoolLimitError', 'DiskNearlyFullError',
]);

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA', 'ETIMEOUT']);
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EHOSTDOWN']);
const LOST_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', ...UNREACHABLE_CODES]);
const LOST_PHRASES = [
  'Connection terminated',
  'terminated unexpectedly',
  'Client has encountered a connection error',
  'Cannot use a pool after calling end',
  'socket hang up',
];
/** Precedence among the codes of an AggregateError (one per address tried). */
const NET_PRECEDENCE = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'];
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE', 'CERT_REVOKED', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'CERT_CHAIN_TOO_LONG', 'INVALID_CA',
]);

const SQL_FIXES: Record<string, string> = {
  '42P01': 'Check the table name and schema (list_schemas and list_tables show what exists), and write it as schema.table if it is not in the search path.',
  '3F000': 'Check the schema name (list_schemas shows the schemas).',
  '42703': 'Check the column names (describe_table lists them).',
  '42702': 'Qualify the column with its table name or alias.',
  '42803': 'Add the column to GROUP BY, or wrap it in an aggregate such as MAX().',
  '42883': 'The function does not exist for these argument types: add explicit casts, or use a function this database supports (Redshift does not have every PostgreSQL function).',
  '22012': 'Guard the divisor, for example with NULLIF(divisor, 0).',
  '25P02': 'An earlier statement in this transaction failed, so the database ignored the rest. Fix the first error and run the script again.',
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const SECRET_KEY = /pass|secret|token|credential|authorization|api.?key|private.?key/i;
/** Credential literals in SQL (Redshift COPY/UNLOAD options, CREATE/ALTER USER ... PASSWORD). */
const SECRET_LITERAL = /\b(password|credentials|access_key_id|secret_access_key|session_token|master_symmetric_key)(\s+(?:as\s+)?)'((?:[^']|'')*)'/gi;

/** Masks credential literals in a line of SQL, keeping its length so a caret still lines up. */
export function maskSecrets(line: string): string {
  return line.replace(
    SECRET_LITERAL,
    (_m, keyword: string, gap: string, value: string) => `${keyword}${gap}'${'*'.repeat(Array.from(value).length)}'`,
  );
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function quote(text: string): string {
  return `"${text}"`;
}

/** "850 ms", "3.2 s", "20 s". */
export function formatSeconds(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, '')} s`;
  return `${Math.round(ms / 1_000)} s`;
}

function chainOf(err: unknown): Loose[] {
  const out: Loose[] = [];
  let current: unknown = err;
  while (current && typeof current === 'object' && out.length < 6 && !out.includes(current as Loose)) {
    out.push(current as Loose);
    current = (current as Loose).cause;
  }
  return out;
}

/**
 * A one-line description of any thrown value, never blank: the message, else the messages of an
 * AggregateError's errors, else the name, code and cause.
 */
export function errorText(err: unknown): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value !== 'object') return String(value);
    if (seen.has(value) || depth > 3) return '';
    seen.add(value);
    const e = value as Loose;
    const message = typeof e.message === 'string' ? e.message.trim() : '';
    if (message) return message;
    if (Array.isArray(e.errors)) {
      const inner = [...new Set(e.errors.map((x) => describe(x, depth + 1)).filter(Boolean))];
      if (inner.length) return inner.join('; ');
    }
    const name = str(e.name) && e.name !== 'Error' ? String(e.name) : '';
    const code = str(e.code) ?? '';
    const label = [name, code].filter(Boolean).join(' ');
    const cause = describe(e.cause, depth + 1);
    if (label && cause) return `${label}: ${cause}`;
    if (label || cause) return label || cause;
    if (!(value instanceof Error)) {
      try {
        // Values of secret-looking keys are never shown.
        const json = JSON.stringify(value, (key, v) => (SECRET_KEY.test(key) ? '[redacted]' : v));
        if (json && json !== '{}') return clip(json, 300);
      } catch {
        // not serializable
      }
    }
    return '';
  };
  // One line: Redshift syntax errors quote the SQL around the error, line breaks included.
  return (describe(err, 0) || 'Unknown error (no message)').replace(/\s*\r?\n\s*/g, ' ');
}

function isErrnoCode(code: string | undefined): code is string {
  return !!code && /^E[A-Z0-9_]+$/.test(code);
}

function netCodeOf(chain: Loose[]): string | null {
  for (const e of chain) {
    const code = str(e.code);
    if (isErrnoCode(code)) return code;
    if (Array.isArray(e.errors)) {
      const codes = e.errors.map((x) => str((x as Loose | null)?.code)).filter(isErrnoCode);
      for (const preferred of NET_PRECEDENCE) if (codes.includes(preferred)) return preferred;
      if (codes.length) return codes[0];
    }
  }
  return null;
}

function sqlStateOf(err: unknown): string | null {
  const code = str((err as Loose | null)?.code);
  // SQLSTATE classes never start with E, which keeps errno codes such as EPIPE out.
  return code && /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('E') ? code : null;
}

function socketField(chain: Loose[], field: 'syscall' | 'address' | 'port'): unknown {
  for (const e of chain) {
    if (e[field] !== undefined) return e[field];
    if (Array.isArray(e.errors)) {
      for (const inner of e.errors) {
        const v = (inner as Loose | null)?.[field];
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

interface Facts {
  err: unknown;
  ctx: ErrorContext;
  chain: Loose[];
  message: string;
  text: string;
  sqlstate: string | null;
  netCode: string | null;
  syscall: string | null;
  target: ConnectTarget | null;
  auth: string;
  sslMode: string;
  db: { detail?: string; hint?: string; where?: string; position?: number };
}

function factsOf(err: unknown): Facts {
  const ctx = contextOf(err);
  const chain = chainOf(err);
  const e = (chain[0] ?? {}) as Loose;
  const message = typeof e.message === 'string' ? e.message.trim() : typeof err === 'string' ? err.trim() : '';
  let target = ctx.target && ctx.target.host ? ctx.target : null;
  if (!target) {
    const address = str(socketField(chain, 'address'));
    const port = Number(socketField(chain, 'port'));
    if (address) target = { host: address, port: Number.isFinite(port) && port > 0 ? port : null };
  }
  if (!target && process.env.SQL_HOST) {
    const port = parseInt(process.env.SQL_PORT || '5439', 10);
    target = { host: process.env.SQL_HOST, port: Number.isFinite(port) ? port : null };
  }
  const position = Number(e.position);
  return {
    err,
    ctx,
    chain,
    message,
    text: errorText(err),
    sqlstate: sqlStateOf(err),
    netCode: netCodeOf(chain),
    syscall: str(socketField(chain, 'syscall')) ?? null,
    target,
    auth: (ctx.authMethod ?? process.env.SQL_AUTH_METHOD ?? 'direct').toLowerCase(),
    sslMode: process.env.SQL_SSL_MODE || 'require',
    db: {
      detail: str(e.detail),
      hint: str(e.hint),
      where: str(e.where),
      position: Number.isInteger(position) && position > 0 ? position : undefined,
    },
  };
}

function hostPort(t: ConnectTarget | null): string {
  if (!t) return 'the database server';
  return t.port ? `${t.host}:${t.port}` : t.host;
}

function portOf(t: ConnectTarget | null): string {
  return t?.port ? String(t.port) : 'the configured port';
}

function isConnectTimeoutMessage(message: string): boolean {
  return (
    message === 'timeout expired' ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('Connection terminated due to connection timeout')
  );
}

function isLost(f: Facts): boolean {
  if (f.netCode && LOST_CODES.has(f.netCode)) return true;
  return LOST_PHRASES.some((phrase) => f.message.includes(phrase));
}

// ---------------------------------------------------------------------------------------------
// Network wording
// ---------------------------------------------------------------------------------------------

interface AddressInfo {
  /** The first private (not loopback) address the host resolves to. */
  privateAddress: string | null;
  loopback: boolean;
}

function addressInfo(f: Facts, netFacts: NetworkFacts): AddressInfo {
  const host = f.target?.host ?? '';
  const list = netFacts.lookup?.ok ? netFacts.lookup.addresses.map((a) => a.address) : net.isIP(host) ? [host] : [];
  const privateAddress = list.find((a) => isPrivateAddress(a) && !isLoopbackAddress(a)) ?? null;
  return {
    privateAddress,
    loopback: isLoopbackHost(host) || (list.length > 0 && list.every(isLoopbackAddress)),
  };
}

/** "loopback", "private", "private and public" or "public". */
export function addressKind(addresses: string[]): string {
  if (addresses.length && addresses.every(isLoopbackAddress)) return 'loopback';
  if (addresses.length && addresses.every(isPrivateAddress)) return 'private';
  return addresses.some(isPrivateAddress) ? 'private and public' : 'public';
}

/** "The host name resolves to a private address (10.0.0.5)", or "10.0.0.5 is a private address" for an IP address. */
function privatePhrase(f: Facts, address: string): string {
  return f.target && net.isIP(f.target.host) ? `${address} is a private address` : `The host name resolves to a private address (${address})`;
}

function lookupPhrase(f: Facts, lookup?: LookupResult): string | null {
  const host = f.target?.host;
  if (!lookup || !host || net.isIP(host)) return null;
  if (!lookup.ok) return `the DNS lookup of ${host} failed (${lookup.code ?? lookup.message ?? 'no answer'})`;
  const list = lookup.addresses.map((a) => a.address);
  const shown = list.slice(0, 4).join(', ') + (list.length > 4 ? `, and ${list.length - 4} more` : '');
  return `the host name resolves to ${shown} (${addressKind(list)})`;
}

function probePhrase(probe?: ProbeResult): string | null {
  if (!probe) return null;
  const where = `${probe.address}:${probe.port}`;
  switch (probe.outcome) {
    case 'open':
      return `a TCP connection to ${where} succeeded in ${formatSeconds(probe.ms)}`;
    case 'timeout':
      return `a TCP connection to ${where} got no answer within ${formatSeconds(probe.timeoutMs)}`;
    case 'refused':
      return `a TCP connection to ${where} was refused`;
    case 'unreachable':
      return `a TCP connection to ${where} failed with no route to the host (${probe.code ?? 'unreachable'})`;
    case 'dns':
      return `${probe.address} could not be resolved (${probe.code ?? 'DNS error'})`;
    default:
      return `a TCP connection to ${where} failed (${probe.code ?? probe.message ?? 'error'})`;
  }
}

function attemptsPhrase(ctx: ErrorContext, byTimeout: boolean): string | null {
  const n = ctx.attempts;
  if (!n) return null;
  // A single quick attempt adds nothing.
  if (n === 1 && !byTimeout && (ctx.elapsedMs ?? 0) < 1_000) return null;
  const over = ctx.elapsedMs !== undefined ? ` over ${formatSeconds(ctx.elapsedMs)}` : '';
  const each =
    byTimeout && ctx.connectTimeoutMs
      ? `, ${n === 1 ? 'stopped' : 'each stopped'} by the ${formatSeconds(ctx.connectTimeoutMs)} connect timeout (SQL_CONNECT_TIMEOUT_MS)`
      : '';
  return `${n} connection attempt${n === 1 ? '' : 's'}${over}${each}`;
}

function checked(parts: Array<string | null>): string[] {
  const list = parts.filter((p): p is string => !!p);
  return list.length ? [`Checked: ${list.join('; ')}.`] : [];
}

/** The driver's own message, for diagnoses whose summary doesn't quote it. */
function driverLine(f: Facts): string[] {
  if (!f.text || f.text === 'timeout expired' || f.text.startsWith('Unknown error')) return [];
  return [`Driver message: ${clip(f.text, 500)}`];
}

// ---------------------------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------------------------

function secretNote(f: Facts, setting: string): string {
  return f.auth === 'secrets_manager' ? `${setting} (or the value in the Secrets Manager secret)` : setting;
}

function configDiagnosis(f: Facts): Diagnosis {
  const file = /SQL_SSL_(CA|CERT|KEY)/.test(f.text);
  return {
    type: 'config',
    summary: f.text,
    fix: file
      ? 'Point that setting at a readable file (or remove it), then restart or reconnect this MCP server.'
      : "Set it in this MCP server's env configuration (for example in mcp.json), then restart or reconnect the server.",
    lines: [],
  };
}

function credentialsDiagnosis(f: Facts): Diagnosis {
  const aws = f.ctx.aws;
  const service = aws?.service ?? (f.auth === 'secrets_manager' ? 'secretsmanager' : 'redshift');
  const region = aws?.region ?? process.env.SQL_AWS_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
  const api = service === 'redshift' ? 'redshift:GetClusterCredentials' : 'secretsmanager:GetSecretValue';
  const labels = f.chain.flatMap((e) => [str(e.name), str(e.code), str(e.Code)]).filter((x): x is string => !!x).join(' ');
  const messages = f.chain.map((e) => str(e.message) ?? '').join(' ');
  const has = (re: RegExp) => re.test(labels) || re.test(messages);
  const d = (cause: string, fix: string): Diagnosis => ({ type: 'aws_credentials', summary: f.text, cause, fix, lines: [] });

  if (has(/CredentialsProviderError|Could not load credentials|Unable to locate credentials|Token is expired.*sso|refresh failed/i)) {
    return d(
      `No usable AWS credentials were found for the ${api} call.`,
      'Give the server AWS credentials: set SQL_AWS_PROFILE to a profile in ~/.aws/config (or start the server with AWS credentials in its environment), sign in again if the profile uses SSO, then retry.',
    );
  }
  if (has(/ExpiredToken|RequestExpired|token (included in the request )?(is|has) expired|security token.*expired/i)) {
    return d(
      'The AWS credentials the server uses have expired.',
      'Refresh them (for example with aws sso login or your credential tool), then retry. The server loads fresh credentials on the next call.',
    );
  }
  if (has(/InvalidClientTokenId|UnrecognizedClient|SignatureDoesNotMatch|InvalidSignature|security token included in the request is invalid/i)) {
    return d(
      'The AWS credentials are not valid: the keys may be wrong or deleted, or belong to another AWS partition.',
      'Check SQL_AWS_PROFILE (or the AWS credentials in the environment), then retry.',
    );
  }
  if (has(/AccessDenied|UnauthorizedOperation|UnauthorizedAccess|not authorized to perform/i)) {
    return d(
      `The AWS identity is not allowed to call ${api} for this ${service === 'redshift' ? 'cluster and database user' : 'secret'}.`,
      `Grant ${api} on the resource named in the message to that role or user, or set SQL_AWS_PROFILE to a profile that has it.`,
    );
  }
  if (service === 'redshift' && has(/ClusterNotFound/i)) {
    return d(
      `There is no cluster ${quote(aws?.resource ?? process.env.SQL_CLUSTER_ID ?? '?')} in ${region}.`,
      'Check SQL_CLUSTER_ID (the cluster identifier, not the endpoint host name) and SQL_AWS_REGION, then retry.',
    );
  }
  if (service === 'secretsmanager' && has(/ResourceNotFoundException|can.t find the specified secret/i)) {
    return d(
      `The secret ${quote(aws?.resource ?? process.env.SQL_SECRET_ID ?? '?')} was not found in ${region}.`,
      'Check SQL_SECRET_ID and SQL_AWS_REGION, then retry.',
    );
  }
  if (netCodeOf(f.chain) || has(/TimeoutError|socket hang up|getaddrinfo|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ECONNRESET/i)) {
    return d(
      `The AWS API (${service} in ${region}) could not be reached: this machine may be offline, or a proxy or firewall blocks it.`,
      'Check the network connection (and any proxy settings), then retry.',
    );
  }
  if (service === 'secretsmanager' && has(/SyntaxError|Unexpected token|JSON|does not contain a string value/i)) {
    return d(
      'The secret value is not the JSON the server expects.',
      'Store it as JSON with username and password (and optionally host, port and dbname), then retry.',
    );
  }
  return d(`The ${api} call failed.`, 'Check the message above, the AWS credentials (SQL_AWS_PROFILE) and SQL_AWS_REGION, then retry.');
}

function dnsDiagnosis(f: Facts, code: string | null, extra: string[] = []): Diagnosis {
  const host = f.target?.host ?? 'the database host';
  const temporary = code === 'EAI_AGAIN' || code === 'ETIMEOUT';
  return {
    type: 'dns',
    summary: `Could not look up the database host ${quote(host)} in DNS (${code ?? 'lookup failed'}).`,
    cause: temporary
      ? 'The DNS server did not answer: this machine may be offline, or the VPN that provides this name is not connected.'
      : 'The host name does not exist in DNS. It may be misspelled, or it is a private name that only resolves on a VPN or corporate network.',
    fix: `Check ${secretNote(f, 'SQL_HOST')}. If it is a private endpoint, connect to the VPN, then retry.`,
    lines: [...extra, ...driverLine(f)],
  };
}

function refusedDiagnosis(f: Facts, netFacts: NetworkFacts, byTimeout = false): Diagnosis {
  const info = addressInfo(f, netFacts);
  const port = portOf(f.target);
  const lines = [
    ...checked([lookupPhrase(f, netFacts.lookup), probePhrase(netFacts.probe), attemptsPhrase(f.ctx, byTimeout)]),
    ...driverLine(f),
  ];
  if (info.loopback) {
    return {
      type: 'connection_refused',
      summary: `The database server at ${hostPort(f.target)} refused the connection (ECONNREFUSED).`,
      cause: 'Nothing is listening on that local port. If you reach the database through an SSH tunnel or a local proxy, it is not running.',
      fix: 'Start the SSH tunnel (or the local proxy or database), then retry.',
      lines,
    };
  }
  return {
    type: 'connection_refused',
    summary: `The database server at ${hostPort(f.target)} refused the connection (ECONNREFUSED).`,
    cause: `Nothing is accepting connections on port ${port} at that address. The port may be wrong (Redshift usually uses 5439 and PostgreSQL 5432), the database may be stopped, or a firewall rejected the connection.`,
    fix: `Check ${secretNote(f, 'SQL_HOST and SQL_PORT')} and that the database is running, then retry.`,
    lines,
  };
}

function unreachableDiagnosis(f: Facts, netFacts: NetworkFacts, code: string, byTimeout = false): Diagnosis {
  const info = addressInfo(f, netFacts);
  const lines = [
    ...checked([lookupPhrase(f, netFacts.lookup), probePhrase(netFacts.probe), attemptsPhrase(f.ctx, byTimeout)]),
    ...driverLine(f),
  ];
  return {
    type: 'network_unreachable',
    summary: `Could not reach the database server at ${hostPort(f.target)}: there is no network route to it (${code}).`,
    cause: info.privateAddress
      ? `${privatePhrase(f, info.privateAddress)} that this machine has no route to, so the VPN or tunnel that provides it is not connected.`
      : 'This machine has no working network path to the server: it may be offline, or a VPN or routing problem is in the way.',
    fix: info.privateAddress
      ? 'Connect to the VPN (or start the SSH tunnel), then retry.'
      : 'Check the network connection (and the VPN, if the database needs one), then retry.',
    lines,
  };
}

function timeoutDiagnosis(f: Facts, netFacts: NetworkFacts, byTimeout: boolean): Diagnosis {
  const info = addressInfo(f, netFacts);
  const port = portOf(f.target);
  const lines = [
    ...checked([lookupPhrase(f, netFacts.lookup), probePhrase(netFacts.probe), attemptsPhrase(f.ctx, byTimeout)]),
    ...driverLine(f),
  ];
  if (info.loopback) {
    return {
      type: 'network_timeout',
      summary: `Could not reach the database server at ${hostPort(f.target)}: the connection attempt timed out.`,
      cause: 'The local port did not answer. An SSH tunnel or local proxy may be stuck, or its remote side is unreachable.',
      fix: 'Restart the SSH tunnel (or the local proxy), then retry.',
      lines,
    };
  }
  if (info.privateAddress) {
    return {
      type: 'network_timeout',
      summary: `Could not reach the database server at ${hostPort(f.target)}: the connection attempt timed out.`,
      cause: `${privatePhrase(f, info.privateAddress)}, which is only reachable through a VPN, a peered network or an SSH tunnel, and that path is not working.`,
      fix: 'Connect to the VPN (or start the SSH tunnel), then retry.',
      lines,
    };
  }
  return {
    type: 'network_timeout',
    summary: `Could not reach the database server at ${hostPort(f.target)}: the connection attempt timed out.`,
    cause: 'The server did not answer. A firewall or security group may be blocking this machine, the server may be down, or it may only be reachable from a VPN or another network.',
    fix: `Check that the server is running and that its firewall or security group allows this machine on port ${port} (or connect to the VPN if the database needs one), then retry.`,
    lines,
  };
}

function loginTimeoutDiagnosis(f: Facts, netFacts: NetworkFacts): Diagnosis {
  const timeout = f.ctx.connectTimeoutMs;
  return {
    type: 'connect_timeout',
    summary: `The database server at ${hostPort(f.target)} accepted the network connection but did not finish the login${timeout ? ` within ${formatSeconds(timeout)}` : ' in time'}.`,
    cause: 'The server may be overloaded, starting up or paused, the SSL settings may not match what it expects, or the port may belong to a service that is not PostgreSQL or Redshift.',
    fix: `Retry in a minute. If it keeps happening, check the server's status and SQL_SSL_MODE, or raise SQL_CONNECT_TIMEOUT_MS${timeout ? ` (now ${timeout} ms)` : ''}.`,
    lines: checked([lookupPhrase(f, netFacts.lookup), probePhrase(netFacts.probe), attemptsPhrase(f.ctx, true)]),
  };
}

function genericConnectTimeout(f: Facts, netFacts: NetworkFacts): Diagnosis {
  const timeout = f.ctx.connectTimeoutMs;
  return {
    type: 'connect_timeout',
    summary: `Connecting to the database server at ${hostPort(f.target)} timed out${timeout ? ` after ${formatSeconds(timeout)}` : ''}.`,
    cause: 'The server did not answer in time: the network or VPN may be down, or the server may be overloaded.',
    fix: 'Check the network and VPN, then retry. connection_status checks each step.',
    lines: checked([lookupPhrase(f, netFacts.lookup), probePhrase(netFacts.probe), attemptsPhrase(f.ctx, true)]),
  };
}

/** pg reports only "timeout expired" when its connect timeout fires: the lookup and TCP check tell why. */
function connectTimeoutDiagnosis(f: Facts, netFacts: NetworkFacts): Diagnosis {
  if (netFacts.lookup && !netFacts.lookup.ok) {
    return dnsDiagnosis(f, netFacts.lookup.code ?? null, checked([lookupPhrase(f, netFacts.lookup), attemptsPhrase(f.ctx, true)]));
  }
  switch (netFacts.probe?.outcome) {
    case 'timeout':
      return timeoutDiagnosis(f, netFacts, true);
    case 'refused':
      return refusedDiagnosis(f, netFacts, true);
    case 'unreachable':
      return unreachableDiagnosis(f, netFacts, netFacts.probe.code ?? 'EHOSTUNREACH', true);
    case 'open':
      return loginTimeoutDiagnosis(f, netFacts);
    default:
      return genericConnectTimeout(f, netFacts);
  }
}

function closedDuringLogin(f: Facts): Diagnosis {
  return {
    type: 'server_unavailable',
    summary: `The database server at ${hostPort(f.target)} closed the connection during the login (${f.text}).`,
    cause: 'The server may be paused, restarting or overloaded, it may require different SSL settings, or the port may belong to a service that is not PostgreSQL or Redshift.',
    fix: 'Retry in a minute. If it persists, check the server status and SQL_SSL_MODE.',
    lines: checked([attemptsPhrase(f.ctx, false)]),
  };
}

function tlsDiagnosis(f: Facts): Diagnosis | null {
  const codes = f.chain.map((e) => str(e.code)).filter((c): c is string => !!c);
  const code = codes.find((c) => TLS_CODES.has(c) || c.startsWith('ERR_TLS_') || c.startsWith('ERR_SSL_')) ?? null;
  if (f.message === 'The server does not support SSL connections') {
    return {
      type: 'tls',
      summary: 'The database server does not accept SSL connections.',
      cause: `SQL_SSL_MODE is ${f.sslMode}${process.env.SQL_SSL_MODE ? '' : ' (the default)'}, but SSL is turned off on the server.`,
      fix: 'Set SQL_SSL_MODE=disable if the network is trusted (the connection will not be encrypted), or turn on SSL on the server.',
      lines: [],
    };
  }
  const certificate = code && (TLS_CODES.has(code) || code.startsWith('ERR_TLS_CERT'));
  if (certificate || /certificate/i.test(f.message)) {
    const altname = code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /does not match certificate|altnames/i.test(f.message);
    const dates = code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID';
    const verifying = f.sslMode.startsWith('verify');
    const orRequire = verifying ? ', or use SQL_SSL_MODE=require to encrypt without verifying the certificate' : '';
    return {
      type: 'tls',
      summary: `The server's SSL certificate could not be verified: ${f.text}${code && !f.text.includes(code) ? ` (${code})` : ''}.`,
      cause: altname
        ? `The certificate is not issued for ${f.target?.host ?? 'this host name'}, which happens when connecting through a VPC endpoint, proxy or tunnel.`
        : dates
          ? "The certificate has expired or is not valid yet (check this machine's clock too)."
          : verifying
            ? `SQL_SSL_MODE=${f.sslMode} verifies the certificate, but it is not signed by a certificate authority this server trusts.`
            : 'The certificate is not signed by a certificate authority this server trusts.',
      fix: altname
        ? `Connect with the host name on the certificate${orRequire}.`
        : `Set SQL_SSL_CA to the certificate authority bundle for this server (for Amazon Redshift, the Redshift CA bundle)${orRequire}.`,
      lines: [],
    };
  }
  const handshake = /\bSSL\b|\bTLS\b|handshake/i.test(f.message);
  if (code || f.message === 'There was an error establishing an SSL connection' || handshake) {
    return {
      type: 'tls',
      summary: `The SSL handshake with the database server failed: ${f.text}.`,
      cause: "The server's SSL setup and this server's SSL settings do not match.",
      fix: 'Check SQL_SSL_MODE and the certificate settings (SQL_SSL_CA, SQL_SSL_CERT, SQL_SSL_KEY), then retry.',
      lines: [],
    };
  }
  return null;
}

function dbLines(f: Facts): string[] {
  const lines: string[] = [];
  if (f.db.detail) {
    const rows = clip(f.db.detail.trim(), 1_500)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^-{5,}$/.test(l));
    if (rows.length === 1) lines.push(`Detail: ${rows[0]}`);
    else if (rows.length > 1) lines.push('Detail:', ...rows.map((r) => `  ${r}`));
  }
  if (f.db.hint) lines.push(`Hint: ${clip(f.db.hint.trim(), 500)}`);
  if (f.db.where) lines.push(`Where: ${clip(f.db.where.replace(/\s*\n\s*/g, '; ').trim(), 500)}`);
  const at = f.db.position && f.ctx.statement && f.ctx.sql ? locate(f.ctx.sql, f.ctx.statement, f.db.position) : null;
  if (at) lines.push(`At line ${at.line}, column ${at.column}:`, `  ${at.snippet}`, `  ${' '.repeat(at.caret)}^`);
  return lines;
}

/**
 * Maps a database error position (1-based, counted in characters of the text that was sent) to a
 * line and column of the caller's SQL, with that line (windowed when long) and a caret offset.
 */
export function locate(
  sql: string,
  statement: StatementRef,
  position: number,
): { line: number; column: number; snippet: string; caret: number } | null {
  const chars = position - 1 - statement.shift;
  if (!Number.isInteger(chars) || chars < 0) return null;
  let unit = 0;
  for (let i = 0; i < chars; i++) {
    if (unit >= statement.text.length) return null;
    unit += (statement.text.codePointAt(unit) as number) > 0xffff ? 2 : 1;
  }
  const absolute = statement.offset + unit;
  if (absolute > sql.length || sql.slice(statement.offset, statement.offset + statement.text.length) !== statement.text) return null;
  const lineStart = absolute === 0 ? 0 : sql.lastIndexOf('\n', absolute - 1) + 1;
  let lineEnd = sql.indexOf('\n', absolute);
  if (lineEnd === -1) lineEnd = sql.length;
  let line = 1;
  for (let i = 0; i < lineStart; i++) if (sql.charCodeAt(i) === 10) line++;
  const points = Array.from(maskSecrets(sql.slice(lineStart, lineEnd).replace(/\r$/, '').replace(/\t/g, ' ')));
  const before = Array.from(sql.slice(lineStart, absolute)).length;
  const width = 100;
  let from = 0;
  let to = points.length;
  if (points.length > width) {
    from = Math.max(0, Math.min(before - width / 2, points.length - width));
    to = Math.min(points.length, from + width);
  }
  const snippet = `${from > 0 ? '…' : ''}${points.slice(from, to).join('')}${to < points.length ? '…' : ''}`;
  return { line, column: before + 1, snippet, caret: before - from + (from > 0 ? 1 : 0) };
}

function sqlDiagnosis(f: Facts, code: string): Diagnosis {
  const lines = dbLines(f);
  const hasPosition = lines.some((l) => l.startsWith('At line '));
  let fix: string | undefined = SQL_FIXES[code];
  if (code === '42601' && hasPosition) fix = 'Correct the SQL at the position shown.';
  if (/not supported on Redshift tables/i.test(f.message)) {
    fix = 'Some functions and types (for example generate_series and other leader-node-only functions) cannot be used with Redshift table data; rewrite the query without them.';
  }
  return { type: 'sql_error', summary: f.text, fix, lines, sqlstate: sqlStateLabel(code) };
}

function serverTimeoutDiagnosis(f: Facts, code: string): Diagnosis {
  const wlm = /\bWLM\b|query monitoring rule/i.test(f.message);
  const statementTimeout = /statement timeout/i.test(f.message);
  const userRequest = /user request|user's request/i.test(f.message);
  return {
    type: 'server_timeout',
    summary: f.text,
    cause: wlm
      ? 'A Redshift WLM query monitoring rule cancelled the query.'
      : statementTimeout
        ? "The query ran longer than the database's statement_timeout."
        : userRequest
          ? 'The query was cancelled on the database side (pg_cancel_backend, the console or an administrator).'
          : 'The database cancelled the query.',
    fix: userRequest
      ? 'Run it again if the cancellation was not intended.'
      : 'Make the query cheaper (filter on sort or distribution keys, aggregate, add a LIMIT) or split it, or ask the administrator about the limit. timeoutMs cannot extend a limit set on the database.',
    lines: dbLines(f),
    sqlstate: sqlStateLabel(code),
  };
}

function authDiagnosis(f: Facts, code: string): Diagnosis {
  const password = code === '28P01' || /password authentication failed/i.test(f.message);
  const sqlstate = sqlStateLabel(code);
  if (!password) {
    return {
      type: 'auth',
      summary: `Login was refused: ${f.text}`,
      cause: 'The server does not allow this user to connect from this machine or to this database.',
      fix: `Ask the database administrator to allow the login, or check ${secretNote(f, 'SQL_USER and SQL_DATABASE')}.`,
      lines: dbLines(f),
      sqlstate,
    };
  }
  const byAuth: Record<string, [string, string]> = {
    iam: [
      'The temporary credentials from GetClusterCredentials were rejected. The database user in SQL_USER may not exist (it is not created automatically), or it may not be allowed to log in.',
      'Check that SQL_USER exists in the cluster and can log in, then retry.',
    ],
    secrets_manager: [
      'The username or password in the Secrets Manager secret is wrong or out of date, for example after a password rotation.',
      'Update the secret (or point SQL_SECRET_ID at the right one), then retry.',
    ],
    direct: [
      'SQL_USER or SQL_PASSWORD is wrong, or the user does not exist.',
      "Correct SQL_USER and SQL_PASSWORD in this MCP server's configuration, then restart or reconnect it.",
    ],
  };
  const [cause, fix] = byAuth[f.auth] ?? byAuth.direct;
  return { type: 'auth', summary: `Login failed: ${f.text}`, cause, fix, lines: dbLines(f), sqlstate };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

interface Plan {
  lookup: boolean;
  probe: boolean;
  build(netFacts: NetworkFacts): Diagnosis;
}

function fixed(d: Diagnosis): Plan {
  return { lookup: false, probe: false, build: () => d };
}

function connectionLostDiagnosis(f: Facts, netFacts: NetworkFacts, sessionEnded: boolean): Diagnosis {
  const during =
    f.ctx.operation === 'fetch_rows' ? 'while reading rows' : f.ctx.operation === 'export_query' ? 'while exporting' : 'while the SQL was running';
  const info = addressInfo(f, netFacts);
  const probe = netFacts.probe;
  const lookupFailed = netFacts.lookup !== undefined && !netFacts.lookup.ok;
  const reachable = probe?.outcome === 'open';
  const refused = probe?.outcome === 'refused';
  const unreachable = lookupFailed || (probe !== undefined && !reachable && !refused);
  const inflight = f.ctx.statement?.text ?? f.ctx.sql ?? '';
  const changes = inflight ? mayChangeData(inflight) : false;
  const completedChanges = (f.ctx.completed ?? []).some(mayChangeData);
  const again = f.ctx.resultClosed ? 'run the query again with run_query (this result cannot be continued)' : 'run it again';
  const next = f.ctx.resultClosed
    ? again
    : completedChanges
      ? 'run only the statements that had not completed (the earlier ones already took effect)'
      : changes
        ? 'check whether the statement took effect before running it again'
        : again;

  let cause: string;
  let fix: string;
  if (sessionEnded) {
    cause = 'An administrator ended the session, or the server is shutting down or restarting.';
    fix = `Wait a minute, then ${next}.`;
  } else if (unreachable) {
    const why = lookupFailed ? lookupPhrase(f, netFacts.lookup) : probePhrase(probe);
    cause = `The database is not reachable now (${why}), so the network or VPN connection dropped.${
      info.privateAddress ? ` ${privatePhrase(f, info.privateAddress)}, reachable only through the VPN or a tunnel.` : ''
    }`;
    fix = `Reconnect the VPN or network, then ${next}.`;
  } else if (refused) {
    cause = `The database is not accepting connections now (${probePhrase(probe)}), so the server may be restarting or stopped.`;
    fix = `Wait until the database is back, then ${next}.`;
  } else if (reachable) {
    cause = 'The network dropped briefly (for example a VPN reconnect or a Wi-Fi change), or the server ended the session (a restart, an idle timeout, a WLM rule or an administrator).';
    fix = `${next.charAt(0).toUpperCase()}${next.slice(1)}.`;
  } else {
    cause = 'The network or VPN dropped, or the server ended the session (a restart, an idle timeout, a WLM rule or an administrator).';
    fix = `Check the network and VPN, then ${next}. connection_status checks each step.`;
  }
  return {
    type: 'connection_lost',
    summary: sessionEnded ? `The database ended the session ${during}: ${f.text}` : `Lost the connection to the database ${during} (${f.text}).`,
    cause,
    fix,
    lines: sessionEnded ? dbLines(f) : reachable ? [`Checked: the database is reachable now (${probePhrase(probe)}).`] : [],
    sqlstate: f.sqlstate ? sqlStateLabel(f.sqlstate) : undefined,
  };
}

function sqlStatePlan(f: Facts, code: string): Plan {
  const connect = f.ctx.phase === 'connect';
  if (code.startsWith('28')) {
    if (code === '28000' && /\bSSL off\b/i.test(f.message)) {
      return fixed({
        type: 'tls',
        summary: f.text,
        cause: `The server only accepts SSL connections, but SQL_SSL_MODE=${f.sslMode}.`,
        fix: 'Set SQL_SSL_MODE=require (or verify-full with SQL_SSL_CA), then restart or reconnect this MCP server.',
        lines: dbLines(f),
        sqlstate: sqlStateLabel(code),
      });
    }
    return fixed(authDiagnosis(f, code));
  }
  if (code === '3D000') {
    return fixed({
      type: 'database_not_found',
      summary: f.text,
      cause: `${secretNote(f, 'SQL_DATABASE')} names a database that does not exist on this server.`,
      fix: 'Set SQL_DATABASE to an existing database (a new Redshift cluster has one named dev), then restart or reconnect this MCP server.',
      lines: dbLines(f),
      sqlstate: sqlStateLabel(code),
    });
  }
  if (code === '53300') {
    return fixed({
      type: 'too_many_connections',
      summary: f.text,
      cause: 'The server has reached its connection limit for this user or database.',
      fix: 'Close idle sessions (other tools or notebooks), lower SQL_POOL_MAX, or ask the administrator to raise the limit, then retry.',
      lines: dbLines(f),
      sqlstate: sqlStateLabel(code),
    });
  }
  if (code === '57P03') {
    return fixed({
      type: 'server_unavailable',
      summary: f.text,
      cause: 'The database is starting up, shutting down or recovering. A Redshift cluster may be paused, resizing or rebooting.',
      fix: 'Wait a minute and retry. If it persists, check the cluster or server status.',
      lines: dbLines(f),
      sqlstate: sqlStateLabel(code),
    });
  }
  if (code === '57P01' || code === '57P02' || code.startsWith('08')) {
    if (connect) return fixed({ ...closedDuringLogin(f), sqlstate: sqlStateLabel(code) });
    const ended = code === '57P01' || code === '57P02';
    return { lookup: !ended, probe: !ended, build: (n) => connectionLostDiagnosis(f, n, ended) };
  }
  if (connect) {
    return fixed({ ...authDiagnosis(f, code), summary: `Login was rejected: ${f.text}` });
  }
  if (code === '42501') {
    const user = f.auth === 'secrets_manager' ? undefined : process.env.SQL_USER;
    return fixed({
      type: 'permission_denied',
      summary: f.text,
      cause: `The database user${user ? ` ${quote(user)}` : ''} does not have the privilege this statement needs.`,
      fix: 'Rewriting the SQL will not help. Query objects this user can read, or ask the database administrator to grant access.',
      lines: dbLines(f),
      sqlstate: sqlStateLabel(code),
    });
  }
  if (code === '57014') return fixed(serverTimeoutDiagnosis(f, code));
  return fixed(sqlDiagnosis(f, code));
}

function planFor(f: Facts): Plan | null {
  const { ctx } = f;
  if (ctx.phase === 'config') return fixed(configDiagnosis(f));
  if (ctx.phase === 'credentials') return fixed(credentialsDiagnosis(f));
  if (f.sqlstate) return sqlStatePlan(f, f.sqlstate);
  // Network wording only applies to errors that came through a database connection. Others (for
  // example file errors while writing an export) are shown as they are.
  if (ctx.phase !== 'connect' && ctx.phase !== 'query') return null;
  const tls = ctx.phase === 'connect' ? tlsDiagnosis(f) : null;
  if (tls) return fixed(tls);

  const code = f.netCode;
  if (code && DNS_CODES.has(code)) return fixed(dnsDiagnosis(f, code));
  // A pool replaced after another query lost its connection: not a login problem.
  if (f.message.includes('Cannot use a pool after calling end')) {
    return { lookup: true, probe: true, build: (n) => connectionLostDiagnosis(f, n, false) };
  }
  const connect =
    ctx.phase === 'connect' ||
    f.syscall === 'connect' ||
    isConnectTimeoutMessage(f.message) ||
    // Node reports every address it tried in an AggregateError, which only happens while connecting.
    (f.chain[0]?.name === 'AggregateError' && !!code);
  if (connect) {
    if (code === 'ECONNREFUSED') return { lookup: true, probe: false, build: (n) => refusedDiagnosis(f, n) };
    if (code && UNREACHABLE_CODES.has(code)) return { lookup: true, probe: false, build: (n) => unreachableDiagnosis(f, n, code) };
    if (code === 'ETIMEDOUT') return { lookup: true, probe: false, build: (n) => timeoutDiagnosis(f, n, false) };
    if (isConnectTimeoutMessage(f.message)) return { lookup: true, probe: true, build: (n) => connectTimeoutDiagnosis(f, n) };
    if (isLost(f)) return fixed(closedDuringLogin(f));
    return null;
  }
  if (isLost(f)) return { lookup: true, probe: true, build: (n) => connectionLostDiagnosis(f, n, false) };
  return null;
}

async function gather(f: Facts, plan: Plan, opts: DescribeOptions): Promise<NetworkFacts> {
  const facts: NetworkFacts = { ...(opts.network ?? {}) };
  const host = f.target?.host;
  if (opts.checks === false || !host || host.startsWith('/') || (!plan.lookup && !plan.probe)) return facts;
  if (!facts.lookup) facts.lookup = await lookupHost(host, 2_000);
  if (plan.probe && !facts.probe && facts.lookup.ok && f.target?.port) {
    facts.probe = await probeTcp(facts.lookup.addresses[0].address, f.target.port, opts.probeTimeoutMs ?? 3_000);
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------
// What happened to the SQL
// ---------------------------------------------------------------------------------------------

function listSummaries(items: string[]): string {
  const shown = items.slice(0, 8).join(', ');
  return items.length > 8 ? `${shown} and ${items.length - 8} more` : shown;
}

export function statusSentence(type: ErrorType, ctx: ErrorContext): string | null {
  const sent = ctx.sentCount ?? 0;
  const completed = ctx.completed ?? [];
  const statement = ctx.statement;
  const inflight = statement?.text ?? ctx.sql ?? '';
  const changes = inflight ? mayChangeData(inflight) : false;
  const count = ctx.statementCount ?? 0;
  const numbered = statement?.index && count > 1 ? `Statement ${statement.index} of ${count}` : null;
  const before = completed.length ? `The statements before it had completed: ${listSummaries(completed)}.` : null;

  if (NO_SQL_TYPES.has(type)) {
    if (sent > 0) {
      return `The SQL was sent on an earlier attempt, before the connection was lost, so it may or may not have completed${
        changes ? '; check before re-running statements that change data' : ''
      }.`;
    }
    return 'No SQL was run.';
  }
  if (ctx.resultClosed) return 'This result was closed.';
  if (!ctx.sql) return null;

  if (type === 'connection_lost') {
    if (sent === 0 && !completed.length) return 'No SQL was run.';
    const parts: string[] = [];
    if (statement && statement.index === null && ctx.isScript) {
      parts.push(`The text was sent as one request, so its statements may or may not have completed${changes ? '; check before re-running statements that change data' : ''}.`);
    } else if (numbered) {
      parts.push(`${numbered} was running when the connection was lost${changes ? ' and may or may not have completed' : ''}.`);
    } else if (changes) {
      parts.push('The statement may or may not have completed; check before re-running it.');
    }
    if (before) parts.push(before, 'It was not retried, because a retry would run them again.');
    return parts.length ? parts.join(' ') : null;
  }

  if (statement && statement.index === null && ctx.isScript) {
    return 'The text was sent as one request, so statements before the failing one may have taken effect.';
  }
  if (numbered && statement?.index) {
    const after = statement.index < count ? '; the statements after it did not run' : '';
    return [`${numbered} failed and made no changes${after}.`, before].filter(Boolean).join(' ');
  }
  return changes ? 'The statement made no changes.' : null;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export interface DescribeOptions {
  /** Network facts already gathered (connection_status), so they aren't checked twice. */
  network?: NetworkFacts;
  /** false: don't run DNS or TCP checks. */
  checks?: boolean;
  probeTimeoutMs?: number;
}

/** The server's own errors, whose one-line message is already specific. */
export function isClearError(err: unknown): boolean {
  const name = (err as Loose | null)?.name;
  return typeof name === 'string' && CLEAR_ERRORS.has(name);
}

/** Diagnoses an error, or returns null when it isn't one the server can explain. */
export async function diagnose(err: unknown, opts: DescribeOptions = {}): Promise<Diagnosis | null> {
  if (isClearError(err)) return null;
  const f = factsOf(err);
  const plan = planFor(f);
  if (!plan) return null;
  const netFacts = await gather(f, plan, opts);
  return plan.build(netFacts);
}

export function renderDiagnosis(d: Diagnosis, opts: { prefix?: string; status?: string | null; before?: string[] } = {}): string {
  const lines = [`${opts.prefix ?? 'Error'}: ${d.summary}`];
  if (d.cause) lines.push(`Likely cause: ${d.cause}`);
  if (d.fix) lines.push(`To fix: ${d.fix}`);
  lines.push(...d.lines, ...(opts.before ?? []));
  const type = d.sqlstate ? `${d.type} (${d.sqlstate})` : d.type;
  lines.push(`Error type: ${type}.${opts.status ? ` ${opts.status}` : ''}`);
  return lines.join('\n');
}

/**
 * The tool error text for any thrown value. Never throws and is never blank. May take a few
 * seconds for connection failures (a DNS lookup and a short TCP check).
 */
export async function describeError(err: unknown, opts: DescribeOptions = {}): Promise<RenderedError> {
  try {
    const d = await diagnose(err, opts);
    if (!d) return { type: null, text: `Error: ${errorText(err)}` };
    return { type: d.type, text: renderDiagnosis(d, { status: statusSentence(d.type, contextOf(err)) }) };
  } catch {
    return { type: null, text: `Error: ${errorText(err)}` };
  }
}
