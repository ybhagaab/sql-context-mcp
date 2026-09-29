/**
 * Network checks used to explain connection failures: a DNS lookup and a plain TCP connection
 * to the database port, each with a short time limit. Neither sends anything to the database.
 */
import * as dns from 'dns';
import * as net from 'net';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface LookupResult {
  ok: boolean;
  addresses: ResolvedAddress[];
  code?: string;
  message?: string;
  ms: number;
}

export type ProbeOutcome = 'open' | 'timeout' | 'refused' | 'unreachable' | 'dns' | 'error';

export interface ProbeResult {
  outcome: ProbeOutcome;
  /** The address that was tried. */
  address: string;
  port: number;
  timeoutMs: number;
  code?: string;
  message?: string;
  ms: number;
}

interface NetworkImpl {
  lookup(host: string): Promise<ResolvedAddress[]>;
  probe(address: string, port: number, timeoutMs: number): Promise<Omit<ProbeResult, 'ms'> & { ms?: number }>;
}

const REFUSED = new Set(['ECONNREFUSED']);
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EHOSTDOWN']);
const DNS_FAILURES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);

function outcomeOfCode(code: string | undefined): ProbeOutcome {
  if (!code) return 'error';
  if (REFUSED.has(code)) return 'refused';
  if (UNREACHABLE.has(code)) return 'unreachable';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (DNS_FAILURES.has(code)) return 'dns';
  return 'error';
}

const defaultImpl: NetworkImpl = {
  async lookup(host) {
    const found = await dns.promises.lookup(host, { all: true });
    return found.map((a) => ({ address: a.address, family: a.family }));
  },
  probe(address, port, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const socket = net.connect({ host: address, port });
      const finish = (result: Omit<ProbeResult, 'address' | 'port' | 'timeoutMs' | 'ms'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ ...result, address, port, timeoutMs });
      };
      const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      socket.once('connect', () => finish({ outcome: 'open' }));
      // A persistent listener: a socket may report more than one error, and an unhandled one would crash the process.
      socket.on('error', (err: NodeJS.ErrnoException) => {
        finish({ outcome: outcomeOfCode(err.code), code: err.code, message: err.message });
      });
    });
  },
};

let impl: NetworkImpl = defaultImpl;

/** Test seam: replaces the lookup and/or the probe (null restores the real ones). */
export function __setNetworkForTests(stub: Partial<NetworkImpl> | null): void {
  impl = stub ? { ...defaultImpl, ...stub } : defaultImpl;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
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

/** Resolves `host` the way the driver does (getaddrinfo), within `timeoutMs`. Never throws. */
export async function lookupHost(host: string, timeoutMs = 2_000): Promise<LookupResult> {
  const started = Date.now();
  const family = net.isIP(host);
  if (family) return { ok: true, addresses: [{ address: host, family }], ms: 0 };
  try {
    const addresses = await withTimeout(impl.lookup(host), timeoutMs, () =>
      Object.assign(new Error(`the DNS lookup did not finish within ${timeoutMs} ms`), { code: 'ETIMEOUT' }),
    );
    if (addresses.length === 0) return { ok: false, addresses, code: 'ENOTFOUND', message: 'no addresses', ms: Date.now() - started };
    return { ok: true, addresses, ms: Date.now() - started };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, addresses: [], code: e?.code, message: e?.message, ms: Date.now() - started };
  }
}

/** Opens (and immediately closes) a TCP connection to `address:port`, within `timeoutMs`. Never throws. */
export async function probeTcp(address: string, port: number, timeoutMs = 3_000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const result = await impl.probe(address, port, timeoutMs);
    return { ...result, ms: result.ms ?? Date.now() - started };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { outcome: outcomeOfCode(e?.code), address, port, timeoutMs, code: e?.code, message: e?.message, ms: Date.now() - started };
  }
}

function ipv4Of(ip: string): string | null {
  if (net.isIPv4(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : null;
}

export function isLoopbackAddress(ip: string): boolean {
  const v4 = ipv4Of(ip);
  if (v4) return v4.startsWith('127.');
  return ip === '::1';
}

/**
 * True for addresses that are only reachable from inside a private network: RFC 1918, shared
 * address space (100.64/10, used by carrier NAT and some VPNs), link-local, loopback, and IPv6
 * unique-local and link-local addresses.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Of(ip);
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      a === 127
    );
  }
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
}

export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost') || isLoopbackAddress(lower);
}
