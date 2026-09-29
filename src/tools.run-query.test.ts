/**
 * run_query, fetch_rows, get_sample_data and the catalog tools, end to end against the fake
 * database (Task 15).
 *
 * Validates: Requirements 1.1-1.7, 2.1-2.3, 3.1, 3.8, 4.1-4.5, 8.1, 8.4, 10.1, 10.2
 * Properties: 1 (page budget, via the tools), 5 (legacy table look)
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pg', async () => (await import('./test/fake-pg')).fakePgModule);

import { fakeDb, FakePool, FakeColumn, FakeCell, connectionError } from './test/fake-pg';
import { setupFakeDb, makeRuntime, teardown, call, textOf, jsonOf, lazyRows, parseCsv, until } from './test/harness';
import { formatResults } from './results/legacy';
import type { Runtime } from './runtime';
import type { SpoolSession } from './results/store';

const ID_NAME: FakeColumn[] = [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }];
const RESULT_ID = /"resultId":"(r_[a-z2-7]{16})"/;

function define(sql: string, columns: FakeColumn[], rows: FakeCell[][] | (() => Iterable<FakeCell[]>), rowCount?: number): void {
  fakeDb.define(sql, { columns, rows, rowCount });
}

function numbered(count: number): () => Iterable<FakeCell[]> {
  return lazyRows(count);
}

function resultIdOf(text: string): string {
  const m = RESULT_ID.exec(text);
  if (!m) throw new Error(`no resultId in: ${text.slice(-400)}`);
  return m[1];
}

let pool: FakePool;
let rt: Runtime;

beforeEach(() => {
  pool = setupFakeDb();
  rt = makeRuntime();
});

afterEach(async () => {
  await teardown();
});

describe('run_query: table format keeps the legacy look', () => {
  test('a plain {sql} call renders exactly like 1.4.0, with the correct footer', async () => {
    define('select id, name from t', ID_NAME, [['1', 'alpha'], ['22', null], ['333', 'gamma']]);
    const out = textOf(await call(rt, 'run_query', { sql: 'select id, name from t' }));
    const legacy = formatResults({ columns: ['id', 'name'], rows: [[1, 'alpha'], [22, null], [333, 'gamma']], rowCount: 3, executionTime: 0 });
    expect(out.replace(/\(\d+ms\)/, '(0ms)')).toBe(legacy);
    expect(pool.checkedOutCount).toBe(0);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });

  test('a 200-row query shows 100 rows, "... (100 more rows)", a footer of 200, and continues with fetch_rows', async () => {
    define('select id, name from big', ID_NAME, numbered(200), 200);
    const out = textOf(await call(rt, 'run_query', { sql: 'select id, name from big;' }));
    const lines = out.split('\n');
    // Widths come from page 1's rows: the widest name is 'name-99' (7 characters).
    expect(lines[0]).toBe('id   | name   ');
    expect(lines.slice(2, 102).map((l) => l.split(' | ')[0].trim())).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    expect(lines[102]).toBe('... (100 more rows)');
    expect(lines[103]).toBe('');
    expect(lines[104]).toMatch(/^More rows: fetch_rows \{"resultId":"r_[a-z2-7]{16}"\}; full result: export_query$/);
    // The footer is the last line, as in 1.4.0.
    expect(lines[105]).toMatch(/^200 rows returned\. \(\d+ms\)$/);
    expect(lines).toHaveLength(106);
    const id = resultIdOf(out);

    const next = textOf(await call(rt, 'fetch_rows', { resultId: id }));
    const nextLines = next.split('\n');
    expect(nextLines.slice(2, 102).map((l) => l.split(' | ')[0].trim())).toEqual(Array.from({ length: 100 }, (_, i) => String(100 + i)));
    expect(next).toContain('\n\nRows 101–200 of 200.');
    expect(next).not.toContain('More rows');
    await until(() => pool.checkedOutCount === 0, 2_000, 'spool release');
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });

  test('a text parser written for 1.4.0 output still reads columns, rows and the total', async () => {
    // Parses the way 1.4.0 consumers do: rows after the separator until a blank line or the
    // "... (N more rows)" line, and the total from a footer anchored at the end of the text.
    const parse = (text: string) => {
      const lines = text.split('\n');
      const sep = lines.findIndex((l) => /^-+(?:-\+-+)*$/.test(l.trim()));
      const columns = lines[sep - 1].split(' | ').map((v) => v.trim());
      const rows: string[][] = [];
      for (const line of lines.slice(sep + 1)) {
        if (!line.trim() || /^\.\.\. \(\d+ more rows\)$/.test(line.trim()) || /^\d+ rows returned\./.test(line.trim())) break;
        rows.push(line.split(' | ').map((v) => v.trim()));
      }
      const count = /(?:^|\n)(\d+) rows returned\. \((\d+)ms\)\s*$/.exec(text);
      return { columns, rows, total: count ? Number(count[1]) : null };
    };
    define('select id, name from big', ID_NAME, numbered(250), 250);
    define('select id, name from t', ID_NAME, [['1', 'a'], ['2', 'b']]);
    const paged = parse(textOf(await call(rt, 'run_query', { sql: 'select id, name from big' })));
    expect(paged).toMatchObject({ columns: ['id', 'name'], total: 250 });
    expect(paged.rows).toHaveLength(100);
    const script = parse(textOf(await call(rt, 'run_query', { sql: "set search_path to 'x'; select id, name from t" })));
    expect(script).toEqual({ columns: ['id', 'name'], rows: [['1', 'a'], ['2', 'b']], total: 2 });
  });

  test('column widths come from the page rows, and wide later rows do not widen page 1', async () => {
    define('select id, name from w', ID_NAME, [['1', 'a'], ['2', 'b'], ['3', 'x'.repeat(500)]]);
    const out = textOf(await call(rt, 'run_query', { sql: 'select id, name from w', maxRows: 2 }));
    expect(out.split('\n')[0]).toBe('id   | name');
    expect(out).toContain('... (1 more rows)');
    expect(out).toContain('3 rows returned.');
  });
});

describe('run_query: maxRows, maxChars and the ceiling', () => {
  test('maxRows limits the page', async () => {
    define('select id, name from big', ID_NAME, numbered(200), 200);
    const page = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json', maxRows: 7 }));
    expect(page.rowCount).toBe(7);
    expect(page.totalRows).toBe(200);
    expect(page.hasMore).toBe(true);
  });

  test('maxChars ends the page at a row boundary within the budget', async () => {
    define('select id, name from wide', ID_NAME, lazyRows(300, (i) => [`${'w'.repeat(80)}-${i}`]), 300);
    const result = await call(rt, 'run_query', { sql: 'select id, name from wide', format: 'json', maxRows: 1_000, maxChars: 5_000 });
    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(5_000);
    const page = JSON.parse(text);
    expect(page.rowCount).toBeGreaterThan(10);
    expect(page.rowCount).toBeLessThan(100);
    expect(page.rows.map((r: unknown[]) => r[0])).toEqual(Array.from({ length: page.rowCount }, (_, i) => i));
    expect(page.totalRows).toBe(300);
  });

  test('maxChars above the ceiling is reduced to it', async () => {
    rt = makeRuntime({ maxInlineCharsCeiling: 20_000 });
    define('select id, name from wide', ID_NAME, lazyRows(2_000, (i) => [`${'w'.repeat(80)}-${i}`]), 2_000);
    const text = textOf(await call(rt, 'run_query', { sql: 'select id, name from wide', format: 'csv', maxRows: 1_000_000, maxChars: 10_000_000 }));
    expect(text.length).toBeLessThanOrEqual(20_000);
  });

  test('a single row larger than the ceiling is an error that points to export_query', async () => {
    rt = makeRuntime({ maxInlineCharsCeiling: 5_000 });
    define('select id, name from huge', ID_NAME, [['1', 'h'.repeat(6_000)]]);
    const result = await call(rt, 'run_query', { sql: 'select id, name from huge' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: A single row needs \d+ characters, more than the 5000-character limit for one response\. Use export_query for this result\.$/);
    expect(pool.checkedOutCount).toBe(0);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });

  test('invalid arguments are validation errors', async () => {
    for (const args of [{ sql: 'select 1', maxRows: 0 }, { sql: 'select 1', maxChars: 999 }, { sql: 'select 1', format: 'xml' }, { sql: 'select 1', timeoutMs: -1 }]) {
      const result = await call(rt, 'run_query', args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Validation Error: /);
    }
  });
});

describe('run_query: json and csv', () => {
  test('json carries the fields client programs rely on, with exact values and paging metadata', async () => {
    define('select id, name from big', ID_NAME, numbered(250), 250);
    const page = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json' }));
    expect(Object.keys(page)).toEqual(['columns', 'rows', 'rowCount', 'offset', 'totalRows', 'hasMore', 'truncated', 'resultId', 'executionTimeMs']);
    expect(page.columns).toEqual([{ name: 'id', type: 'int4' }, { name: 'name', type: 'varchar' }]);
    expect(page.rows[0]).toEqual([0, 'name-0']);
    expect(page).toMatchObject({ rowCount: 100, offset: 0, totalRows: 250, hasMore: true, truncated: true });
    expect(page.resultId).toMatch(/^r_[a-z2-7]{16}$/);
    const next = jsonOf(await call(rt, 'fetch_rows', { resultId: page.resultId, format: 'json', maxRows: 200 }));
    expect(next).toMatchObject({ rowCount: 150, offset: 100, totalRows: 250, hasMore: false, truncated: false, resultId: null });
    expect(next.rows[149]).toEqual([249, 'name-249']);
  });

  test('csv returns the data and the status as two text blocks', async () => {
    define('select id, name from big', ID_NAME, numbered(250), 250);
    const result = await call(rt, 'run_query', { sql: 'select id, name from big', format: 'csv' });
    expect(result.content).toHaveLength(2);
    const rows = parseCsv(textOf(result, 0));
    expect(rows[0].map((f) => f.value)).toEqual(['id', 'name']);
    expect(rows).toHaveLength(101);
    expect(rows[100].map((f) => f.value)).toEqual(['99', 'name-99']);
    const status = textOf(result, 1).split('\n');
    expect(status[0]).toMatch(/^Rows 1–100 of 250\. \(\d+ms\)$/);
    expect(status[1]).toMatch(/^More rows: fetch_rows \{"resultId":"r_[a-z2-7]{16}"\}; full result: export_query$/);
  });

  test('exact values: DATE, NULL versus \'NULL\', separators, duplicate columns, INTERVAL, int8, numeric, bool, NaN', async () => {
    const columns: FakeColumn[] = [
      { name: 'd', oid: 1082 }, { name: 'n', oid: 1043 }, { name: 'n', oid: 1043 }, { name: 'sep', oid: 1043 },
      { name: '1', oid: 1186 }, { name: 'big', oid: 20 }, { name: 'num', oid: 1700 }, { name: 'ok', oid: 16 }, { name: 'f', oid: 701 },
    ];
    define('select * from exact', columns, [
      ['2026-09-05', null, 'NULL', 'a | b, "c"\nd', '1 day 02:00:00', '9007199254740993', '1.10', 't', 'NaN'],
    ]);
    const json = jsonOf(await call(rt, 'run_query', { sql: 'select * from exact', format: 'json' }));
    expect(json.columns.map((c: { name: string }) => c.name)).toEqual(['d', 'n', 'n', 'sep', '1', 'big', 'num', 'ok', 'f']);
    expect(json.columns.map((c: { type: string }) => c.type)).toEqual(['date', 'varchar', 'varchar', 'varchar', 'interval', 'int8', 'numeric', 'bool', 'float8']);
    expect(json.rows).toEqual([['2026-09-05', null, 'NULL', 'a | b, "c"\nd', '1 day 02:00:00', '9007199254740993', '1.10', true, 'NaN']]);

    const csv = parseCsv(textOf(await call(rt, 'run_query', { sql: 'select * from exact', format: 'csv' }), 0));
    expect(csv[1]).toEqual([
      { value: '2026-09-05', quoted: false }, { value: '', quoted: false }, { value: 'NULL', quoted: false },
      { value: 'a | b, "c"\nd', quoted: true }, { value: '1 day 02:00:00', quoted: false }, { value: '9007199254740993', quoted: false },
      { value: '1.10', quoted: false }, { value: 'true', quoted: false }, { value: 'NaN', quoted: false },
    ]);

    const table = textOf(await call(rt, 'run_query', { sql: 'select * from exact' }));
    expect(table).toContain('1 day 02:00:00');
    expect(table).not.toContain('[object Object]');
    expect(table.split('\n')[0].split(' | ')).toHaveLength(9);
  });

  test('hidden characters are stripped from inline values in every format', async () => {
    define('select id, name from h', ID_NAME, [['1', 'a\u200Bb\u0007c']]);
    expect(jsonOf(await call(rt, 'run_query', { sql: 'select id, name from h', format: 'json' })).rows[0][1]).toBe('abc');
    expect(textOf(await call(rt, 'run_query', { sql: 'select id, name from h', format: 'csv' }))).toBe('id,name\n1,abc');
    expect(textOf(await call(rt, 'run_query', { sql: 'select id, name from h' }))).toContain('abc');
  });

  test('types that are not built in are named from pg_type', async () => {
    define('select s from sup', [{ name: 's', oid: 4000 }], [['{"a":1}']]);
    const json = jsonOf(await call(rt, 'run_query', { sql: 'select s from sup', format: 'json' }));
    expect(json.columns).toEqual([{ name: 's', type: 'super' }]);
    expect(json.rows).toEqual([['{"a":1}']]);
  });
});

describe('run_query: scripts', () => {
  test('earlier statements run first on the same connection, and are listed', async () => {
    define('select id, name from t', ID_NAME, [['1', 'a']]);
    const out = textOf(await call(rt, 'run_query', { sql: "set search_path to 'x'; select id, name from t" }));
    expect(out).toMatch(/\n\nEarlier statements: SET\n1 rows returned\. \(\d+ms\)$/);
    expect(fakeDb.leakedSessionState()).toHaveLength(0);
    expect(pool.idleCount).toBe(0);
    const json = jsonOf(await call(rt, 'run_query', { sql: "set search_path to 'x'; select id, name from t", format: 'json' }));
    expect(json.statements).toEqual(['SET']);
  });

  test('the last result is shown; earlier row sets are counted', async () => {
    define('select a from one', [{ name: 'a', oid: 23 }], [['1'], ['2']]);
    define('select b from two', [{ name: 'b', oid: 23 }], [['3']]);
    const out = textOf(await call(rt, 'run_query', { sql: 'select a from one; select b from two;' }));
    expect(out.split('\n')[0].trim()).toBe('b');
    expect(out).toMatch(/Earlier statements: SELECT \(2 rows\)\n1 rows returned\. \(\d+ms\)$/);
  });

  test('a script that ends with a statement without rows reports its status', async () => {
    define('select a from one', [{ name: 'a', oid: 23 }], [['1'], ['2']]);
    fakeDb.define('insert into t values (1)', { command: 'INSERT', rowCount: 1 });
    const out = textOf(await call(rt, 'run_query', { sql: 'select a from one; insert into t values (1)' }));
    expect(out).toMatch(/^Query executed successfully\. 1 rows affected\. \(\d+ms\)\nEarlier statements: SELECT \(2 rows\)$/);
    const json = jsonOf(await call(rt, 'run_query', { sql: 'insert into t values (1)', format: 'json' }));
    expect(json).toMatchObject({ columns: [], rows: [], rowCount: 0, command: 'INSERT', rowsAffected: 1 });
  });

  test('transaction-control scripts run as written and show the last row set; the connection is discarded', async () => {
    define('select id, name from t', ID_NAME, numbered(250), 250);
    const out = textOf(await call(rt, 'run_query', { sql: 'begin; select id, name from t; commit;' }));
    expect(out).toContain('250 rows returned.');
    expect(out).toContain('Earlier statements: BEGIN, COMMIT');
    const id = resultIdOf(out);
    const next = textOf(await call(rt, 'fetch_rows', { resultId: id, maxRows: 200 }));
    expect(next).toContain('Rows 101–250 of 250.');
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
    expect(fakeDb.statementsMatching(/^DECLARE/)).toHaveLength(0);
  });

  test('a script left inside a transaction never returns its connection to the pool', async () => {
    define('select id, name from t', ID_NAME, [['1', 'a']]);
    await call(rt, 'run_query', { sql: 'begin; select id, name from t' });
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
    expect(pool.idleCount).toBe(0);
  });

  test('a SELECT whose DECLARE is rejected (SELECT INTO) runs without a cursor', async () => {
    fakeDb.define('select * into new_t from t', { command: 'SELECT', rowCount: 5, rejectDeclare: true });
    const out = textOf(await call(rt, 'run_query', { sql: 'select * into new_t from t' }));
    expect(out).toMatch(/^Query executed successfully\. 5 rows affected\. \(\d+ms\)$/);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });

  test('text with only comments or semicolons is rejected', async () => {
    const result = await call(rt, 'run_query', { sql: ' ; -- nothing\n' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: No SQL statement to run: the text contains only comments or semicolons.');
  });
});

describe('run_query: totals and paging modes', () => {
  test('PostgreSQL totals come from a SCROLL cursor and MOVE', async () => {
    fakeDb.engine = 'postgres';
    define('select id, name from big', ID_NAME, numbered(1_234), 1_234);
    const page = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json' }));
    expect(page.totalRows).toBe(1_234);
    expect(fakeDb.statementsMatching(/^MOVE FORWARD ALL IN mcp_c$/)).toHaveLength(1);
    const rest = jsonOf(await call(rt, 'fetch_rows', { resultId: page.resultId, format: 'json', maxRows: 2_000 }));
    expect(rest.rows).toHaveLength(1_134);
    expect(rest.rows[0]).toEqual([100, 'name-100']);
  });

  test('without stv access the total is reported as "more than N"', async () => {
    fakeDb.stvAllowed = false;
    define('select id, name from big', ID_NAME, numbered(250), 250);
    const out = textOf(await call(rt, 'run_query', { sql: 'select id, name from big' }));
    expect(out).toContain('... (more rows)');
    expect(out).toMatch(/More than 100 rows returned\. \(\d+ms\)/);
    const id = resultIdOf(out);
    const rest = jsonOf(await call(rt, 'fetch_rows', { resultId: id, format: 'json', maxRows: 1_000 }));
    expect(rest).toMatchObject({ rowCount: 150, totalRows: 250, hasMore: false });
  });

  test('results above the spool threshold keep an open cursor; when the slots are full, paging is busy', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 0, maxOpenCursors: 1 });
    define('select id, name from big', ID_NAME, numbered(300), 300);
    define('select id, name from other', ID_NAME, numbered(300), 300);
    const first = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json' }));
    expect(first.resultId).toMatch(/^r_/);
    expect(rt.results.openCursorCount).toBe(1);
    const busy = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from other', format: 'json' }));
    expect(busy).toMatchObject({ totalRows: 300, hasMore: true, resultId: null, pagingUnavailable: 'busy' });
    const busyTable = textOf(await call(rt, 'run_query', { sql: 'select id, name from other' }));
    expect(busyTable).toContain('More rows exist, but paging is busy. Use export_query or narrow the query.');
    expect(pool.checkedOutCount).toBe(1);
    // Reading the open result to the end frees its slot and connection.
    const rest = jsonOf(await call(rt, 'fetch_rows', { resultId: first.resultId, format: 'json', maxRows: 1_000 }));
    expect(rest.rows).toHaveLength(200);
    expect(rt.results.openCursorCount).toBe(0);
    expect(pool.checkedOutCount).toBe(0);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });

  test('streaming results beyond the spool threshold report the exact total without paging', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 1_000 });
    define('select id, name from big', ID_NAME, numbered(5_000), 5_000);
    const out = textOf(await call(rt, 'run_query', { sql: 'begin; select id, name from big; commit' }));
    expect(out).toContain('5000 rows returned.');
    expect(out).toContain('More rows exist, but this result is too large to page. Use export_query or narrow the query.');
    expect(rt.results.spoolBytes).toBe(0);
  });

  test('evicted and unknown results explain themselves', async () => {
    define('select id, name from a', ID_NAME, numbered(1_000), 1_000);
    define('select id, name from b', ID_NAME, numbered(1_000), 1_000);
    rt = makeRuntime({ spoolMaxTotalBytes: 40_000 });
    const a = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from a', format: 'json' }));
    await until(() => (rt.results.get(a.resultId) as SpoolSession).mode === 'spooled', 2_000, 'spool a');
    const b = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from b', format: 'json' }));
    await until(() => (rt.results.get(b.resultId) as SpoolSession).mode === 'spooled', 2_000, 'spool b');
    const evicted = await call(rt, 'fetch_rows', { resultId: a.resultId });
    expect(evicted.isError).toBe(true);
    expect(textOf(evicted)).toContain(`Error: result ${a.resultId} is no longer available (it was evicted`);
    const unknown = await call(rt, 'fetch_rows', { resultId: 'r_abcdefghijklmnop' });
    expect(textOf(unknown)).toBe('Error: result r_abcdefghijklmnop is no longer available (unknown result ID; results are kept only until the server restarts). Re-run the query, or use export_query.');
    const invalid = await call(rt, 'fetch_rows', { resultId: 'nope' });
    expect(textOf(invalid)).toMatch(/^Validation Error: resultId: Invalid resultId/);
  });

  test('an open-cursor result expires after its idle time', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 0, cursorIdleTtlMs: 50 });
    define('select id, name from big', ID_NAME, numbered(300), 300);
    const first = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json' }));
    await until(() => rt.results.openCursorCount === 0, 2_000, 'idle expiry');
    const expired = await call(rt, 'fetch_rows', { resultId: first.resultId });
    expect(textOf(expired)).toContain('its open cursor was closed after 0s without a fetch_rows call');
    expect(pool.checkedOutCount).toBe(0);
  });
});

describe('run_query: retries (Property 12)', () => {
  test('a connection-level error before the first row is retried on a fresh pool', async () => {
    define('select id, name from t', ID_NAME, [['1', 'a']]);
    fakeDb.failWhen(/^DECLARE/i, connectionError(), 1);
    const out = textOf(await call(rt, 'run_query', { sql: 'select id, name from t' }));
    expect(out).toContain('1 rows returned.');
    expect(fakeDb.statementsMatching(/^DECLARE/)).toHaveLength(2);
    expect(pool.ended).toBe(true);
  });

  test('no retry after an earlier script statement completed', async () => {
    define('select id, name from t', ID_NAME, [['1', 'a']]);
    fakeDb.failWhen(/^DECLARE/i, connectionError(), 1);
    const result = await call(rt, 'run_query', { sql: "set search_path to 'x'; select id, name from t" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.split('\n')[0]).toBe('Error: Lost the connection to the database while the SQL was running (Connection terminated unexpectedly).');
    expect(text.split('\n').pop()).toBe(
      'Error type: connection_lost. Statement 2 of 2 was running when the connection was lost. ' +
      'The statements before it had completed: SET. It was not retried, because a retry would run them again.',
    );
    expect(fakeDb.statementsMatching(/^set search_path/)).toHaveLength(1);
  });

  test('no retry after the first row arrived', async () => {
    define('select id, name from t', ID_NAME, numbered(50), 50);
    fakeDb.failWhen('__row_5__', connectionError(), 1);
    const result = await call(rt, 'run_query', { sql: 'begin; select id, name from t; commit' });
    expect(result.isError).toBe(true);
    expect(fakeDb.statementsMatching(/^select id, name from t$/)).toHaveLength(1);
  });

  test('SQL errors are not retried and keep the database message', async () => {
    const result = await call(rt, 'run_query', { sql: 'select * from missing' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: .*relation does not exist/);
    expect(fakeDb.statementsMatching(/^select \* from missing$/).length).toBeLessThanOrEqual(1);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });
});

describe('get_sample_data and the catalog tools', () => {
  test('get_sample_data honors its limit (up to 1,000)', async () => {
    define('SELECT * FROM t LIMIT 20', ID_NAME, numbered(20), 20);
    define('SELECT * FROM t LIMIT 1000', ID_NAME, numbered(1_000), 1_000);
    const small = textOf(await call(rt, 'get_sample_data', { table: 't', limit: 20 }));
    expect(small).toContain('20 rows returned.');
    expect(small.split('\n').filter((l) => /^\d+ +\|/.test(l))).toHaveLength(20);
    const big = textOf(await call(rt, 'get_sample_data', { table: 't', limit: 1_000 }));
    expect(big).toContain('1000 rows returned.');
    expect(big.split('\n').filter((l) => /^\d+ +\|/.test(l))).toHaveLength(1_000);
    const invalid = await call(rt, 'get_sample_data', { table: 't', limit: 1_001 });
    expect(invalid.isError).toBe(true);
  });

  test('list_schemas renders like 1.4.0 and pages a large catalog', async () => {
    const sql = `SELECT schema_name FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_internal')
          ORDER BY schema_name`;
    define(sql, [{ name: 'schema_name', oid: 19 }], Array.from({ length: 150 }, (_, i) => [`schema_${String(i).padStart(3, '0')}`]));
    const out = textOf(await call(rt, 'list_schemas', {}));
    expect(out.split('\n')[0]).toBe('schema_name');
    expect(out).toContain('... (50 more rows)');
    expect(out).toContain('150 rows returned.');
    const id = resultIdOf(out);
    const next = textOf(await call(rt, 'fetch_rows', { resultId: id }));
    expect(next).toContain('schema_149');
    expect(next).toContain('Rows 101–150 of 150.');
  });

  test('describe_table uses parameters and renders a table', async () => {
    const sql = `SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`;
    define(sql, [{ name: 'column_name', oid: 19 }, { name: 'data_type', oid: 1043 }, { name: 'is_nullable', oid: 1043 }, { name: 'column_default', oid: 1043 }], [
      ['id', 'integer', 'NO', null],
    ]);
    const out = textOf(await call(rt, 'describe_table', { table: 'public.t' }));
    expect(out).toMatch(/^column_name \| data_type \| is_nullable \| column_default\n/);
    expect(out).toContain('id          | integer   | NO          | NULL          ');
    expect(out).toMatch(/1 rows returned\. \(\d+ms\)$/);
  });
});
