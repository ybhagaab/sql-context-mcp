/**
 * Cursor reader (design Component 5).
 *
 * Validates: Requirements 8.1, 10.3
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { fakeDb, FakePool } from '../test/fake-pg';
import { Lease } from './lease';
import { detectEngine, __resetEngineCache } from './engine';
import { CursorReader, DeclareRejectedError, CURSOR_NAME } from './cursor';

beforeEach(() => {
  fakeDb.reset();
  __resetEngineCache();
});

async function setup() {
  const pool = new FakePool();
  const lease = await Lease.acquire(pool as never);
  const engine = await detectEngine(pool as never, lease);
  return { pool, lease, engine };
}

describe('CursorReader', () => {
  test('DECLARE + FETCH returns raw wire text in array rows, and close ends the transaction', async () => {
    fakeDb.define('select d, n from t', {
      columns: [{ name: 'd', oid: 1082 }, { name: 'n', oid: 1186 }],
      rows: [['2026-09-05', '1 day 02:00:00'], [null, '03:00:00'], ['2026-09-07', null]],
    });
    const { pool, lease, engine } = await setup();
    const reader = await CursorReader.open(lease, 'select d, n from t;', engine);
    expect(lease.transactionStatus).toBe('T');
    expect(await reader.fetch(2)).toEqual([['2026-09-05', '1 day 02:00:00'], [null, '03:00:00']]);
    expect(reader.fields).toEqual([{ name: 'd', dataTypeID: 1082 }, { name: 'n', dataTypeID: 1186 }]);
    expect(reader.exhausted).toBe(false);
    expect(await reader.fetch(2)).toEqual([['2026-09-07', null]]);
    expect(reader.exhausted).toBe(true);
    expect(reader.fetchedRows).toBe(3);
    await reader.close();
    expect(lease.transactionStatus).toBe('I');
    lease.release();
    expect(pool.idleCount).toBe(1);
    expect(fakeDb.statementsMatching(new RegExp(`^DECLARE ${CURSOR_NAME} CURSOR FOR select d, n from t$`))).toHaveLength(1);
  });

  test('the first FETCH waits for the query to finish executing', async () => {
    fakeDb.define('select slow', { columns: [{ name: 'x', oid: 23 }], rows: [['1']], delayMs: 60 });
    const { lease, engine } = await setup();
    const reader = await CursorReader.open(lease, 'select slow', engine);
    const started = Date.now();
    await reader.fetch(10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    await reader.close();
    lease.release();
  });

  test('a rejected DECLARE (for example SELECT INTO) rolls back and reports DeclareRejectedError', async () => {
    fakeDb.define('select * into new_t from t', { columns: [{ name: 'x', oid: 23 }], rows: [], rejectDeclare: true });
    const { lease, engine } = await setup();
    const err = await CursorReader.open(lease, 'select * into new_t from t', engine).catch((e) => e);
    expect(err).toBeInstanceOf(DeclareRejectedError);
    expect(lease.transactionStatus).toBe('I');
    lease.release();
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });

  test('PostgreSQL uses a SCROLL cursor', async () => {
    fakeDb.engine = 'postgres';
    fakeDb.define('select 1 as a', { columns: [{ name: 'a', oid: 23 }], rows: [['1']] });
    const { lease, engine } = await setup();
    const reader = await CursorReader.open(lease, 'select 1 as a', engine);
    await reader.close();
    lease.release();
    expect(fakeDb.statementsMatching(/^DECLARE mcp_c SCROLL CURSOR FOR select 1 as a$/)).toHaveLength(1);
  });

  test('abort rolls back an open cursor', async () => {
    fakeDb.define('select 1 as a', { columns: [{ name: 'a', oid: 23 }], rows: [['1'], ['2']] });
    const { lease, engine } = await setup();
    const reader = await CursorReader.open(lease, 'select 1 as a', engine);
    await reader.fetch(1);
    await reader.abort();
    expect(lease.transactionStatus).toBe('I');
    lease.release();
  });
});
