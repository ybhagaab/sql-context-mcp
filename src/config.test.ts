/**
 * Unit tests: configuration parsing, defaults, invalid-value fallback, and the connection
 * guardrail (design Component 1).
 *
 * Validates: Requirements 1.1, 1.3, 3.5, 3.6, 5.3, 5.7, 6.1, 6.3, 7.1, 7.3, 7.6, 9.1
 */
import { describe, test, expect } from 'vitest';
import { loadConfig, DEFAULTS } from './config';

const quiet = () => undefined;

describe('loadConfig', () => {
  test('defaults match the design', () => {
    const c = loadConfig({}, quiet);
    expect(c).toEqual(DEFAULTS);
    expect(c.poolMax).toBe(10);
    expect(c.defaultMaxRows).toBe(100);
    expect(c.maxInlineChars).toBe(100_000);
    expect(c.maxInlineCharsCeiling).toBe(5_000_000);
    expect(c.fetchBatchRows).toBe(5_000);
    expect(c.statementTimeoutMs).toBe(0);
    expect(c.progressIntervalMs).toBe(30_000);
    expect(c.spoolThresholdBytes).toBe(100 * 1024 * 1024);
    expect(c.spoolMaxTotalBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(c.maxOpenCursors).toBe(3);
    expect(c.cursorIdleTtlMs).toBe(15 * 60 * 1000);
    expect(c.exportConcurrency).toBe(2);
    expect(c.exportDir).toBeNull();
    expect(c.exportMaxRows).toBeNull();
    expect(c.exportMaxBytes).toBeNull();
    expect(c.exportMinFreeBytes).toBe(1024 * 1024 * 1024);
  });

  test('valid overrides are applied', () => {
    const c = loadConfig({
      SQL_DEFAULT_MAX_ROWS: '250',
      SQL_MAX_INLINE_CHARS: '50000',
      SQL_MAX_INLINE_CHARS_CEILING: '2000000',
      SQL_STATEMENT_TIMEOUT_MS: '60000',
      SQL_EXPORT_DIR: '/tmp/exports-here',
      SQL_EXPORT_MAX_ROWS: '1000',
      SQL_EXPORT_MAX_BYTES: '5000000',
      SQL_EXPORT_MIN_FREE_BYTES: '0',
      SQL_CURSOR_IDLE_TTL_MS: '120000',
    }, quiet);
    expect(c.defaultMaxRows).toBe(250);
    expect(c.maxInlineChars).toBe(50_000);
    expect(c.maxInlineCharsCeiling).toBe(2_000_000);
    expect(c.statementTimeoutMs).toBe(60_000);
    expect(c.exportDir).toBe('/tmp/exports-here');
    expect(c.exportMaxRows).toBe(1000);
    expect(c.exportMaxBytes).toBe(5_000_000);
    expect(c.exportMinFreeBytes).toBe(0);
    expect(c.cursorIdleTtlMs).toBe(120_000);
  });

  test('invalid values fall back to defaults with a warning', () => {
    const warnings: string[] = [];
    const c = loadConfig({ SQL_DEFAULT_MAX_ROWS: 'abc', SQL_FETCH_BATCH_ROWS: '0', SQL_PROGRESS_INTERVAL_MS: '-5' }, (m) => warnings.push(m));
    expect(c.defaultMaxRows).toBe(100);
    expect(c.fetchBatchRows).toBe(5_000);
    expect(c.progressIntervalMs).toBe(30_000);
    expect(warnings.some((w) => w.includes('SQL_DEFAULT_MAX_ROWS'))).toBe(true);
    expect(warnings.some((w) => w.includes('SQL_FETCH_BATCH_ROWS'))).toBe(true);
    expect(warnings.some((w) => w.includes('SQL_PROGRESS_INTERVAL_MS'))).toBe(true);
  });

  test('SQL_CONNECT_TIMEOUT_MS: 10 s by default, 0 disables it, invalid values fall back', () => {
    expect(loadConfig({}, quiet).connectTimeoutMs).toBe(10_000);
    expect(loadConfig({ SQL_CONNECT_TIMEOUT_MS: '2500' }, quiet).connectTimeoutMs).toBe(2_500);
    expect(loadConfig({ SQL_CONNECT_TIMEOUT_MS: '0' }, quiet).connectTimeoutMs).toBe(0);
    const warnings: string[] = [];
    expect(loadConfig({ SQL_CONNECT_TIMEOUT_MS: '-1' }, (m) => warnings.push(m)).connectTimeoutMs).toBe(10_000);
    expect(loadConfig({ SQL_CONNECT_TIMEOUT_MS: '900000' }, (m) => warnings.push(m)).connectTimeoutMs).toBe(10_000);
    expect(warnings.filter((w) => w.includes('SQL_CONNECT_TIMEOUT_MS'))).toHaveLength(2);
  });

  test('an inline budget above the ceiling is clamped to the ceiling', () => {
    const warnings: string[] = [];
    const c = loadConfig({ SQL_MAX_INLINE_CHARS: '9000000' }, (m) => warnings.push(m));
    expect(c.maxInlineChars).toBe(5_000_000);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('guardrail: open cursors plus exports always leave a pool connection for new queries', () => {
    expect(loadConfig({ SQL_POOL_MAX: '10' }, quiet)).toMatchObject({ maxOpenCursors: 3, exportConcurrency: 2 });
    const four = loadConfig({ SQL_POOL_MAX: '4' }, quiet);
    expect(four.maxOpenCursors + four.exportConcurrency).toBeLessThanOrEqual(3);
    expect(four.exportConcurrency).toBeGreaterThanOrEqual(1);
    const two = loadConfig({ SQL_POOL_MAX: '2' }, quiet);
    expect(two).toMatchObject({ maxOpenCursors: 0, exportConcurrency: 1 });
    for (let max = 2; max <= 20; max++) {
      const c = loadConfig({ SQL_POOL_MAX: String(max), SQL_MAX_OPEN_CURSORS: '8', SQL_EXPORT_CONCURRENCY: '8' }, quiet);
      expect(c.maxOpenCursors + c.exportConcurrency).toBeLessThanOrEqual(max - 1);
      expect(c.exportConcurrency).toBeGreaterThanOrEqual(1);
    }
  });
});
