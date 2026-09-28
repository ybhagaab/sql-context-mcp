/**
 * Export writers, export manager, and the export_query / export_status tools (Tasks 16 and 17).
 *
 * Property 3 (files): csv and jsonl files decode back to the warehouse text, keep NULL distinct
 * from 'NULL', and keep separators, quotes and newlines intact. No sanitization is applied.
 * Property 8 (exports): the queue is first-in, first-out with SQL_EXPORT_CONCURRENCY jobs running.
 * Property 10 (exports): no data file is left after a failure, cancel, or low-disk stop.
 *
 * Validates: Requirements 5.1-5.8, 7.5, 7.6
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import fc from 'fast-check';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { fakeDb, FakePool, FakeColumn, FakeCell, connectionError } from '../test/fake-pg';
import { setupFakeDb, makeRuntime, teardown, call, textOf, jsonOf, lazyRows, parseCsv, until, tempDir, lowSpaceAfter } from '../test/harness';
import { resultSetArb } from '../test/arbitraries';
import { FileRowWriter, RowWriter, ExportFormat } from './writers';
import { columnsFromFields, toCsvText, toExact } from '../results/values';
import type { Runtime } from '../runtime';

const ID_NAME: FakeColumn[] = [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }];

function define(sql: string, columns: FakeColumn[], rows: FakeCell[][] | (() => Iterable<FakeCell[]>), extra: Record<string, unknown> = {}): void {
  fakeDb.define(sql, { columns, rows, ...extra });
}

/**
 * Reads a CSV file record by record. Every record ends with a newline, so an empty line is a
 * record with one empty field (a single-column NULL, the case the docs flag; jsonl avoids it).
 */
function readCsv(file: string): Array<Array<string | null>> {
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r) => r.map((f) => (f.quoted ? f.value : f.value === '' ? null : f.value)));
}

function readJsonl(file: string): unknown[][] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function leftovers(rt: Runtime): string[] {
  return fs.readdirSync(rt.files.exportsDir).filter((f) => f.endsWith('.part'));
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

describe('Property 3 (files): exact csv and jsonl, without sanitization', () => {
  test('files decode back to the warehouse values for any columns and rows', async () => {
    const dir = tempDir();
    await fc.assert(
      fc.asyncProperty(resultSetArb({ maxRows: 60 }), fc.constantFrom<ExportFormat>('csv', 'jsonl'), async ({ columns, rows }, format) => {
        const file = path.join(dir, `p3.${format}`);
        const cols = columnsFromFields(columns.map((c) => ({ name: c.name, dataTypeID: c.oid })));
        const writer = await FileRowWriter.open(file, format);
        writer.begin(cols);
        // Hidden characters are kept in files (inline output strips them).
        const withHidden = rows.map((r) => r.map((v, i) => (v !== null && cols[i].oid === 1043 ? `${v}\u200B\u0007` : v)));
        for (const row of withHidden) writer.writeLine(writer.encode(row));
        await writer.finish();
        expect(writer.bytes).toBe(fs.statSync(file).size);
        if (format === 'jsonl') {
          expect(readJsonl(file)).toEqual(withHidden.map((r) => r.map((v, i) => toExact(v, cols[i].oid))));
        } else {
          const parsed = readCsv(file);
          expect(parsed[0]).toEqual(cols.map((c) => c.name));
          const body = parsed.slice(1);
          expect(body).toHaveLength(withHidden.length);
          withHidden.forEach((r, k) => expect(body[k]).toEqual(r.map((v, i) => toCsvText(v, cols[i].oid))));
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('export_query (wait: true)', () => {
  test('writes the file, a schema sidecar and a preview, and links the file', async () => {
    define('select id, name from big', ID_NAME, lazyRows(1_500), { rowCount: 1_500 });
    const result = await call(rt, 'export_query', { sql: 'select id, name from big', fileName: 'Campaigns 2026!' });
    expect(result.isError).toBeUndefined();
    const out = jsonOf(result);
    expect(out).toMatchObject({ state: 'done', format: 'csv', rowCount: 1_500, truncated: false });
    expect(out.exportId).toMatch(/^e_[a-z2-7]{16}$/);
    expect(path.dirname(out.path)).toBe(rt.files.exportsDir);
    expect(path.basename(out.path)).toMatch(/^Campaigns_2026_-\d{8}-\d{6}-[a-z2-7]{4}\.csv$/);
    expect(out.schemaPath).toBe(`${out.path}.schema.json`);
    expect(out.bytes).toBe(fs.statSync(out.path).size);
    expect(out.columns).toEqual([{ name: 'id', type: 'int4' }, { name: 'name', type: 'varchar' }]);
    expect(out.preview).toEqual(Array.from({ length: 10 }, (_, i) => [i, `name-${i}`]));
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect((fs.statSync(out.path).mode & 0o777).toString(8)).toBe('600');
    const rows = readCsv(out.path);
    expect(rows[0]).toEqual(['id', 'name']);
    expect(rows).toHaveLength(1_501);
    expect(rows[1_500]).toEqual(['1499', 'name-1499']);
    const sidecar = JSON.parse(fs.readFileSync(out.schemaPath, 'utf8'));
    expect(sidecar).toMatchObject({
      columns: [{ name: 'id', type: 'int4', oid: 23 }, { name: 'name', type: 'varchar', oid: 1043 }],
      rowCount: 1_500, bytes: out.bytes, format: 'csv', truncated: false,
      sqlSha256: createHash('sha256').update('select id, name from big').digest('hex'),
    });
    expect(new Date(sidecar.createdAt).getTime()).toBeGreaterThan(0);
    const link = result.content[1] as { type: string; uri: string; name: string; mimeType: string };
    expect(link).toMatchObject({ type: 'resource_link', name: path.basename(out.path), mimeType: 'text/csv' });
    expect(link.uri).toBe(pathToFileURL(out.path).href);
    expect(link.uri.startsWith('file:///')).toBe(true);
    expect(leftovers(rt)).toEqual([]);
    expect(pool.checkedOutCount).toBe(0);
    expect(fakeDb.statementsMatching(/^DECLARE/)).toHaveLength(0);
  });

  test('jsonl holds exact values; no resource_link for older clients', async () => {
    define('select * from exact', [{ name: 'd', oid: 1082 }, { name: 'n', oid: 1043 }, { name: 'n', oid: 1043 }, { name: 'i', oid: 1186 }, { name: 'b', oid: 16 }], [
      ['2026-09-05', null, 'NULL', '1 day 02:00:00', 'f'],
    ]);
    const result = await call(rt, 'export_query', { sql: 'select * from exact', format: 'jsonl' }, {}, false);
    expect(result.content).toHaveLength(1);
    const out = jsonOf(result);
    expect(readJsonl(out.path)).toEqual([['2026-09-05', null, 'NULL', '1 day 02:00:00', false]]);
    expect(out.columns.map((c: { name: string }) => c.name)).toEqual(['d', 'n', 'n', 'i', 'b']);
  });

  test('scripts export the last statement; transaction-control scripts export the last row set', async () => {
    define('select a from one', [{ name: 'a', oid: 23 }], [['1'], ['2']]);
    define('select b from two', [{ name: 'b', oid: 23 }], [['3']]);
    const script = jsonOf(await call(rt, 'export_query', { sql: "set search_path to 'x'; select a from one" }));
    expect(readCsv(script.path)).toEqual([['a'], ['1'], ['2']]);
    const tx = jsonOf(await call(rt, 'export_query', { sql: 'begin; select a from one; select b from two; commit;' }));
    expect(readCsv(tx.path)).toEqual([['b'], ['3']]);
    expect(tx.rowCount).toBe(1);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
    expect(fakeDb.leakedSessionState()).toHaveLength(0);
  });

  test('an empty result writes the header only', async () => {
    define('select id, name from empty', ID_NAME, []);
    const out = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from empty' }));
    expect(fs.readFileSync(out.path, 'utf8')).toBe('id,name\n');
    expect(out.rowCount).toBe(0);
  });

  test('a statement without rows is an error, and leaves no file', async () => {
    fakeDb.define('insert into t values (1)', { command: 'INSERT', rowCount: 1 });
    const result = await call(rt, 'export_query', { sql: 'insert into t values (1)' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: The SQL returned no rows to export: export_query writes the result of the last statement that returns rows.');
    expect(fs.readdirSync(rt.files.exportsDir)).toEqual([]);
  });
});

describe('caps', () => {
  test('there is no row or size cap by default', async () => {
    define('select id, name from big', ID_NAME, lazyRows(20_000), { rowCount: 20_000 });
    const out = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from big', format: 'jsonl' }));
    expect(out).toMatchObject({ rowCount: 20_000, truncated: false });
    expect(readJsonl(out.path)).toHaveLength(20_000);
  });

  test('maxRows stops the export and marks it truncated; the lower of the call and operator caps applies', async () => {
    define('select id, name from big', ID_NAME, lazyRows(1_000), { rowCount: 1_000 });
    const out = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from big', maxRows: 10 }));
    expect(out).toMatchObject({ rowCount: 10, truncated: true });
    expect(readCsv(out.path)).toHaveLength(11);
    rt = makeRuntime({ exportMaxRows: 5 });
    const capped = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from big', maxRows: 10 }));
    expect(capped).toMatchObject({ rowCount: 5, truncated: true });
    const exact = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from big', maxRows: 1_000 }));
    expect(exact.rowCount).toBe(5);
    expect(pool.checkedOutCount).toBe(0);
  });

  test('a result with exactly maxRows rows is not truncated', async () => {
    define('select id, name from ten', ID_NAME, lazyRows(10), { rowCount: 10 });
    const out = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from ten', maxRows: 10 }));
    expect(out).toMatchObject({ rowCount: 10, truncated: false });
  });

  test('maxBytes keeps the file within the cap', async () => {
    define('select id, name from big', ID_NAME, lazyRows(1_000), { rowCount: 1_000 });
    const out = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from big', maxBytes: 500 }));
    expect(out.truncated).toBe(true);
    expect(fs.statSync(out.path).size).toBeLessThanOrEqual(500);
    expect(fs.statSync(out.path).size).toBeGreaterThan(450);
  });
});

describe('Property 10 (exports): no data file after a failure, cancel or low-disk stop', () => {
  test('a SQL error fails the export and removes the .part file', async () => {
    const result = await call(rt, 'export_query', { sql: 'select * from missing' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: relation does not exist/);
    expect(fs.readdirSync(rt.files.exportsDir)).toEqual([]);
    expect(pool.checkedOutCount).toBe(0);
  });

  test('a low-disk stop fails the export with "disk nearly full" and removes the .part file', async () => {
    rt = makeRuntime({ exportMinFreeBytes: 1_000_000 }, { statfs: lowSpaceAfter(1), freeSpaceCheckEveryBytes: 2_048 });
    define('select id, name from big', ID_NAME, lazyRows(5_000), { rowCount: 5_000 });
    const result = await call(rt, 'export_query', { sql: 'select id, name from big' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: Disk nearly full: /);
    expect(fs.readdirSync(rt.files.exportsDir)).toEqual([]);
    expect(pool.checkedOutCount).toBe(0);
    expect(fakeDb.cancelRequests.length).toBeGreaterThanOrEqual(1);
  });

  test('cancel: true stops a running export, cancels its query, and removes the .part file', async () => {
    define('select id, name from slow', ID_NAME, lazyRows(10), { delayMs: 10_000 });
    const started = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from slow', wait: false }));
    expect(started).toEqual({ exportId: started.exportId, state: 'running' });
    await until(() => fakeDb.log.some((s) => s === 'select id, name from slow'), 2_000, 'query start');
    const status = jsonOf(await call(rt, 'export_status', { exportId: started.exportId, cancel: true }));
    expect(status).toMatchObject({ exportId: started.exportId, state: 'cancelled', error: 'The export was cancelled.' });
    expect(fakeDb.cancelRequests).toEqual([expect.objectContaining({ via: 'protocol' })]);
    expect(leftovers(rt)).toEqual([]);
    expect(fs.readdirSync(rt.files.exportsDir)).toEqual([]);
    expect(pool.checkedOutCount).toBe(0);
  });

  test('cancelling the MCP request of a waiting export cancels the job', async () => {
    define('select id, name from slow', ID_NAME, lazyRows(10), { delayMs: 10_000 });
    const controller = new AbortController();
    const pending = call(rt, 'export_query', { sql: 'select id, name from slow' }, { signal: controller.signal });
    await until(() => fakeDb.log.some((s) => s === 'select id, name from slow'), 2_000, 'query start');
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: The export was cancelled.');
    expect(rt.exports.list().map((j) => j.state)).toEqual(['cancelled']);
    expect(fs.readdirSync(rt.files.exportsDir)).toEqual([]);
    expect(pool.checkedOutCount).toBe(0);
  });

  test('a connection-level error before the first row is retried; after rows it fails', async () => {
    define('select id, name from t', ID_NAME, lazyRows(100), { rowCount: 100 });
    fakeDb.failWhen(/^select id, name from t$/, connectionError(), 1);
    const ok = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from t' }));
    expect(ok.rowCount).toBe(100);
    expect(fakeDb.statementsMatching(/^select id, name from t$/)).toHaveLength(2);

    pool = setupFakeDb();
    define('select id, name from t', ID_NAME, lazyRows(100), { rowCount: 100 });
    fakeDb.failWhen('__row_5__', connectionError(), 1);
    const failed = await call(rt, 'export_query', { sql: 'select id, name from t' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('Error: Connection terminated unexpectedly');
    expect(fakeDb.statementsMatching(/^select id, name from t$/)).toHaveLength(1);
    expect(leftovers(rt)).toEqual([]);
  });
});

describe('Property 8 (exports): FIFO queue with bounded concurrency; wait: false lifecycle', () => {
  test('at most SQL_EXPORT_CONCURRENCY jobs run; the rest wait in order with their positions', async () => {
    for (let i = 0; i < 5; i++) define(`select id, name from s${i}`, ID_NAME, lazyRows(20), { delayMs: 150 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(jsonOf(await call(rt, 'export_query', { sql: `select id, name from s${i}`, wait: false })).exportId);
    const states = ids.map((id) => rt.exports.get(id)!);
    expect(states.map((j) => j.state)).toEqual(['running', 'running', 'queued', 'queued', 'queued']);
    expect(jsonOf(await call(rt, 'export_status', { exportId: ids[3] }))).toMatchObject({ state: 'queued', queuePosition: 2 });
    let peak = 0;
    while (states.some((j) => !j.isFinished)) {
      peak = Math.max(peak, rt.exports.runningCount);
      expect(rt.exports.runningCount).toBeLessThanOrEqual(2);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(peak).toBe(2);
    const starts = states.map((j) => j.startedAt as number);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
    const done = jsonOf(await call(rt, 'export_status', { exportId: ids[4] }));
    expect(done).toMatchObject({ state: 'done', rowsWritten: 20, rowCount: 20 });
    expect(fs.existsSync(done.path)).toBe(true);
  });

  test('a queued export can be cancelled before it starts', async () => {
    for (let i = 0; i < 3; i++) define(`select id, name from s${i}`, ID_NAME, lazyRows(5), { delayMs: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(jsonOf(await call(rt, 'export_query', { sql: `select id, name from s${i}`, wait: false })).exportId);
    const status = jsonOf(await call(rt, 'export_status', { exportId: ids[2], cancel: true }));
    expect(status).toMatchObject({ state: 'cancelled', error: 'The export was cancelled before it started.' });
    await until(() => rt.exports.list().every((j) => j.isFinished), 3_000, 'exports');
    expect(rt.exports.list().map((j) => j.state)).toEqual(['done', 'done', 'cancelled']);
  });

  test('export_status reports progress while running, and the unknown ID case', async () => {
    define('select id, name from slow', ID_NAME, lazyRows(10), { delayMs: 200 });
    const { exportId } = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from slow', wait: false }));
    const running = jsonOf(await call(rt, 'export_status', { exportId }));
    expect(running).toMatchObject({ exportId, state: 'running', rowsWritten: 0 });
    expect(running.elapsedMs).toBeGreaterThanOrEqual(0);
    await until(() => rt.exports.get(exportId)!.isFinished, 3_000, 'export');
    const done = await call(rt, 'export_status', { exportId });
    expect(jsonOf(done)).toMatchObject({ state: 'done', rowCount: 10 });
    expect(done.content[1]).toMatchObject({ type: 'resource_link' });
    const unknown = await call(rt, 'export_status', { exportId: 'e_abcdefghijklmnop' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('Exports are tracked only until the server restarts');
  });
});

describe('streaming without a cursor keeps memory bounded behind a slow writer', () => {
  test('the database socket pauses while the file drains', async () => {
    class SlowWriter implements RowWriter {
      private inner: FileRowWriter;
      private n = 0;
      constructor(inner: FileRowWriter) { this.inner = inner; }
      get bytes() { return this.inner.bytes; }
      begin(columns: Parameters<RowWriter['begin']>[0]) { this.inner.begin(columns); }
      encode(row: unknown[]) { return this.inner.encode(row); }
      writeLine(line: string) { this.inner.writeLine(line); return ++this.n % 50 !== 0; }
      drain() { return new Promise<void>((r) => setTimeout(r, 1)); }
      finish() { return this.inner.finish(); }
      destroy() { return this.inner.destroy(); }
    }
    rt = makeRuntime({}, { exportOptions: { highWater: 100, openWriter: async (file, format) => new SlowWriter(await FileRowWriter.open(file, format)) } });
    define('select id, name from big', ID_NAME, lazyRows(20_000), { rowCount: 20_000 });
    const out = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from big' }));
    expect(out.rowCount).toBe(20_000);
    expect(rt.exports.peakQueuedRows).toBeGreaterThanOrEqual(100);
    expect(rt.exports.peakQueuedRows).toBeLessThanOrEqual(102);
    expect(readCsv(out.path)).toHaveLength(20_001);
  }, 60_000);
});
