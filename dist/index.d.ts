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
import { Pool, PoolClient } from 'pg';
export declare function __setTestConnectionState(state: {
    client?: PoolClient | null;
    pool?: Pool | null;
    iamCredentialsCache?: {
        user: string;
        password: string;
        expiry: number;
    } | null;
}): void;
export declare function __getTestConnectionState(): {
    client: PoolClient | null;
    pool: Pool | null;
    iamCredentialsCache: {
        user: string;
        password: string;
        expiry: number;
    } | null;
};
export declare function buildSSLConfig(): boolean | object;
export declare function isConnectionLevelError(error: unknown): boolean;
export declare function ensureConnection(): Promise<PoolClient>;
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