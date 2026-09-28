#!/usr/bin/env node
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatResults = exports.executeQuery = exports.ensurePool = exports.isConnectionLevelError = exports.buildSSLConfig = exports.__getTestConnectionState = exports.__setTestConnectionState = void 0;
exports.handleSigint = handleSigint;
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const pool_1 = require("./db/pool");
const server_1 = require("./server");
const runtime_1 = require("./runtime");
// Test seams re-exported from their modules so existing tests keep importing from './index'.
var pool_2 = require("./db/pool");
Object.defineProperty(exports, "__setTestConnectionState", { enumerable: true, get: function () { return pool_2.__setTestConnectionState; } });
Object.defineProperty(exports, "__getTestConnectionState", { enumerable: true, get: function () { return pool_2.__getTestConnectionState; } });
Object.defineProperty(exports, "buildSSLConfig", { enumerable: true, get: function () { return pool_2.buildSSLConfig; } });
Object.defineProperty(exports, "isConnectionLevelError", { enumerable: true, get: function () { return pool_2.isConnectionLevelError; } });
Object.defineProperty(exports, "ensurePool", { enumerable: true, get: function () { return pool_2.ensurePool; } });
var buffered_1 = require("./db/buffered");
Object.defineProperty(exports, "executeQuery", { enumerable: true, get: function () { return buffered_1.executeQuery; } });
var legacy_1 = require("./results/legacy");
Object.defineProperty(exports, "formatResults", { enumerable: true, get: function () { return legacy_1.formatResults; } });
function sleep(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
    });
}
// Graceful shutdown: close result sessions and cancel exports, drain the pool (releasing all idle
// connections, letting in-flight queries finish), then exit(0). Errors are swallowed and each step
// is time-boxed so shutdown always reaches exit(0).
async function handleSigint() {
    await (0, runtime_1.closeRuntime)().catch(() => undefined);
    const activePool = (0, pool_1.getActivePool)();
    if (activePool)
        await Promise.race([activePool.end().catch(() => undefined), sleep(5000)]);
    process.exit(0);
}
process.on('SIGINT', handleSigint);
// Process-level crash guards: any error not caught by the tool-handler try/catch or the
// `pool.on('error', ...)` listener is logged with full context. Connection-level errors discard
// the active pool so the next tool call transparently reconnects. Genuinely unrecoverable
// (non-connection) errors still log clearly and exit the process.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack || err);
    if ((0, pool_1.isConnectionLevelError)(err)) {
        (0, pool_1.discardActivePool)();
    }
    else {
        process.exit(1);
    }
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason) : reason);
    if ((0, pool_1.isConnectionLevelError)(reason)) {
        (0, pool_1.discardActivePool)();
    }
    else {
        process.exit(1);
    }
});
async function main() {
    // Remove folders left by server processes that are no longer running (never a live one's).
    await (0, runtime_1.cleanupStaleFolders)((0, runtime_1.getRuntime)());
    const mcp = (0, server_1.createMcpServer)();
    await mcp.connect(new stdio_js_1.StdioServerTransport());
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
