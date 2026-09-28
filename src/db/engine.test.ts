/**
 * Engine adapter (design Component 2).
 *
 * Property 6 (engine level): the reported total equals the true row count for any result size,
 * on Redshift (stv_active_cursors) and PostgreSQL (SCROLL cursor + MOVE); unknown when the engine
 * can't provide it.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 10.5
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { fakeDb, FakePool } from '../test/fake-pg';
import { Lease } from './lease';
import { detectEngine, cursorTotals, fetchBatchSize, __resetEngineCache } from './engine';
import { CursorReader } from './cursor';

beforeEach(() => {
  fakeDb.reset();
  __resetEngineCache();
});

async function leaseOn(pool: FakePool): Promise<Lease> {
  return Lease.acquire(pool as never);
}

describe('engine detection', () => {
  test('Redshift, multi-node, with stv totals', async () => {
    const pool = new FakePool();
    const lease = await leaseOn(pool);
    const engine = await detectEngine(pool as never, lease);
    expect(engine).toEqual({ kind: 'redshift', singleNode: false, totalsFromStv: true });
    expect(fetchBatchSize(5000, engine)).toBe(5000);
    lease.release();
  });

  test('single-node Redshift caps FETCH at 1,000 rows', async () => {
    fakeDb.nodes = 1;
    const pool = new FakePool();
    const lease = await leaseOn(pool);
    const engine = await detectEngine(pool as never, lease);
    expect(engine.singleNode).toBe(true);
    expect(fetchBatchSize(5000, engine)).toBe(1000);
    lease.release();
  });

  test('Redshift without stv_active_cursors access reports totals as unavailable', async () => {
    fakeDb.stvAllowed = false;
    const pool = new FakePool();
    const lease = await leaseOn(pool);
    expect((await detectEngine(pool as never, lease)).totalsFromStv).toBe(false);
    expect(lease.transactionStatus).toBe('I');
    lease.release();
  });

  test('PostgreSQL is detected from version()', async () => {
    fakeDb.engine = 'postgres';
    const pool = new FakePool();
    const lease = await leaseOn(pool);
    expect(await detectEngine(pool as never, lease)).toEqual({ kind: 'postgres', singleNode: false, totalsFromStv: false });
    lease.release();
  });

  test('detection runs once per pool', async () => {
    const pool = new FakePool();
    const lease = await leaseOn(pool);
    await detectEngine(pool as never, lease);
    await detectEngine(pool as never, lease);
    expect(fakeDb.statementsMatching(/^select version\(\)$/)).toHaveLength(1);
    lease.release();
  });
});

describe('Property 6 (engine level): exact totals', () => {
  test('totals equal the true row count on Redshift and PostgreSQL, for any size and position', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'redshift' | 'postgres'>('redshift', 'postgres'),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 1, max: 500 }),
        async (engineKind, total, firstFetch) => {
          fakeDb.reset();
          __resetEngineCache();
          fakeDb.engine = engineKind;
          fakeDb.define('select n from nums', {
            columns: [{ name: 'n', oid: 23 }],
            rows: () => (function* () { for (let i = 0; i < total; i++) yield [String(i)]; })(),
            rowCount: total,
          });
          const pool = new FakePool();
          const lease = await leaseOn(pool);
          const engine = await detectEngine(pool as never, lease);
          const reader = await CursorReader.open(lease, 'select n from nums', engine);
          const first = await reader.fetch(firstFetch);
          const totals = await cursorTotals(lease, engine, reader.fetchedRows);
          expect(totals.totalRows).toBe(total);
          // The cursor position is unchanged: the next fetch continues right after the first batch.
          const next = await reader.fetch(1);
          if (first.length < total) expect(next).toEqual([[String(first.length)]]);
          else expect(next).toEqual([]);
          await reader.close();
          lease.release();
          expect(fakeDb.leakedTransactions()).toHaveLength(0);
        },
      ),
      { numRuns: 60 },
    );
  });

  test('Redshift without stv access gives an unknown total', async () => {
    fakeDb.stvAllowed = false;
    fakeDb.define('select n from nums', { columns: [{ name: 'n', oid: 23 }], rows: [['1'], ['2']] });
    const pool = new FakePool();
    const lease = await leaseOn(pool);
    const engine = await detectEngine(pool as never, lease);
    const reader = await CursorReader.open(lease, 'select n from nums', engine);
    await reader.fetch(1);
    expect(await cursorTotals(lease, engine, reader.fetchedRows)).toEqual({ totalRows: null, totalBytes: null });
    await reader.close();
    lease.release();
  });
});
