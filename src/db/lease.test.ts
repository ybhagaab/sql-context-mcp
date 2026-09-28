/**
 * Connection leases (design Component 4).
 *
 * Property 9: Connection hygiene - a connection returns to the pool only if it is idle (not in a
 * transaction) and ran no session-changing statement; otherwise it is destroyed.
 * Property 10 (lease level): cancellation and timeouts cancel the running query and release it.
 *
 * Validates: Requirements 6.1, 6.2, 8.2, 9.3
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { fakeDb, FakePool } from '../test/fake-pg';
import { Lease, QueryCancelledError, QueryTimeoutError } from './lease';
import { classifyStatement } from '../sql/classify';

beforeEach(() => {
  fakeDb.reset();
  Lease.cancelGraceMs = 30;
});

describe('Property 9: connection hygiene', () => {
  const stepArb = fc.constantFrom('select 1', "set search_path to 'x'", 'begin', 'commit', 'rollback', 'insert into t values (1)', 'select broken');

  test('connections go back to the pool only when idle and free of session changes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.array(stepArb, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 6 }), async (sessions) => {
        fakeDb.reset();
        fakeDb.define('insert into t values (1)', { command: 'INSERT', rowCount: 1 });
        fakeDb.define('select broken', { columns: [{ name: 'x', oid: 23 }], error: Object.assign(new Error('division by zero'), { code: '22012' }) });
        const pool = new FakePool({ max: 3 });
        for (const steps of sessions) {
          const lease = await Lease.acquire(pool as never);
          for (const sql of steps) {
            if (classifyStatement(sql).changesSession) lease.markDiscard();
            await lease.query(sql).catch(() => undefined);
          }
          lease.release();
        }
        expect(fakeDb.leakedTransactions()).toHaveLength(0);
        expect(fakeDb.leakedSessionState()).toHaveLength(0);
        expect(pool.checkedOutCount).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  test('a lease released inside a transaction destroys its connection', async () => {
    const pool = new FakePool({ max: 1 });
    const lease = await Lease.acquire(pool as never);
    await lease.query('BEGIN');
    expect(lease.transactionStatus).toBe('T');
    lease.release();
    expect(pool.idleCount).toBe(0);
    expect(pool.totalCount).toBe(0);
  });

  test('an idle, clean lease returns its connection to the pool', async () => {
    const pool = new FakePool({ max: 1 });
    const lease = await Lease.acquire(pool as never);
    await lease.query('select 1');
    lease.release();
    lease.release(); // idempotent
    expect(pool.idleCount).toBe(1);
  });
});

describe('cancellation and timeouts', () => {
  test('a timeout cancels the query with a protocol cancel and reports a timeout', async () => {
    fakeDb.define('select slow', { columns: [{ name: 'x', oid: 23 }], rows: [['1']], delayMs: 10_000 });
    const pool = new FakePool();
    const lease = await Lease.acquire(pool as never);
    const err = await lease.query('select slow', { timeoutMs: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect(err.message).toContain('40');
    expect(fakeDb.cancelRequests).toEqual([{ pid: lease.processID, via: 'protocol' }]);
    lease.release();
  });

  test('an abort signal cancels a running query', async () => {
    fakeDb.define('select slow', { columns: [{ name: 'x', oid: 23 }], rows: [['1']], delayMs: 10_000 });
    const lease = await Lease.acquire(new FakePool() as never);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(lease.query('select slow', { signal: controller.signal })).rejects.toBeInstanceOf(QueryCancelledError);
    lease.release();
  });

  test('falls back to pg_cancel_backend when the protocol cancel has no effect', async () => {
    fakeDb.define('select slow', { columns: [{ name: 'x', oid: 23 }], rows: [['1']], delayMs: 10_000 });
    fakeDb.protocolCancelWorks = false;
    const lease = await Lease.acquire(new FakePool() as never);
    await expect(lease.query('select slow', { timeoutMs: 20 })).rejects.toBeInstanceOf(QueryTimeoutError);
    expect(fakeDb.cancelRequests.map((r) => r.via)).toEqual(['protocol', 'sql']);
    lease.release();
  });

  test('cancellation works while every pool connection is in use', async () => {
    fakeDb.define('select slow', { columns: [{ name: 'x', oid: 23 }], rows: [['1']], delayMs: 10_000 });
    const pool = new FakePool({ max: 1 });
    const lease = await Lease.acquire(pool as never);
    const running = lease.query('select slow', { timeoutMs: 20 });
    await expect(running).rejects.toBeInstanceOf(QueryTimeoutError);
    expect(pool.waitingCount).toBe(0);
    lease.release();
  });

  test('aborting while waiting for a connection releases the connection when it arrives', async () => {
    const pool = new FakePool({ max: 1 });
    const holder = await Lease.acquire(pool as never);
    const controller = new AbortController();
    const waiting = Lease.acquire(pool as never, { signal: controller.signal });
    expect(pool.waitingCount).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(QueryCancelledError);
    holder.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.checkedOutCount).toBe(0);
    expect(pool.idleCount).toBe(1);
  });

  test('an already-aborted signal fails fast', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(Lease.acquire(new FakePool() as never, { signal: controller.signal })).rejects.toBeInstanceOf(QueryCancelledError);
  });
});
