/**
 * Streaming executor (design Component 5b).
 *
 * Validates: Requirements 2.1, 5.1, 5.2, 8.1, 8.3, 9.2
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { fakeDb, FakePool } from '../test/fake-pg';
import { Lease, QueryCancelledError } from './lease';
import { streamQuery } from './stream';

beforeEach(() => fakeDb.reset());

function lazyRows(count: number) {
  return () => (function* () { for (let i = 0; i < count; i++) yield [String(i), `name-${i}`]; })();
}

describe('streamQuery', () => {
  test('streams every row without collecting them and reports statement results', async () => {
    fakeDb.define('select id, name from big', { columns: [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }], rows: lazyRows(20_000), rowCount: 20_000 });
    const lease = await Lease.acquire(new FakePool() as never);
    let count = 0;
    let lastRow: unknown[] = [];
    const outcome = await streamQuery(lease, 'select id, name from big', {
      onRow: (row) => { count++; lastRow = row; },
    });
    expect(count).toBe(20_000);
    expect(lastRow).toEqual(['19999', 'name-19999']);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ command: 'SELECT', streamedIndex: 0, fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 1043 }] });
    lease.release();
  });

  test('scripts report every statement, and rows carry the index of their result set', async () => {
    fakeDb.define('select a from one', { columns: [{ name: 'a', oid: 23 }], rows: [['1'], ['2']] });
    fakeDb.define('select b from two', { columns: [{ name: 'b', oid: 23 }], rows: [['3']] });
    fakeDb.define('select c from empty', { columns: [{ name: 'c', oid: 23 }], rows: [] });
    const lease = await Lease.acquire(new FakePool() as never);
    const seen: Array<[number, unknown[]]> = [];
    const starts: number[] = [];
    const outcome = await streamQuery(lease, "set search_path to 'x'; select a from one; select b from two; select c from empty", {
      onResultSet: (_fields, index) => starts.push(index),
      onRow: (row, index) => seen.push([index, row]),
    });
    expect(starts).toEqual([0, 1]);
    expect(seen).toEqual([[0, ['1']], [0, ['2']], [1, ['3']]]);
    expect(outcome.results.map((r) => r.command)).toEqual(['SET', 'SELECT', 'SELECT', 'SELECT']);
    expect(outcome.results.map((r) => r.streamedIndex)).toEqual([null, 0, 1, null]);
    expect(outcome.results[3].fields).toEqual([{ name: 'c', dataTypeID: 23 }]);
    lease.markDiscard();
    lease.release();
  });

  test('backpressure pauses the socket until the consumer resumes', async () => {
    fakeDb.define('select id, name from big', { columns: [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }], rows: lazyRows(2_000), rowCount: 2_000 });
    const lease = await Lease.acquire(new FakePool() as never);
    const stream = (lease.client as any).connection.stream;
    let count = 0;
    let pausedAt = -1;
    const done = streamQuery(lease, 'select id, name from big', {
      onRow: (_row, _i, control) => {
        count++;
        if (count === 500) {
          control.pause();
          pausedAt = count;
          setTimeout(() => control.resume(), 20);
        }
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stream.paused).toBe(true);
    expect(count).toBe(pausedAt);
    await done;
    expect(count).toBe(2_000);
    expect(stream.paused).toBe(false);
    lease.release();
  });

  test('cancelling while paused resumes the socket and ends the stream with a cancellation', async () => {
    fakeDb.define('select id, name from big', { columns: [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }], rows: lazyRows(5_000), rowCount: 5_000 });
    const lease = await Lease.acquire(new FakePool() as never);
    const controller = new AbortController();
    const done = streamQuery(lease, 'select id, name from big', {
      onRow: (_row, _i, control) => {
        if (!controller.signal.aborted) {
          control.pause();
          setTimeout(() => controller.abort(), 10);
        }
      },
    }, { signal: controller.signal });
    await expect(done).rejects.toBeInstanceOf(QueryCancelledError);
    lease.release();
  });

  test('SQL errors reject with the database error', async () => {
    const lease = await Lease.acquire(new FakePool() as never);
    await expect(streamQuery(lease, 'select * from missing_table', { onRow: () => undefined })).rejects.toMatchObject({ code: '42P01' });
    lease.release();
  });
});
