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
import { Pool, PoolClient } from 'pg';
export declare class QueryCancelledError extends Error {
    readonly cause?: unknown | undefined;
    constructor(cause?: unknown | undefined);
}
export declare class QueryTimeoutError extends Error {
    readonly timeoutMs: number;
    readonly cause?: unknown | undefined;
    constructor(timeoutMs: number, cause?: unknown | undefined);
}
export type QueryInput = string | {
    text: string;
    values?: unknown[];
    rowMode?: 'array';
    types?: unknown;
};
export interface GuardOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export declare class Lease {
    readonly client: PoolClient;
    /** How long to wait after a protocol cancel before falling back to pg_cancel_backend. */
    static cancelGraceMs: number;
    private txStatus;
    private discard;
    private released;
    private activeOp;
    private readonly onReady;
    private constructor();
    static acquire(pool: Pool, opts?: {
        signal?: AbortSignal;
    }): Promise<Lease>;
    get processID(): number;
    get transactionStatus(): string;
    get isReleased(): boolean;
    /** Destroy the connection on release instead of returning it to the pool. */
    markDiscard(): void;
    get willDiscard(): boolean;
    /**
     * Runs `run` with abort and timeout wiring: an abort or an expired timeout cancels the running
     * query, and the resulting error is reported as QueryCancelledError or QueryTimeoutError.
     */
    guard<T>(run: () => Promise<T>, opts?: GuardOptions): Promise<T>;
    /** Runs a promise-style query on this connection, with cancellation and an optional timeout. */
    query(input: QueryInput, opts?: GuardOptions): Promise<any>;
    pauseSocket(): void;
    resumeSocket(): void;
    /** Cancels the running query, if any. Never throws. */
    cancel(): Promise<void>;
    private sqlCancel;
    /** Returns the connection to the pool, or destroys it when it must not be reused. Idempotent. */
    release(): void;
}
//# sourceMappingURL=lease.d.ts.map