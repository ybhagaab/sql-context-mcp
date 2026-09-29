/**
 * Connection leases (design Component 4).
 *
 * A lease wraps one checked-out pooled connection for the duration of a unit of work. It:
 * - acquires with abort support (an abort while waiting releases the connection on arrival);
 * - tracks the transaction status from ReadyForQuery messages ('I' idle, 'T' in transaction,
 *   'E' failed transaction);
 * - destroys the connection on release when it ran a script or a session-changing statement, is
 *   inside a transaction, or failed at the connection level, so session state never leaks;
 * - cancels the running query on abort or timeout with a protocol-level CancelRequest on a
 *   separate socket (no pool slot needed), falling back to pg_cancel_backend(pid).
 */
import { Client, Pool, PoolClient } from 'pg';
import { getLastConnectionConfig, connectTimeoutMs } from './pool';
import { annotate } from '../errors/context';

/** Errors while getting a pooled connection happen before any SQL is sent. */
function connectPhase(err: unknown, pool: Pool): unknown {
  if (err instanceof QueryCancelledError) return err;
  const options = (pool as unknown as { options?: { host?: unknown; port?: unknown } }).options;
  const config = getLastConnectionConfig();
  const host = typeof options?.host === 'string' ? options.host : config?.host;
  const port = Number(options?.port ?? config?.port) || null;
  return annotate(err, { phase: 'connect', target: host ? { host, port } : undefined });
}

export class QueryCancelledError extends Error {
  constructor(public readonly cause?: unknown) {
    super('The query was cancelled.');
    this.name = 'QueryCancelledError';
  }
}

export class QueryTimeoutError extends Error {
  constructor(public readonly timeoutMs: number, public readonly cause?: unknown) {
    super(`The query exceeded timeoutMs=${timeoutMs} and was cancelled.`);
    this.name = 'QueryTimeoutError';
  }
}

export type QueryInput = string | { text: string; values?: unknown[]; rowMode?: 'array'; types?: unknown };

export interface GuardOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

interface ClientInternals {
  processID: number;
  secretKey: number;
  activeQuery?: unknown;
  _getActiveQuery?: () => unknown;
}

/** The query running on `client`, without pg 8.20's deprecated `activeQuery` getter where possible. */
function activeQueryOf(client: unknown): unknown {
  const c = client as ClientInternals;
  return typeof c._getActiveQuery === 'function' ? c._getActiveQuery() : c.activeQuery;
}

interface CancelConnection {
  connect: (portOrPath: number | string, host?: string) => void;
  cancel: (processID: number, secretKey: number) => void;
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  once: (event: string, fn: (...args: unknown[]) => void) => void;
  stream?: { destroy?: () => void };
}

/**
 * Sends a protocol-level CancelRequest for `target` on a new socket, the way pg's Client#cancel
 * does (which reads the deprecated `activeQuery` getter). Returns false when the driver doesn't
 * expose a connection that can do it, so the caller can fall back to Client#cancel.
 */
function sendCancelRequest(config: Record<string, unknown>, target: ClientInternals): boolean {
  const canceller = new Client(config) as unknown as { connection?: Partial<CancelConnection> };
  const con = canceller.connection;
  if (!con || typeof con.connect !== 'function' || typeof con.cancel !== 'function' || typeof con.once !== 'function') return false;
  const connection = con as CancelConnection;
  connection.on('error', () => undefined);
  connection.once('connect', () => {
    try {
      connection.cancel(target.processID, target.secretKey);
    } catch {
      // ignore
    }
  });
  const host = typeof config.host === 'string' && config.host ? config.host : 'localhost';
  const port = Number(config.port ?? 5432);
  if (host.startsWith('/')) connection.connect(`${host}/.s.PGSQL.${port}`);
  else connection.connect(port, host);
  // The server closes the socket after reading the request; make sure it never lingers.
  const cleanup = setTimeout(() => connection.stream?.destroy?.(), 10_000);
  (cleanup as { unref?: () => void }).unref?.();
  return true;
}

export class Lease {
  /** How long to wait after a protocol cancel before falling back to pg_cancel_backend. */
  static cancelGraceMs = 3_000;

  private txStatus = 'I';
  private discard = false;
  private released = false;
  private activeOp: Promise<void> | null = null;
  private readonly onReady: (msg: { status?: unknown }) => void;

  private constructor(readonly client: PoolClient) {
    this.onReady = (msg) => {
      if (msg && typeof msg.status === 'string') this.txStatus = msg.status;
    };
    (client as unknown as { connection?: NodeJS.EventEmitter }).connection?.on?.('readyForQuery', this.onReady);
  }

  static async acquire(pool: Pool, opts: { signal?: AbortSignal } = {}): Promise<Lease> {
    const { signal } = opts;
    if (signal?.aborted) throw new QueryCancelledError();
    const pending = pool.connect().catch((err: unknown) => {
      throw connectPhase(err, pool);
    });
    if (!signal) return new Lease(await pending);
    const client = await new Promise<PoolClient>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        pending.then((c) => c.release(), () => undefined);
        reject(new QueryCancelledError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (c) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(c);
        },
        (err) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
    return new Lease(client);
  }

  get processID(): number {
    return (this.client as unknown as { processID: number }).processID;
  }

  get transactionStatus(): string {
    return this.txStatus;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** Destroy the connection on release instead of returning it to the pool. */
  markDiscard(): void {
    this.discard = true;
  }

  get willDiscard(): boolean {
    return this.discard || this.txStatus !== 'I';
  }

  /**
   * Runs `run` with abort and timeout wiring: an abort or an expired timeout cancels the running
   * query, and the resulting error is reported as QueryCancelledError or QueryTimeoutError.
   */
  async guard<T>(run: () => Promise<T>, opts: GuardOptions = {}): Promise<T> {
    const { signal, timeoutMs } = opts;
    if (signal?.aborted) throw new QueryCancelledError();
    let reason: 'abort' | 'timeout' | null = null;
    const onAbort = () => {
      if (reason) return;
      reason = 'abort';
      void this.cancel();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (reason) return;
        reason = 'timeout';
        void this.cancel();
      }, timeoutMs);
    }
    const op = run();
    this.activeOp = op.then(() => undefined, () => undefined);
    try {
      return await op;
    } catch (err) {
      if (reason === 'timeout') throw new QueryTimeoutError(timeoutMs as number, err);
      if (reason === 'abort') throw new QueryCancelledError(err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.activeOp = null;
    }
  }

  /** Runs a promise-style query on this connection, with cancellation and an optional timeout. */
  query(input: QueryInput, opts: GuardOptions = {}): Promise<any> {
    return this.guard(() => (this.client as unknown as { query: (q: QueryInput) => Promise<any> }).query(input), opts);
  }

  pauseSocket(): void {
    (this.client as unknown as { connection?: { stream?: { pause?: () => void } } }).connection?.stream?.pause?.();
  }

  resumeSocket(): void {
    (this.client as unknown as { connection?: { stream?: { resume?: () => void } } }).connection?.stream?.resume?.();
  }

  /** Cancels the running query, if any. Never throws. */
  async cancel(): Promise<void> {
    if (this.released) return;
    // A cancelled connection is never reused: a cancel request that arrives late would otherwise
    // hit the next query that runs on it.
    this.discard = true;
    // A paused socket would hold back the server's cancellation error, so resume it first.
    this.resumeSocket();
    const config = (getLastConnectionConfig() ?? {}) as unknown as Record<string, unknown>;
    const active = activeQueryOf(this.client);
    if (active) {
      try {
        if (!sendCancelRequest(config, this.client as unknown as ClientInternals)) {
          const canceller = new Client(config) as unknown as {
            connection?: NodeJS.EventEmitter;
            on?: (event: string, fn: () => void) => void;
            cancel: (target: unknown, query: unknown) => void;
          };
          canceller.connection?.on?.('error', () => undefined);
          canceller.on?.('error', () => undefined);
          canceller.cancel(this.client, active);
        }
      } catch (err) {
        console.error('[cancel] protocol cancel failed:', err instanceof Error ? err.message : err);
      }
    }
    const op = this.activeOp;
    if (!op) return;
    const settled = await Promise.race([op.then(() => true), sleep(Lease.cancelGraceMs).then(() => false)]);
    if (settled) return;
    await this.sqlCancel(config);
  }

  private async sqlCancel(config: Record<string, unknown>): Promise<void> {
    // A bounded connect: when the network is down, the fallback must not hang.
    const timeout = connectTimeoutMs() || 10_000;
    const side = new Client({ ...config, connectionTimeoutMillis: timeout }) as unknown as {
      connect: () => Promise<void>;
      query: (text: string, values: unknown[]) => Promise<unknown>;
      end: () => Promise<void>;
      on?: (event: string, fn: () => void) => void;
    };
    side.on?.('error', () => undefined);
    try {
      await side.connect();
      await side.query('select pg_cancel_backend($1)', [this.processID]);
    } catch (err) {
      console.error('[cancel] pg_cancel_backend failed:', err instanceof Error ? err.message : err);
    } finally {
      await side.end().catch(() => undefined);
    }
  }

  /** Returns the connection to the pool, or destroys it when it must not be reused. Idempotent. */
  release(): void {
    if (this.released) return;
    this.released = true;
    (this.client as unknown as { connection?: NodeJS.EventEmitter }).connection?.removeListener?.('readyForQuery', this.onReady);
    this.client.release(this.willDiscard ? true : undefined);
  }
}
