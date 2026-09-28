/**
 * Sanity tests for the fake pg module, so the tests built on top of it rest on verified behavior.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { fakeDb, FakePool, FakeClient, FakeQuery, connectionError } from './fake-pg';

const RAW = { getTypeParser: () => (v: string) => v };

beforeEach(() => fakeDb.reset());

describe('fake pg', () => {
  test('promise queries honor rowMode array and per-query types', async () => {
    fakeDb.define('select d, n from t', {
      columns: [{ name: 'd', oid: 1082 }, { name: 'n', oid: 23 }],
      rows: [['2026-09-05', '1'], [null, '2']],
    });
    const pool = new FakePool({ max: 2 });
    const raw: any = await pool.query({ text: 'select d, n from t', rowMode: 'array', types: RAW });
    expect(raw.rows).toEqual([['2026-09-05', '1'], [null, '2']]);
    expect(raw.rowCount).toBeNull(); // Redshift SELECT tag carries no count
    const parsed: any = await pool.query('select d, n from t');
    expect(parsed.rows[0].d).toBeInstanceOf(Date);
    expect(parsed.rows[0].n).toBe(1);
  });

  test('multi-statement simple queries return an array of results', async () => {
    fakeDb.define('select 2 as b', { columns: [{ name: 'b', oid: 23 }], rows: [['2']] });
    const client = await new FakePool().connect();
    const results: any = await client.query("set search_path to 'x'; select 2 as b");
    expect(Array.isArray(results)).toBe(true);
    expect(results.map((r: any) => r.command)).toEqual(['SET', 'SELECT']);
  });

  test('cursor flow: DECLARE, FETCH, totals from stv_active_cursors, transaction status events', async () => {
    fakeDb.define('select x from big', { columns: [{ name: 'x', oid: 23 }], rows: Array.from({ length: 10 }, (_, i) => [String(i)]) });
    const client = await new FakePool().connect();
    const statuses: string[] = [];
    client.connection.on('readyForQuery', (m: any) => statuses.push(m.status));
    await client.query('BEGIN');
    await client.query('DECLARE mcp_c CURSOR FOR select x from big');
    const first: any = await client.query({ text: 'FETCH FORWARD 4 FROM mcp_c', rowMode: 'array', types: RAW });
    expect(first.rows).toEqual([['0'], ['1'], ['2'], ['3']]);
    const totals: any = await client.query('select row_count, byte_count from stv_active_cursors where pid = pg_backend_pid()');
    expect(totals.rows[0].row_count).toBe('10');
    const rest: any = await client.query({ text: 'FETCH FORWARD 100 FROM mcp_c', rowMode: 'array', types: RAW });
    expect(rest.rows).toHaveLength(6);
    await client.query('CLOSE mcp_c');
    await client.query('END');
    expect(statuses[0]).toBe('T');
    expect(statuses[statuses.length - 1]).toBe('I');
  });

  test('streaming queries emit rows without collecting them and honor pause/resume', async () => {
    fakeDb.define('select x from many', { columns: [{ name: 'x', oid: 23 }], rows: () => (function* () { for (let i = 0; i < 1000; i++) yield [String(i)]; })(), rowCount: 1000 });
    const client = await new FakePool().connect();
    const q = new FakeQuery({ text: 'select x from many', rowMode: 'array', types: RAW });
    let seen = 0;
    let pausedOnce = false;
    const done = new Promise<any>((resolve, reject) => {
      q.on('row', () => {
        seen++;
        if (seen === 100 && !pausedOnce) {
          pausedOnce = true;
          client.connection.stream.pause();
          setTimeout(() => client.connection.stream.resume(), 5);
        }
      });
      q.on('end', resolve);
      q.on('error', reject);
    });
    client.query(q);
    const result = await done;
    expect(seen).toBe(1000);
    expect(result.rows).toEqual([]);
    expect(result.fields[0].name).toBe('x');
  });

  test('protocol cancel interrupts a running query with SQLSTATE 57014', async () => {
    fakeDb.define('select slow', { columns: [{ name: 'x', oid: 23 }], rows: [['1']], delayMs: 10_000 });
    const client = await new FakePool().connect();
    const running = client.query('select slow') as Promise<unknown>;
    await new Promise((r) => setTimeout(r, 5));
    expect(client.activeQuery).toBeTruthy();
    new FakeClient().cancel(client, client.activeQuery);
    await expect(running).rejects.toMatchObject({ code: '57014' });
    expect(fakeDb.cancelRequests).toEqual([{ pid: client.processID, via: 'protocol' }]);
  });

  test('connection faults break the client and pools queue waiters at max', async () => {
    fakeDb.define('select 1 as a', { columns: [{ name: 'a', oid: 23 }], rows: [['1']] });
    fakeDb.failWhen('select 1 as a', connectionError());
    const pool = new FakePool({ max: 1 });
    const c1 = await pool.connect();
    await expect(c1.query('select 1 as a')).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(c1.broken).toBe(true);
    const waiting = pool.connect();
    expect(pool.waitingCount).toBe(1);
    c1.release();
    const c2 = await waiting;
    expect(c2).not.toBe(c1);
    expect(c1.destroyed).toBe(true);
  });
});
