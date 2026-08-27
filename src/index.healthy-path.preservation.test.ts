/**
 * Preservation property tests — healthy-path query execution and SIGINT shutdown.
 *
 * Property 2: Preservation - Healthy-Path Formatting and Graceful Shutdown Unchanged
 *
 * Updated for the per-query pool checkout refactor (concurrent executeQuery support): the module
 * no longer caches a single `PoolClient`; queries run via `pool.query()` so concurrent tool calls
 * execute in parallel on separate connections. The PRESERVED property is unchanged:
 *
 *   "For any input where the bug condition does NOT hold (a query executes successfully on a live
 *    connection, or SIGINT is received), the system SHALL produce identical formatted/sanitized
 *    query output, and graceful pool-drain/process.exit(0) sequencing on SIGINT."
 *
 * What changed mechanically in this file versus the pre-refactor version:
 *   - The injected healthy connection is now a mocked *pool* (with a `query` method), installed
 *     via `__setTestConnectionState({ pool })`, instead of a mocked cached *client*.
 *   - The SIGINT baseline is now `pool.end()` -> `process.exit(0)` (there is no long-lived
 *     checked-out client to `release()` first — per-query checkout returns each client to the
 *     pool as soon as its query finishes).
 *
 * All `formatResults()` formatting rules asserted below (padding, NULL substitution, 100-row
 * display cap, row-count/timing footer) are byte-for-byte the same as the pre-refactor baseline.
 *
 * `executeQuery`, `formatResults`, `handleSigint`, `__setTestConnectionState`, and
 * `__getTestConnectionState` are imported directly from `./index` as minimal, additive test seams
 * (see the NOTE comments next to their declarations in `src/index.ts`), mirroring the precedent
 * established by the other exploration/preservation test files in this directory.
 *
 * **Validates: Requirements 3.1, 3.3**
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

vi.mock('pg', () => {
  class MockPool {
    public config: unknown;
    query = vi.fn(async () => ({ rows: [], rowCount: 0, fields: [] }));
    end = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(config: unknown) {
      this.config = config;
    }
  }
  return { Pool: MockPool };
});

import {
  executeQuery,
  formatResults,
  handleSigint,
  __setTestConnectionState,
  __getTestConnectionState,
} from './index';

const ENV_KEYS = [
  'SQL_AUTH_METHOD',
  'SQL_HOST',
  'SQL_PORT',
  'SQL_DATABASE',
  'SQL_USER',
  'SQL_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SQL_AUTH_METHOD = 'direct';
  process.env.SQL_HOST = 'mock-host';
  process.env.SQL_PORT = '5439';
  process.env.SQL_DATABASE = 'mock-db';
  process.env.SQL_USER = 'mock-user';
  process.env.SQL_PASSWORD = 'mock-pass';
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
});

// ---------------------------------------------------------------------------
// Property-based test: healthy-path query execution + formatResults() shape
// ---------------------------------------------------------------------------

// Cell values restricted to a charset with no spaces/pipes/newlines so the pipe-delimited table
// output can be parsed back unambiguously in assertions below (this is a test-parsing
// convenience, not a restriction on formatResults()'s actual behavior).
const safeCellStringArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
    minLength: 0,
    maxLength: 10,
  })
  .map((chars) => chars.join(''));
const cellValueArb = fc.oneof(
  safeCellStringArb,
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null)
);

const columnBaseNameArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnop'.split('')), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(''));

// Generates a random result-set shape: 1-5 columns (unique names), 0-150 rows (covering the
// 100-row display cap in both directions), with cell values including `null`.
const resultSetShapeArb = fc
  .record({
    numColumns: fc.integer({ min: 1, max: 5 }),
    rowCount: fc.integer({ min: 0, max: 150 }),
  })
  .chain(({ numColumns, rowCount }) =>
    fc
      .record({
        columnBaseNames: fc.array(columnBaseNameArb, { minLength: numColumns, maxLength: numColumns }),
        rows: fc.array(fc.array(cellValueArb, { minLength: numColumns, maxLength: numColumns }), {
          minLength: rowCount,
          maxLength: rowCount,
        }),
      })
      .map(({ columnBaseNames, rows }) => ({
        columns: columnBaseNames.map((base, i) => `${base}_${i}`),
        rows,
      }))
  );

function makeQueryResultMock(columns: string[], rows: unknown[][]) {
  return {
    fields: columns.map((name) => ({ name })),
    rows: rows.map((rowArr) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = rowArr[i];
      });
      return obj;
    }),
    rowCount: rows.length,
  };
}

/** A mocked healthy *pool* whose per-query checkout (`pool.query()`) always succeeds with the
 * given result — the pooled equivalent of the pre-refactor "live cached client". */
function makeLivePool(queryResultMock: unknown) {
  return {
    query: vi.fn().mockResolvedValue(queryResultMock),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };
}

describe('Preservation: healthy-path query execution and formatResults() output (Property 2)', () => {
  test(
    'executeQuery() + formatResults() preserve column/row/rowCount shape and all documented formatting rules for random result sets',
    async () => {
      await fc.assert(
        fc.asyncProperty(resultSetShapeArb, async ({ columns: generatedColumns, rows: generatedRows }) => {
          const queryResultMock = makeQueryResultMock(generatedColumns, generatedRows);
          const livePool = makeLivePool(queryResultMock);
          __setTestConnectionState({ pool: livePool as any });

          const result = await executeQuery('SELECT 1');

          // --- executeQuery() structured output preservation ---
          expect(result.columns).toEqual(generatedColumns);
          expect(result.rows).toEqual(generatedRows);
          expect(result.rowCount).toBe(generatedRows.length);
          expect(result.executionTime).toBeGreaterThanOrEqual(0);

          // Healthy path: exactly one per-query checkout, and the healthy pool is never
          // discarded (no drain).
          expect(livePool.query).toHaveBeenCalledTimes(1);
          expect(livePool.end).not.toHaveBeenCalled();
          expect(__getTestConnectionState().pool).toBe(livePool);

          const output = formatResults(result);

          if (generatedRows.length === 0) {
            // Zero-row baseline: a single informational line, no table.
            expect(output).toBe(
              `Query executed successfully. ${result.rowCount} rows affected. (${result.executionTime}ms)`
            );
            return;
          }

          const lines = output.split('\n');
          const headerCells = lines[0].split(' | ');
          const separatorCells = lines[1].split('-+-');
          expect(headerCells.length).toBe(generatedColumns.length);
          expect(separatorCells.length).toBe(generatedColumns.length);

          // Per-column width: header segment length must be >= column name length, >= 4 (the
          // documented minimum), and >= the display length of EVERY value in that column across
          // ALL rows (not just the first 100 displayed) — this is the `widths` computation rule.
          const widths = headerCells.map((cell, i) => {
            expect(cell.trimEnd()).toBe(generatedColumns[i]);
            const width = cell.length;
            expect(width).toBeGreaterThanOrEqual(generatedColumns[i].length);
            expect(width).toBeGreaterThanOrEqual(4);
            for (const row of generatedRows) {
              const displayValue = row[i] === null ? 'NULL' : String(row[i]);
              expect(width).toBeGreaterThanOrEqual(displayValue.length);
            }
            return width;
          });

          // Separator line: dashes matching each column's width exactly.
          separatorCells.forEach((cell, i) => {
            expect(cell).toBe('-'.repeat(widths[i]));
          });

          // Displayed rows: capped at 100, NULL substitution, and per-column padding to `widths`.
          const expectedDisplayCount = Math.min(generatedRows.length, 100);
          const rowLines = lines.slice(2, 2 + expectedDisplayCount);
          expect(rowLines.length).toBe(expectedDisplayCount);
          rowLines.forEach((line, rowIndex) => {
            const cells = line.split(' | ');
            expect(cells.length).toBe(generatedColumns.length);
            cells.forEach((cell, colIndex) => {
              const rawValue = generatedRows[rowIndex][colIndex];
              const expectedDisplay = rawValue === null ? 'NULL' : String(rawValue);
              expect(cell.length).toBe(widths[colIndex]);
              expect(cell.trimEnd()).toBe(expectedDisplay);
            });
          });

          // 100-row display cap footer note, only when more than 100 rows exist.
          let cursor = 2 + expectedDisplayCount;
          if (generatedRows.length > 100) {
            expect(lines[cursor]).toBe(`... (${generatedRows.length - 100} more rows)`);
            cursor += 1;
          }

          // Row-count/timing footer: a blank separator line, then the summary line.
          expect(lines[cursor]).toBe('');
          expect(lines[cursor + 1]).toBe(
            `${result.rowCount} rows returned. (${result.executionTime}ms)`
          );
        }),
        { numRuns: 25 }
      );
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// SIGINT handler: pool.end() -> exit(0) call order preservation
// ---------------------------------------------------------------------------

describe('Preservation: SIGINT graceful shutdown call order (Property 2)', () => {
  test('handleSigint() drains the pool via pool.end(), then calls process.exit(0), in that order', async () => {
    const callOrder: string[] = [];
    const mockPool = {
      query: vi.fn(),
      on: vi.fn(),
      end: vi.fn(async () => {
        callOrder.push('end');
      }),
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      callOrder.push(`exit(${code})`);
      return undefined as never;
    }) as any);

    __setTestConnectionState({ pool: mockPool as any });

    await handleSigint();

    expect(callOrder).toEqual(['end', 'exit(0)']);
    expect(mockPool.end).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  test('handleSigint() still reaches process.exit(0) when pool.end() rejects (shutdown never hangs on a drain error)', async () => {
    const mockPool = {
      query: vi.fn(),
      on: vi.fn(),
      end: vi.fn(async () => {
        throw new Error('Called end on pool more than once');
      }),
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);

    __setTestConnectionState({ pool: mockPool as any });

    await handleSigint();

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
