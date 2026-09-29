/**
 * Server configuration from environment variables (design Component 1).
 *
 * Every setting has a default, so no configuration is needed to upgrade. Invalid values fall back
 * to the default with a one-time warning on stderr. A guardrail keeps open cursors plus exports
 * from taking every pooled connection.
 */

export interface ServerConfig {
  poolMax: number;
  /** How long one connection attempt (network, TLS and login) may take; 0 waits for the OS. */
  connectTimeoutMs: number;
  defaultMaxRows: number;
  maxInlineChars: number;
  maxInlineCharsCeiling: number;
  fetchBatchRows: number;
  statementTimeoutMs: number;
  progressIntervalMs: number;
  spoolThresholdBytes: number;
  spoolMaxTotalBytes: number;
  maxOpenCursors: number;
  cursorIdleTtlMs: number;
  exportConcurrency: number;
  exportDir: string | null;
  exportMaxRows: number | null;
  exportMaxBytes: number | null;
  exportMinFreeBytes: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const DEFAULTS: ServerConfig = Object.freeze({
  poolMax: 10,
  connectTimeoutMs: 10_000,
  defaultMaxRows: 100,
  maxInlineChars: 100_000,
  maxInlineCharsCeiling: 5_000_000,
  fetchBatchRows: 5_000,
  statementTimeoutMs: 0,
  progressIntervalMs: 30_000,
  spoolThresholdBytes: 100 * MB,
  spoolMaxTotalBytes: 2 * GB,
  maxOpenCursors: 3,
  cursorIdleTtlMs: 15 * 60 * 1000,
  exportConcurrency: 2,
  exportDir: null,
  exportMaxRows: null,
  exportMaxBytes: null,
  exportMinFreeBytes: GB,
}) as ServerConfig;

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

const warnedMessages = new Set<string>();
function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.error(`[config] ${message}`);
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number, warn: Warn): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    warn(`${name}=${JSON.stringify(raw)} is invalid (expected an integer from ${min} to ${max}); using ${fallback}.`);
    return fallback;
  }
  return value;
}

function readOptionalInt(env: Env, name: string, min: number, warn: Warn): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
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
export function loadConfig(env: Env = process.env, warn: Warn = warnOnce): ServerConfig {
  const poolMax = readInt(env, 'SQL_POOL_MAX', DEFAULTS.poolMax, 1, 1000, warn);
  const maxInlineCharsCeiling = readInt(env, 'SQL_MAX_INLINE_CHARS_CEILING', DEFAULTS.maxInlineCharsCeiling, 1_000, 100_000_000, warn);
  let maxInlineChars = readInt(env, 'SQL_MAX_INLINE_CHARS', DEFAULTS.maxInlineChars, 1_000, 100_000_000, warn);
  if (maxInlineChars > maxInlineCharsCeiling) {
    warn(`SQL_MAX_INLINE_CHARS=${maxInlineChars} exceeds SQL_MAX_INLINE_CHARS_CEILING=${maxInlineCharsCeiling}; using the ceiling.`);
    maxInlineChars = maxInlineCharsCeiling;
  }

  let maxOpenCursors = readInt(env, 'SQL_MAX_OPEN_CURSORS', DEFAULTS.maxOpenCursors, 0, 100, warn);
  let exportConcurrency = readInt(env, 'SQL_EXPORT_CONCURRENCY', DEFAULTS.exportConcurrency, 1, 100, warn);

  // Guardrail: long-lived holders (open cursors + exports) must leave at least one pooled
  // connection for new queries. Scale both down proportionally when they don't.
  const budget = Math.max(poolMax - 1, 1);
  if (maxOpenCursors + exportConcurrency > budget) {
    const total = maxOpenCursors + exportConcurrency;
    let cursors = Math.floor((maxOpenCursors * budget) / total);
    const exports = Math.max(1, budget - cursors);
    if (cursors + exports > budget) cursors = Math.max(0, budget - exports);
    warn(
      `SQL_MAX_OPEN_CURSORS=${maxOpenCursors} plus SQL_EXPORT_CONCURRENCY=${exportConcurrency} would leave no free ` +
      `connection in a pool of ${poolMax}; using ${cursors} open cursors and ${exports} concurrent exports.`,
    );
    maxOpenCursors = cursors;
    exportConcurrency = exports;
  }

  const exportDirRaw = env.SQL_EXPORT_DIR;
  return {
    poolMax,
    connectTimeoutMs: readInt(env, 'SQL_CONNECT_TIMEOUT_MS', DEFAULTS.connectTimeoutMs, 0, 600_000, warn),
    defaultMaxRows: readInt(env, 'SQL_DEFAULT_MAX_ROWS', DEFAULTS.defaultMaxRows, 1, 1_000_000, warn),
    maxInlineChars,
    maxInlineCharsCeiling,
    fetchBatchRows: readInt(env, 'SQL_FETCH_BATCH_ROWS', DEFAULTS.fetchBatchRows, 1, 100_000, warn),
    statementTimeoutMs: readInt(env, 'SQL_STATEMENT_TIMEOUT_MS', DEFAULTS.statementTimeoutMs, 0, Number.MAX_SAFE_INTEGER, warn),
    progressIntervalMs: readInt(env, 'SQL_PROGRESS_INTERVAL_MS', DEFAULTS.progressIntervalMs, 1_000, 3_600_000, warn),
    spoolThresholdBytes: readInt(env, 'SQL_SPOOL_THRESHOLD_BYTES', DEFAULTS.spoolThresholdBytes, 0, Number.MAX_SAFE_INTEGER, warn),
    spoolMaxTotalBytes: readInt(env, 'SQL_SPOOL_MAX_TOTAL_BYTES', DEFAULTS.spoolMaxTotalBytes, 0, Number.MAX_SAFE_INTEGER, warn),
    maxOpenCursors,
    cursorIdleTtlMs: readInt(env, 'SQL_CURSOR_IDLE_TTL_MS', DEFAULTS.cursorIdleTtlMs, 1_000, Number.MAX_SAFE_INTEGER, warn),
    exportConcurrency,
    exportDir: exportDirRaw && exportDirRaw.trim() ? exportDirRaw.trim() : null,
    exportMaxRows: readOptionalInt(env, 'SQL_EXPORT_MAX_ROWS', 1, warn),
    exportMaxBytes: readOptionalInt(env, 'SQL_EXPORT_MAX_BYTES', 1, warn),
    exportMinFreeBytes: readInt(env, 'SQL_EXPORT_MIN_FREE_BYTES', DEFAULTS.exportMinFreeBytes, 0, Number.MAX_SAFE_INTEGER, warn),
  };
}

/** Current configuration from process.env (cheap to call; warnings are shown once). */
export function getConfig(): ServerConfig {
  return loadConfig(process.env, warnOnce);
}
