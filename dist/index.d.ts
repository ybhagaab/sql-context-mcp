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
 * Results:
 * - run_query returns budgeted pages with exact totals; fetch_rows continues a result
 * - export_query streams complete results of any size to CSV or JSONL files
 *
 * Security Features:
 * - Zod schema validation for all inputs
 * - Response content sanitization (hidden character stripping)
 * - Response size budgets
 */
export { __setTestConnectionState, __getTestConnectionState, buildSSLConfig, isConnectionLevelError, ensurePool, } from './db/pool';
export { executeQuery } from './db/buffered';
export { formatResults } from './results/legacy';
export declare function handleSigint(): Promise<void>;
//# sourceMappingURL=index.d.ts.map