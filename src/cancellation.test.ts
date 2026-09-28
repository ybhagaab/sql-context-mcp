/**
 * Cancellation and timeouts, end to end (Task 18).
 *
 * Property 10: For any cancellation, timeout or low-disk stop, in any phase (waiting, executing,
 * reading, spooling, exporting), the database query is cancelled if it is running and the lease
 * is released. No .part file and no open-cursor session remain.
 *
 * Validates: Requirements 5.6, 6.1, 6.2, 7.6, 9.3
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import fc from 'fast-check';

vi.mock('pg', async () => (await import('./test/fake-pg')).fakePgModule);

import { fakeDb, FakePool, FakeColumn } from './test/fake-pg';
import { setupFakeDb, makeRuntime, teardown, call, textOf, jsonOf, lazyRows, until } from './test/harness';
import { Lease } from './db/lease';
import type { Runtime } from './runtime';
import type { CursorSession, SpoolSession } from './results/store';

const ID_NAME: FakeColumn[] = [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }];

let pool: FakePool;
let rt: Runtime;

beforeEach(() => {
  pool = setupFakeDb();
  rt = makeRuntime();
});

afterEach(async () => {
  await teardown();
});

/** Property 10's end state. */
async function expectClean(runtime: Runtime, p: FakePool = pool): Promise<void> {
  await until(() => p.checkedOutCount === 0, 3_000, 'connections released');
  expect(runtime.results.openCursorCount).toBe(0);
  expect(fakeDb.leakedTransactions()).toHaveLength(0);
  // The folders are created on first use.
  const parts = fs.existsSync(runtime.files.exportsDir) ? fs.readdirSync(runtime.files.exportsDir).filter((f) => f.endsWith('.part')) : [];
  expect(parts).toEqual([]);
}

describe('Property 10: cancellation in every phase', () => {
  test('waiting for a connection', async () => {
    pool = setupFakeDb(1);
    rt = makeRuntime();
    fakeDb.define('select id, name from t', { columns: ID_NAME, rows: lazyRows(3) });
    const holder = await Lease.acquire(pool as never);
    const controller = new AbortController();
    const pending = call(rt, 'run_query', { sql: 'select id, name from t' }, { signal: controller.signal });
    await until(() => pool.waitingCount === 1, 2_000, 'queued for a connection');
    controller.abort();
    const result = await pending;
    expect(textOf(result)).toBe('Error: The query was cancelled.');
    holder.release();
    await expectClean(rt);
    expect(pool.idleCount).toBe(1);
    expect(fakeDb.statementsMatching(/^DECLARE/)).toHaveLength(0);
  });

  test('executing on the database', async () => {
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(3), delayMs: 10_000 });
    const controller = new AbortController();
    const pending = call(rt, 'run_query', { sql: 'select id, name from slow' }, { signal: controller.signal });
    await until(() => fakeDb.log.some((s) => s.startsWith('FETCH')), 2_000, 'first fetch');
    const pid = pool.all[0].processID;
    controller.abort();
    expect(textOf(await pending)).toBe('Error: The query was cancelled.');
    expect(fakeDb.cancelRequests).toEqual([{ pid, via: 'protocol' }]);
    await expectClean(rt);
    // A cancelled connection is not reused.
    expect(pool.idleCount).toBe(0);
  });

  test('executing, when the protocol cancel has no effect: pg_cancel_backend is the fallback', async () => {
    fakeDb.protocolCancelWorks = false;
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(3), delayMs: 10_000 });
    const controller = new AbortController();
    const pending = call(rt, 'run_query', { sql: 'select id, name from slow' }, { signal: controller.signal });
    await until(() => fakeDb.log.some((s) => s.startsWith('FETCH')), 2_000, 'first fetch');
    controller.abort();
    expect(textOf(await pending)).toBe('Error: The query was cancelled.');
    expect(fakeDb.cancelRequests.map((r) => r.via)).toEqual(['protocol', 'sql']);
    await expectClean(rt);
  });

  test('reading a page of an open-cursor result', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 0 });
    fakeDb.define('select id, name from big', { columns: ID_NAME, rows: lazyRows(1_000), rowCount: 1_000 });
    const first = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json' }));
    const session = rt.results.get(first.resultId) as CursorSession;
    expect(session.kind).toBe('cursor');
    (fakeDb.resolve('select id, name from big') as { fetchDelayMs?: number }).fetchDelayMs = 10_000;
    const controller = new AbortController();
    const pending = call(rt, 'fetch_rows', { resultId: first.resultId, maxRows: 500 }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    expect(textOf(await pending)).toBe('Error: The query was cancelled.');
    expect(session.mode).toBe('failed');
    await expectClean(rt);
    const again = await call(rt, 'fetch_rows', { resultId: first.resultId });
    expect(textOf(again)).toContain('reading it failed: The query was cancelled.');
  });

  test('spooling in the background, stopped by server shutdown', async () => {
    fakeDb.define('select id, name from big', { columns: ID_NAME, rows: lazyRows(20_000), rowCount: 20_000 });
    const first = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json' }));
    const session = rt.results.get(first.resultId) as SpoolSession;
    (fakeDb.resolve('select id, name from big') as { fetchDelayMs?: number }).fetchDelayMs = 10_000;
    await until(() => fakeDb.log.filter((s) => s.startsWith('FETCH')).length >= 2, 2_000, 'background fetch');
    await rt.results.closeAll();
    expect(session.mode).toBe('closed');
    await expectClean(rt);
    await until(() => fs.readdirSync(rt.files.spoolDir).length === 0, 2_000, 'spool file removed');
    expect(fakeDb.cancelRequests.length).toBeGreaterThanOrEqual(1);
  });

  test('exporting', async () => {
    fakeDb.define('select id, name from big', { columns: ID_NAME, rows: lazyRows(2_000_000), rowCount: 2_000_000 });
    const { exportId } = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from big', wait: false }));
    await until(() => (rt.exports.get(exportId)?.rowsWritten ?? 0) > 10_000, 5_000, 'rows written');
    const status = jsonOf(await call(rt, 'export_status', { exportId, cancel: true }));
    expect(status.state).toBe('cancelled');
    expect(fakeDb.cancelRequests.length).toBeGreaterThanOrEqual(1);
    await expectClean(rt);
    expect(fs.readdirSync(rt.files.exportsDir)).toEqual([]);
  }, 30_000);

  test('for any cancellation moment, the end state is clean', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 60 }),
        fc.constantFrom('select id, name from slow', 'begin; select id, name from slow; commit', "set search_path to 'x'; select id, name from slow"),
        fc.constantFrom<'table' | 'json'>('table', 'json'),
        async (abortAfter, sql, format) => {
          pool = setupFakeDb();
          rt = makeRuntime({ spoolThresholdBytes: abortAfter % 2 === 0 ? 0 : 100 * 1024 * 1024 });
          fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(400), rowCount: 400, delayMs: 25 });
          const controller = new AbortController();
          const pending = call(rt, 'run_query', { sql, format }, { signal: controller.signal });
          setTimeout(() => controller.abort(), abortAfter);
          const result = await pending;
          const text = textOf(result);
          if (result.isError) expect(text).toBe('Error: The query was cancelled.');
          await rt.results.closeAll();
          await expectClean(rt);
          await teardown();
        },
      ),
      { numRuns: 30 },
    );
  }, 120_000);
});

describe('timeouts', () => {
  test('a per-call timeoutMs cancels the query and says so', async () => {
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(3), delayMs: 10_000 });
    const result = await call(rt, 'run_query', { sql: 'select id, name from slow', timeoutMs: 50 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: The query exceeded timeoutMs=50 and was cancelled.');
    expect(fakeDb.cancelRequests).toHaveLength(1);
    await expectClean(rt);
  });

  test('SQL_STATEMENT_TIMEOUT_MS is the default, and timeoutMs: 0 turns it off for one call', async () => {
    rt = makeRuntime({ statementTimeoutMs: 50 });
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(3), delayMs: 150 });
    expect(textOf(await call(rt, 'run_query', { sql: 'select id, name from slow' }))).toBe('Error: The query exceeded timeoutMs=50 and was cancelled.');
    expect(textOf(await call(rt, 'run_query', { sql: 'select id, name from slow', timeoutMs: 0 }))).toContain('3 rows returned.');
    await expectClean(rt);
  });

  test('the timeout applies per statement in a script', async () => {
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(3), delayMs: 80 });
    const out = textOf(await call(rt, 'run_query', { sql: "set search_path to 'x'; select id, name from slow", timeoutMs: 120 }));
    expect(out).toContain('3 rows returned.');
  });

  test('an open-cursor page read that exceeds the timeout fails the result and frees its slot', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 0 });
    fakeDb.define('select id, name from big', { columns: ID_NAME, rows: lazyRows(1_000), rowCount: 1_000 });
    const first = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json', timeoutMs: 100 }));
    (fakeDb.resolve('select id, name from big') as { fetchDelayMs?: number }).fetchDelayMs = 10_000;
    const result = await call(rt, 'fetch_rows', { resultId: first.resultId, maxRows: 500 });
    expect(textOf(result)).toBe('Error: The query exceeded timeoutMs=100 and was cancelled.');
    await expectClean(rt);
  });

  test('an export that exceeds its timeout fails and leaves no file', async () => {
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(3), delayMs: 10_000 });
    const result = await call(rt, 'export_query', { sql: 'select id, name from slow', timeoutMs: 50 });
    expect(textOf(result)).toBe('Error: The query exceeded timeoutMs=50 and was cancelled.');
    await expectClean(rt);
    expect(fs.readdirSync(rt.files.exportsDir)).toEqual([]);
  });

  test('the folders are only created when a spool or export needs them', async () => {
    fakeDb.define('select id, name from t', { columns: ID_NAME, rows: lazyRows(3) });
    await call(rt, 'run_query', { sql: 'select id, name from t' });
    expect(fs.existsSync(rt.files.processDir)).toBe(false);
  });
});
