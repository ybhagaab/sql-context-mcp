/**
 * Memory bounds (design: Resource and Concurrency Model; Task 20).
 *
 * A large fake result run through export_query, run_query (spooled, open-cursor and streaming
 * paths) and fetch_rows keeps heap growth under a fixed bound: no path buffers a whole result.
 *
 * The default suite runs a smaller smoke version. The full check (5,000,000 rows) runs with
 * `npm run test:memory`, which also exposes the garbage collector so retained memory is measured
 * exactly after each run.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

vi.mock('pg', async () => (await import('./test/fake-pg')).fakePgModule);

import { fakeDb, FakeColumn } from './test/fake-pg';
import { setupFakeDb, makeRuntime, teardown, call, textOf, jsonOf, until } from './test/harness';
import type { Runtime } from './runtime';
import type { SpoolSession } from './results/store';

const FULL = process.env.SQL_MEMORY_TESTS === '1';
const ROWS = FULL ? 5_000_000 : 200_000;
const MB = 1024 * 1024;
/** Peak heap growth allowed while a result streams (rows retained would need far more). */
const PEAK_BOUND = (FULL ? 160 : 120) * MB;
/** Heap still held after a run, measured after a full GC (when available). */
const RETAINED_BOUND = 32 * MB;
const TIMEOUT = FULL ? 600_000 : 120_000;

const COLUMNS: FakeColumn[] = [{ name: 'id', oid: 23 }, { name: 'payload', oid: 1043 }, { name: 'd', oid: 1082 }];

function defineBig(sql: string, rows = ROWS): void {
  fakeDb.define(sql, {
    columns: COLUMNS,
    rows: () => (function* () {
      for (let i = 0; i < rows; i++) yield [String(i), `payload-${i}-abcdefghij`, '2026-09-05'];
    })(),
    rowCount: rows,
  });
}

const gc = (globalThis as { gc?: () => void }).gc;

function heap(): number {
  gc?.();
  return process.memoryUsage().heapUsed;
}

/** Runs `fn` while sampling the heap; returns the peak growth and the retained growth. */
async function measure(fn: () => Promise<void>): Promise<{ peak: number; retained: number }> {
  const baseline = heap();
  let max = baseline;
  const timer = setInterval(() => {
    const used = process.memoryUsage().heapUsed;
    if (used > max) max = used;
  }, 5);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return { peak: max - baseline, retained: heap() - baseline };
}

function expectBounded(m: { peak: number; retained: number }, label: string): void {
  // eslint-disable-next-line no-console
  console.log(`[memory] ${label}: ${ROWS.toLocaleString('en-US')} rows, peak +${(m.peak / MB).toFixed(1)} MB, retained +${(m.retained / MB).toFixed(1)} MB${gc ? '' : ' (no --expose-gc)'}`);
  expect(m.peak).toBeLessThan(PEAK_BOUND);
  if (gc) expect(m.retained).toBeLessThan(RETAINED_BOUND);
}

async function countLines(file: string): Promise<number> {
  let lines = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    const buf = chunk as Buffer;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
  }
  return lines;
}

let rt: Runtime;

beforeEach(() => {
  setupFakeDb();
});

afterEach(async () => {
  await teardown();
});

describe(`memory bounds (${ROWS.toLocaleString('en-US')} rows)`, () => {
  test('export_query streams a large result to a file', async () => {
    rt = makeRuntime();
    defineBig('select * from big');
    let out: { path: string; rowCount: number } = { path: '', rowCount: 0 };
    const m = await measure(async () => {
      out = jsonOf(await call(rt, 'export_query', { sql: 'select * from big', format: 'jsonl' }));
    });
    expect(out.rowCount).toBe(ROWS);
    expect(await countLines(out.path)).toBe(ROWS);
    expect(rt.exports.peakQueuedRows).toBeLessThanOrEqual(1_002);
    expectBounded(m, 'export_query');
  }, TIMEOUT);

  test('run_query spools a large result, and fetch_rows reads any offset', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 4 * 1024 * MB, spoolMaxTotalBytes: 8 * 1024 * MB });
    defineBig('select * from big');
    let id = '';
    const m = await measure(async () => {
      const first = jsonOf(await call(rt, 'run_query', { sql: 'select * from big', format: 'json' }));
      expect(first.totalRows).toBe(ROWS);
      id = first.resultId;
      await until(() => (rt.results.get(id) as SpoolSession).mode === 'spooled', TIMEOUT, 'spooling');
    });
    for (const offset of [0, Math.floor(ROWS / 2), ROWS - 5]) {
      const page = jsonOf(await call(rt, 'fetch_rows', { resultId: id, format: 'json', maxRows: 5, offset }));
      expect(page.rows[0][0]).toBe(offset);
    }
    expectBounded(m, 'run_query (spooled)');
  }, TIMEOUT);

  test('run_query keeps an open cursor for a result too large to spool; skipping ahead stays bounded', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 0 });
    defineBig('select * from big');
    const m = await measure(async () => {
      const first = jsonOf(await call(rt, 'run_query', { sql: 'select * from big', format: 'json' }));
      expect(first.totalRows).toBe(ROWS);
      const last = jsonOf(await call(rt, 'fetch_rows', { resultId: first.resultId, format: 'json', maxRows: 100, offset: ROWS - 10 }));
      expect(last.rows).toHaveLength(10);
      expect(last.rows[9][0]).toBe(ROWS - 1);
      expect(last.hasMore).toBe(false);
    });
    expect(rt.results.openCursorCount).toBe(0);
    expectBounded(m, 'run_query (open cursor)');
  }, TIMEOUT);

  test('run_query without a cursor counts every row for the exact total', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 8 * MB });
    defineBig('select * from big');
    let text = '';
    const m = await measure(async () => {
      text = textOf(await call(rt, 'run_query', { sql: 'begin; select * from big; commit' }));
    });
    expect(text).toContain(`${ROWS} rows returned.`);
    expect(text).toContain('this result is too large to page');
    expect(rt.results.spoolBytes).toBe(0);
    expectBounded(m, 'run_query (streaming)');
  }, TIMEOUT);
});
