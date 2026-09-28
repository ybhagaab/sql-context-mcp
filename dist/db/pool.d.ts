/**
 * Connection pool, authentication, SSL configuration, error classification, and the bounded
 * reconnect-and-retry helper.
 *
 * Moved from index.ts unchanged in behavior (mcp-server-connection-reliability spec): per-query
 * pool checkout, creation-race guard, compare-and-swap pool discard with background drain, IAM
 * credential-expiry recycling, keepalive, and connection-level error classification.
 */
import { Pool } from 'pg';
export interface ConnectionConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean | object;
    keepAlive: boolean;
    keepAliveInitialDelayMillis: number;
    max: number;
}
export declare function __setTestConnectionState(state: {
    pool?: Pool | null;
    iamCredentialsCache?: {
        user: string;
        password: string;
        expiry: number;
    } | null;
}): void;
export declare function __getTestConnectionState(): {
    pool: Pool | null;
    iamCredentialsCache: {
        user: string;
        password: string;
        expiry: number;
    } | null;
};
export declare function buildSSLConfig(): boolean | object;
export declare function getPoolMax(): number;
/**
 * Classifies an error as connection-level (socket/connection fault, eligible for the bounded
 * reconnect-and-retry) vs application-level (ZodError, SQL syntax/constraint errors, or anything
 * else), which must never be retried.
 */
export declare function isConnectionLevelError(error: unknown): boolean;
/**
 * Discards a pool so the next `ensurePool()` call rebuilds from scratch, without blocking the
 * caller on in-flight queries.
 *
 * Compare-and-swap semantics: only the FIRST discarder of the currently-active pool clears the
 * module reference and initiates the drain. Concurrent failures on the same (already-discarded)
 * pool, or failures on a stale pool reference after a replacement was created, are no-ops.
 *
 * The drain (`pool.end()`) runs in the background: it lets queries still executing on the old
 * pool's other connections finish before their sockets close, while the caller immediately
 * proceeds to reconnect/retry. Drain errors are logged, never thrown.
 */
export declare function discardPool(failedPool: Pool): void;
/** Discards the active pool, if any (used by the process-level crash guards). */
export declare function discardActivePool(): void;
/** The active pool, or null. */
export declare function getActivePool(): Pool | null;
/** The connection config the most recent pool was created with, or null. */
export declare function getLastConnectionConfig(): ConnectionConfig | null;
/**
 * Returns the active connection pool, creating it if needed.
 *
 * Staleness is handled reactively by the bounded retry: a connection-level failure discards the
 * WHOLE pool and the retry rebuilds it fresh. `keepAlive` remains enabled as proactive
 * mitigation. IAM credential expiry is an independent recycling trigger: the pool's config
 * captures the password at creation time, so once the cached IAM credentials expire the pool
 * must be discarded before it mints any new connection with the stale password.
 */
export declare function ensurePool(): Promise<Pool>;
export declare const MAX_QUERY_ATTEMPTS = 3;
/**
 * Runs `operation` against the active pool with bounded reconnect-and-retry.
 *
 * `ensurePool()` runs inside the retry loop so a connection-level error during pool creation
 * itself is also retried. On a connection-level error the pool the attempt used is discarded
 * (compare-and-swap) and, after a short backoff, the operation is retried, up to
 * MAX_QUERY_ATTEMPTS in total. Application-level errors are re-thrown immediately.
 *
 * `canRetry` lets callers forbid retries once retrying would be unsafe or wasteful, for example
 * after rows were delivered or after an earlier script statement completed.
 */
export declare function withConnectionRetry<T>(operation: (activePool: Pool, attempt: number) => Promise<T>, options?: {
    canRetry?: () => boolean;
}): Promise<T>;
//# sourceMappingURL=pool.d.ts.map