"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Lease = exports.QueryTimeoutError = exports.QueryCancelledError = void 0;
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
const pg_1 = require("pg");
const pool_1 = require("./pool");
const context_1 = require("../errors/context");
/** Errors while getting a pooled connection happen before any SQL is sent. */
function connectPhase(err, pool) {
    if (err instanceof QueryCancelledError)
        return err;
    const options = pool.options;
    const config = (0, pool_1.getLastConnectionConfig)();
    const host = typeof options?.host === 'string' ? options.host : config?.host;
    const port = Number(options?.port ?? config?.port) || null;
    return (0, context_1.annotate)(err, { phase: 'connect', target: host ? { host, port } : undefined });
}
class QueryCancelledError extends Error {
    constructor(cause) {
        super('The query was cancelled.');
        this.cause = cause;
        this.name = 'QueryCancelledError';
    }
}
exports.QueryCancelledError = QueryCancelledError;
class QueryTimeoutError extends Error {
    constructor(timeoutMs, cause) {
        super(`The query exceeded timeoutMs=${timeoutMs} and was cancelled.`);
        this.timeoutMs = timeoutMs;
        this.cause = cause;
        this.name = 'QueryTimeoutError';
    }
}
exports.QueryTimeoutError = QueryTimeoutError;
function sleep(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
    });
}
/** The query running on `client`, without pg 8.20's deprecated `activeQuery` getter where possible. */
function activeQueryOf(client) {
    const c = client;
    return typeof c._getActiveQuery === 'function' ? c._getActiveQuery() : c.activeQuery;
}
/**
 * Sends a protocol-level CancelRequest for `target` on a new socket, the way pg's Client#cancel
 * does (which reads the deprecated `activeQuery` getter). Returns false when the driver doesn't
 * expose a connection that can do it, so the caller can fall back to Client#cancel.
 */
function sendCancelRequest(config, target) {
    const canceller = new pg_1.Client(config);
    const con = canceller.connection;
    if (!con || typeof con.connect !== 'function' || typeof con.cancel !== 'function' || typeof con.once !== 'function')
        return false;
    const connection = con;
    connection.on('error', () => undefined);
    connection.once('connect', () => {
        try {
            connection.cancel(target.processID, target.secretKey);
        }
        catch {
            // ignore
        }
    });
    const host = typeof config.host === 'string' && config.host ? config.host : 'localhost';
    const port = Number(config.port ?? 5432);
    if (host.startsWith('/'))
        connection.connect(`${host}/.s.PGSQL.${port}`);
    else
        connection.connect(port, host);
    // The server closes the socket after reading the request; make sure it never lingers.
    const cleanup = setTimeout(() => connection.stream?.destroy?.(), 10000);
    cleanup.unref?.();
    return true;
}
class Lease {
    constructor(client) {
        this.client = client;
        this.txStatus = 'I';
        this.discard = false;
        this.released = false;
        this.activeOp = null;
        this.onReady = (msg) => {
            if (msg && typeof msg.status === 'string')
                this.txStatus = msg.status;
        };
        client.connection?.on?.('readyForQuery', this.onReady);
    }
    static async acquire(pool, opts = {}) {
        const { signal } = opts;
        if (signal?.aborted)
            throw new QueryCancelledError();
        const pending = pool.connect().catch((err) => {
            throw connectPhase(err, pool);
        });
        if (!signal)
            return new Lease(await pending);
        const client = await new Promise((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
                if (settled)
                    return;
                settled = true;
                pending.then((c) => c.release(), () => undefined);
                reject(new QueryCancelledError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            pending.then((c) => {
                if (settled)
                    return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve(c);
            }, (err) => {
                if (settled)
                    return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                reject(err);
            });
        });
        return new Lease(client);
    }
    get processID() {
        return this.client.processID;
    }
    get transactionStatus() {
        return this.txStatus;
    }
    get isReleased() {
        return this.released;
    }
    /** Destroy the connection on release instead of returning it to the pool. */
    markDiscard() {
        this.discard = true;
    }
    get willDiscard() {
        return this.discard || this.txStatus !== 'I';
    }
    /**
     * Runs `run` with abort and timeout wiring: an abort or an expired timeout cancels the running
     * query, and the resulting error is reported as QueryCancelledError or QueryTimeoutError.
     */
    async guard(run, opts = {}) {
        const { signal, timeoutMs } = opts;
        if (signal?.aborted)
            throw new QueryCancelledError();
        let reason = null;
        const onAbort = () => {
            if (reason)
                return;
            reason = 'abort';
            void this.cancel();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        let timer = null;
        if (timeoutMs && timeoutMs > 0) {
            timer = setTimeout(() => {
                if (reason)
                    return;
                reason = 'timeout';
                void this.cancel();
            }, timeoutMs);
        }
        const op = run();
        this.activeOp = op.then(() => undefined, () => undefined);
        try {
            return await op;
        }
        catch (err) {
            if (reason === 'timeout')
                throw new QueryTimeoutError(timeoutMs, err);
            if (reason === 'abort')
                throw new QueryCancelledError(err);
            throw err;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            this.activeOp = null;
        }
    }
    /** Runs a promise-style query on this connection, with cancellation and an optional timeout. */
    query(input, opts = {}) {
        return this.guard(() => this.client.query(input), opts);
    }
    pauseSocket() {
        this.client.connection?.stream?.pause?.();
    }
    resumeSocket() {
        this.client.connection?.stream?.resume?.();
    }
    /** Cancels the running query, if any. Never throws. */
    async cancel() {
        if (this.released)
            return;
        // A cancelled connection is never reused: a cancel request that arrives late would otherwise
        // hit the next query that runs on it.
        this.discard = true;
        // A paused socket would hold back the server's cancellation error, so resume it first.
        this.resumeSocket();
        const config = ((0, pool_1.getLastConnectionConfig)() ?? {});
        const active = activeQueryOf(this.client);
        if (active) {
            try {
                if (!sendCancelRequest(config, this.client)) {
                    const canceller = new pg_1.Client(config);
                    canceller.connection?.on?.('error', () => undefined);
                    canceller.on?.('error', () => undefined);
                    canceller.cancel(this.client, active);
                }
            }
            catch (err) {
                console.error('[cancel] protocol cancel failed:', err instanceof Error ? err.message : err);
            }
        }
        const op = this.activeOp;
        if (!op)
            return;
        const settled = await Promise.race([op.then(() => true), sleep(Lease.cancelGraceMs).then(() => false)]);
        if (settled)
            return;
        await this.sqlCancel(config);
    }
    async sqlCancel(config) {
        // A bounded connect: when the network is down, the fallback must not hang.
        const side = new pg_1.Client((0, pool_1.withConnectTimeout)(config, (0, pool_1.connectTimeoutMs)() || 10000));
        side.on?.('error', () => undefined);
        try {
            await side.connect();
            await side.query('select pg_cancel_backend($1)', [this.processID]);
        }
        catch (err) {
            console.error('[cancel] pg_cancel_backend failed:', err instanceof Error ? err.message : err);
        }
        finally {
            await side.end().catch(() => undefined);
        }
    }
    /** Returns the connection to the pool, or destroys it when it must not be reused. Idempotent. */
    release() {
        if (this.released)
            return;
        this.released = true;
        this.client.connection?.removeListener?.('readyForQuery', this.onReady);
        this.client.release(this.willDiscard ? true : undefined);
    }
}
exports.Lease = Lease;
/** How long to wait after a protocol cancel before falling back to pg_cancel_backend. */
Lease.cancelGraceMs = 3000;
