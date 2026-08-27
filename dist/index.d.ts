#!/usr/bin/env node
/**
 * SQL Context Presets MCP Server
 *
 * Provides tools for executing SQL queries on PostgreSQL/Redshift databases
 * via the Model Context Protocol.
 *
 * Supports multiple authentication methods:
 * - Direct username/password
 * - AWS IAM Authentication (Redshift)
 * - AWS Secrets Manager
 *
 * Security Features:
 * - Zod schema validation for all inputs and outputs
 * - Response content sanitization (hidden character stripping)
 * - Response size limits
 */
import { Pool } from 'pg';
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
export declare function isConnectionLevelError(error: unknown): boolean;
/**
 * Returns the active connection pool, creating it if needed.
 *
 * Replaces the previous `ensureConnection(): Promise<PoolClient>` single-cached-client pattern:
 * callers now run queries via `pool.query()`, which checks a client out PER QUERY, so concurrent
 * MCP tool calls genuinely execute in parallel (up to `max` connections) instead of serializing
 * on one shared client.
 *
 * The old per-reuse `SELECT 1` liveness check does not map to a pool (each query may get a
 * different pooled connection, and pg provides no checkout-time validation hook); staleness is
 * instead handled reactively by `executeQuery()`'s bounded retry: a connection-level failure
 * discards the WHOLE pool (covering the "every idle connection died while the laptop slept"
 * case) and the retry rebuilds it fresh. `keepAlive` remains enabled as proactive mitigation.
 *
 * IAM credential expiry is preserved as an independent recycling trigger: the pool's config
 * captures the password at creation time, so once the cached IAM credentials expire the pool
 * must be discarded before it mints any new connection with the stale password.
 */
export declare function ensurePool(): Promise<Pool>;
export declare function executeQuery(sql: string, params?: any[]): Promise<{
    columns: string[];
    rows: any[][];
    rowCount: number;
    executionTime: number;
}>;
export declare function formatResults(result: {
    columns: string[];
    rows: any[][];
    rowCount: number;
    executionTime: number;
}): string;
export declare function handleSigint(): Promise<void>;
//# sourceMappingURL=index.d.ts.map