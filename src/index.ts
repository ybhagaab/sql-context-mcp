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

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getActivePool, discardActivePool, isConnectionLevelError } from './db/pool';
import { createMcpServer } from './server';
import { getRuntime, cleanupStaleFolders, closeRuntime } from './runtime';

// Test seams re-exported from their modules so existing tests keep importing from './index'.
export {
  __setTestConnectionState,
  __getTestConnectionState,
  buildSSLConfig,
  isConnectionLevelError,
  ensurePool,
} from './db/pool';
export { executeQuery } from './db/buffered';
export { formatResults } from './results/legacy';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

// Graceful shutdown: close result sessions and cancel exports, drain the pool (releasing all idle
// connections, letting in-flight queries finish), then exit(0). Errors are swallowed and each step
// is time-boxed so shutdown always reaches exit(0).
export async function handleSigint(): Promise<void> {
  await closeRuntime().catch(() => undefined);
  const activePool = getActivePool();
  if (activePool) await Promise.race([activePool.end().catch(() => undefined), sleep(5_000)]);
  process.exit(0);
}

process.on('SIGINT', handleSigint);

// Process-level crash guards: any error not caught by the tool-handler try/catch or the
// `pool.on('error', ...)` listener is logged with full context. Connection-level errors discard
// the active pool so the next tool call transparently reconnects. Genuinely unrecoverable
// (non-connection) errors still log clearly and exit the process.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err);
  if (isConnectionLevelError(err)) {
    discardActivePool();
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason) : reason);
  if (isConnectionLevelError(reason)) {
    discardActivePool();
  } else {
    process.exit(1);
  }
});

async function main() {
  // Remove folders left by server processes that are no longer running (never a live one's).
  await cleanupStaleFolders(getRuntime());
  const mcp = createMcpServer();
  await mcp.connect(new StdioServerTransport());
  console.error('SQL Context Presets MCP Server running on stdio');
}

// Only auto-start the stdio server when this file is executed directly (normal `node
// dist/index.js` / bin invocation). When the module is imported by a test runner, this guard
// prevents the real MCP server from starting and touching stdio.
if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
