"use strict";
/**
 * Server configuration from environment variables (design Component 1).
 *
 * Every setting has a default, so no configuration is needed to upgrade. Invalid values fall back
 * to the default with a one-time warning on stderr. A guardrail keeps open cursors plus exports
 * from taking every pooled connection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULTS = void 0;
exports.loadConfig = loadConfig;
exports.getConfig = getConfig;
const MB = 1024 * 1024;
const GB = 1024 * MB;
exports.DEFAULTS = Object.freeze({
    poolMax: 10,
    connectTimeoutMs: 10000,
    defaultMaxRows: 100,
    maxInlineChars: 100000,
    maxInlineCharsCeiling: 5000000,
    fetchBatchRows: 5000,
    statementTimeoutMs: 0,
    progressIntervalMs: 30000,
    spoolThresholdBytes: 100 * MB,
    spoolMaxTotalBytes: 2 * GB,
    maxOpenCursors: 3,
    cursorIdleTtlMs: 15 * 60 * 1000,
    exportConcurrency: 2,
    exportDir: null,
    exportMaxRows: null,
    exportMaxBytes: null,
    exportMinFreeBytes: GB,
});
const warnedMessages = new Set();
function warnOnce(message) {
    if (warnedMessages.has(message))
        return;
    warnedMessages.add(message);
    console.error(`[config] ${message}`);
}
function readInt(env, name, fallback, min, max, warn) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < min || value > max) {
        warn(`${name}=${JSON.stringify(raw)} is invalid (expected an integer from ${min} to ${max}); using ${fallback}.`);
        return fallback;
    }
    return value;
}
function readOptionalInt(env, name, min, warn) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '')
        return null;
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < min) {
        warn(`${name}=${JSON.stringify(raw)} is invalid (expected an integer of at least ${min}); treating it as unset.`);
        return null;
    }
    return value;
}
/**
 * Parses configuration from `env`. Pure apart from `warn`; `getConfig()` reads process.env.
 */
function loadConfig(env = process.env, warn = warnOnce) {
    const poolMax = readInt(env, 'SQL_POOL_MAX', exports.DEFAULTS.poolMax, 1, 1000, warn);
    const maxInlineCharsCeiling = readInt(env, 'SQL_MAX_INLINE_CHARS_CEILING', exports.DEFAULTS.maxInlineCharsCeiling, 1000, 100000000, warn);
    let maxInlineChars = readInt(env, 'SQL_MAX_INLINE_CHARS', exports.DEFAULTS.maxInlineChars, 1000, 100000000, warn);
    if (maxInlineChars > maxInlineCharsCeiling) {
        warn(`SQL_MAX_INLINE_CHARS=${maxInlineChars} exceeds SQL_MAX_INLINE_CHARS_CEILING=${maxInlineCharsCeiling}; using the ceiling.`);
        maxInlineChars = maxInlineCharsCeiling;
    }
    let maxOpenCursors = readInt(env, 'SQL_MAX_OPEN_CURSORS', exports.DEFAULTS.maxOpenCursors, 0, 100, warn);
    let exportConcurrency = readInt(env, 'SQL_EXPORT_CONCURRENCY', exports.DEFAULTS.exportConcurrency, 1, 100, warn);
    // Guardrail: long-lived holders (open cursors + exports) must leave at least one pooled
    // connection for new queries. Scale both down proportionally when they don't.
    const budget = Math.max(poolMax - 1, 1);
    if (maxOpenCursors + exportConcurrency > budget) {
        const total = maxOpenCursors + exportConcurrency;
        let cursors = Math.floor((maxOpenCursors * budget) / total);
        const exports = Math.max(1, budget - cursors);
        if (cursors + exports > budget)
            cursors = Math.max(0, budget - exports);
        warn(`SQL_MAX_OPEN_CURSORS=${maxOpenCursors} plus SQL_EXPORT_CONCURRENCY=${exportConcurrency} would leave no free ` +
            `connection in a pool of ${poolMax}; using ${cursors} open cursors and ${exports} concurrent exports.`);
        maxOpenCursors = cursors;
        exportConcurrency = exports;
    }
    const exportDirRaw = env.SQL_EXPORT_DIR;
    return {
        poolMax,
        connectTimeoutMs: readInt(env, 'SQL_CONNECT_TIMEOUT_MS', exports.DEFAULTS.connectTimeoutMs, 0, 600000, warn),
        defaultMaxRows: readInt(env, 'SQL_DEFAULT_MAX_ROWS', exports.DEFAULTS.defaultMaxRows, 1, 1000000, warn),
        maxInlineChars,
        maxInlineCharsCeiling,
        fetchBatchRows: readInt(env, 'SQL_FETCH_BATCH_ROWS', exports.DEFAULTS.fetchBatchRows, 1, 100000, warn),
        statementTimeoutMs: readInt(env, 'SQL_STATEMENT_TIMEOUT_MS', exports.DEFAULTS.statementTimeoutMs, 0, Number.MAX_SAFE_INTEGER, warn),
        progressIntervalMs: readInt(env, 'SQL_PROGRESS_INTERVAL_MS', exports.DEFAULTS.progressIntervalMs, 1000, 3600000, warn),
        spoolThresholdBytes: readInt(env, 'SQL_SPOOL_THRESHOLD_BYTES', exports.DEFAULTS.spoolThresholdBytes, 0, Number.MAX_SAFE_INTEGER, warn),
        spoolMaxTotalBytes: readInt(env, 'SQL_SPOOL_MAX_TOTAL_BYTES', exports.DEFAULTS.spoolMaxTotalBytes, 0, Number.MAX_SAFE_INTEGER, warn),
        maxOpenCursors,
        cursorIdleTtlMs: readInt(env, 'SQL_CURSOR_IDLE_TTL_MS', exports.DEFAULTS.cursorIdleTtlMs, 1000, Number.MAX_SAFE_INTEGER, warn),
        exportConcurrency,
        exportDir: exportDirRaw && exportDirRaw.trim() ? exportDirRaw.trim() : null,
        exportMaxRows: readOptionalInt(env, 'SQL_EXPORT_MAX_ROWS', 1, warn),
        exportMaxBytes: readOptionalInt(env, 'SQL_EXPORT_MAX_BYTES', 1, warn),
        exportMinFreeBytes: readInt(env, 'SQL_EXPORT_MIN_FREE_BYTES', exports.DEFAULTS.exportMinFreeBytes, 0, Number.MAX_SAFE_INTEGER, warn),
    };
}
/** Current configuration from process.env (cheap to call; warnings are shown once). */
function getConfig() {
    return loadConfig(process.env, warnOnce);
}
