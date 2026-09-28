/**
 * Live tests against a Redshift cluster. Opt-in: `npm run test:live`, with SQL_LIVE_TABLE (and
 * SQL_LIVE_BIG_TABLE for the export test) naming tables the database user can read.
 *
 * Read-only queries only. Connection settings come from the environment (scripts/live-tests.cjs
 * can load them from an MCP client config).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { Client } from 'pg';
import { LIVE_ENABLED } from './live-env';
import { ensurePool, getActivePool, getLastConnectionConfig } from '../db/pool';
import { Lease, QueryTimeoutError } from '../db/lease';
import { detectEngine } from '../db/engine';
import { createRuntime, Runtime } from '../runtime';
import { DEFAULTS, ServerConfig } from '../config';
import { handleToolCall, ToolResult } from '../tools';
import { tempDir, removeTempDirs, parseCsv } from '../test/harness';

/** A readable `schema.table` with a few hundred to a few thousand rows (required). */
const TABLE = process.env.SQL_LIVE_TABLE ?? '';
/** A readable `schema.table` with at least SQL_LIVE_EXPORT_ROWS rows, for the export test (optional). */
const BIG_TABLE = process.env.SQL_LIVE_BIG_TABLE ?? '';
const EXPORT_ROWS = Number(process.env.SQL_LIVE_EXPORT_ROWS || 500_000);
const MB = 1024 * 1024;

const runtimes: Runtime[] = [];
function runtime(overrides: Partial<ServerConfig> = {}): Runtime {
  const rt = createRuntime({ ...DEFAULTS, ...overrides }, { baseDir: tempDir() });
  runtimes.push(rt);
  return rt;
}

async function call(rt: Runtime, name: string, args: unknown, resourceLinks = true): Promise<ToolResult> {
  return handleToolCall(name, args, {}, { runtime: rt, resourceLinks });
}

function text(result: ToolResult, block = 0): string {
  const item = result.content[block] as { type: string; text?: string };
  if (item.type !== 'text' || item.text === undefined) throw new Error('not a text block');
  return item.text;
}

function json<T = any>(result: ToolResult, block = 0): T {
  if (result.isError) throw new Error(text(result));
  return JSON.parse(text(result, block)) as T;
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[live] ${message}`);
}

const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

if (LIVE_ENABLED && !TABLE) {
  // eslint-disable-next-line no-console
  console.log('[live] set SQL_LIVE_TABLE=schema.table (a small readable table) to run the live tests');
}

describe.skipIf(!LIVE_ENABLED || !TABLE)('live: Redshift', () => {
  let trueTotal = 0;

  beforeAll(async () => {
    const pool = await ensurePool();
    const r = await pool.query(`select count(*) as n from ${TABLE}`);
    trueTotal = Number(r.rows[0].n);
    log(`${TABLE}: ${trueTotal} rows`);
  }, 60_000);

  afterAll(async () => {
    for (const rt of runtimes.splice(0)) {
      await rt.results.closeAll();
      await rt.exports.closeAll();
    }
    removeTempDirs();
    await getActivePool()?.end().catch(() => undefined);
  });

  test('engine detection: multi-node Redshift with stv_active_cursors totals', async () => {
    const pool = await ensurePool();
    const lease = await Lease.acquire(pool);
    try {
      const engine = await detectEngine(pool, lease);
      log(`engine: ${JSON.stringify(engine)}`);
      expect(engine).toEqual({ kind: 'redshift', singleNode: false, totalsFromStv: true });
      // stv_active_cursors columns (the totals query filters by pid only; each session has one cursor).
      await lease.query('BEGIN');
      await lease.query('DECLARE mcp_c CURSOR FOR select 1 as a');
      await lease.query('FETCH FORWARD 1 FROM mcp_c');
      const r = await lease.query('select * from stv_active_cursors where pid = pg_backend_pid()');
      log(`stv_active_cursors columns: ${r.fields.map((f: { name: string }) => f.name).join(', ')}; rows for this session: ${r.rows.length}`);
      expect(r.fields.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['name', 'row_count', 'byte_count', 'fetched_rows', 'pid']));
      expect(r.rows).toHaveLength(1);
      await lease.query('ROLLBACK');
    } finally {
      lease.release();
    }
  }, 60_000);

  test('exact totals: run_query reports the true row count, and the footer matches', async () => {
    const rt = runtime();
    const started = Date.now();
    const page = json(await call(rt, 'run_query', { sql: `select * from ${TABLE}`, format: 'json' }));
    log(`run_query json: rowCount ${page.rowCount}, totalRows ${page.totalRows}, hasMore ${page.hasMore}, ${Date.now() - started}ms`);
    expect(page.totalRows).toBe(trueTotal);
    expect(page.rowCount).toBe(Math.min(100, trueTotal));
    expect(page.hasMore).toBe(trueTotal > 100);
    const table = text(await call(rt, 'run_query', { sql: `select * from ${TABLE}` }));
    // The paging line sits just above the footer; the footer is the last line, as in 1.4.0.
    expect(table).toContain(`... (${trueTotal - 100} more rows)\n\nMore rows: fetch_rows {"resultId":"r_`);
    expect(table).toMatch(new RegExp(`\\n${trueTotal} rows returned\\. \\(\\d+ms\\)$`));
  }, 120_000);

  test('pages joined together equal a single full read (spooled and open-cursor modes)', async () => {
    const sql = `select * from ${TABLE}`;
    const single = json(await call(runtime(), 'run_query', { sql, format: 'json', maxRows: 1_000_000, maxChars: 5_000_000 }));
    expect(single.hasMore).toBe(false);
    expect(single.rows).toHaveLength(trueTotal);
    for (const [mode, overrides] of [['spooled', {}], ['open cursor', { spoolThresholdBytes: 0 }]] as const) {
      const rt = runtime(overrides);
      const first = json(await call(rt, 'run_query', { sql, format: 'json', maxRows: 250 }));
      const rows: unknown[][] = [...first.rows];
      let resultId = first.resultId;
      let pages = 1;
      while (resultId) {
        const next = json(await call(rt, 'fetch_rows', { resultId, format: pages % 2 ? 'json' : 'json', maxRows: 333 }));
        rows.push(...next.rows);
        resultId = next.resultId;
        pages++;
      }
      log(`${mode}: ${pages} pages, ${rows.length} rows`);
      expect(rows).toHaveLength(trueTotal);
      expect(sorted(rows)).toEqual(sorted(single.rows));
      expect(rt.results.openCursorCount).toBe(0);
    }
  }, 300_000);

  test('INTERVAL, DATE, NULL versus \'NULL\', separators, duplicate and number-like columns', async () => {
    const rt = runtime();
    const sql = "select interval '1 day 2 hours' as i, '2026-09-05'::date as d, null::varchar as n, 'NULL'::varchar as n, 'a | b, \"c\"'::varchar as p, 1 as \"2025\", true as ok";
    const page = json(await call(rt, 'run_query', { sql, format: 'json' }));
    log(`exact: columns ${JSON.stringify(page.columns)} rows ${JSON.stringify(page.rows)}`);
    expect(page.columns.map((c: { name: string }) => c.name)).toEqual(['i', 'd', 'n', 'n', 'p', '2025', 'ok']);
    expect(page.columns.map((c: { type: string }) => c.type)).toEqual(['interval', 'date', 'varchar', 'varchar', 'varchar', 'int4', 'bool']);
    expect(page.rows[0][1]).toBe('2026-09-05');
    expect(page.rows[0][2]).toBeNull();
    expect(page.rows[0][3]).toBe('NULL');
    expect(page.rows[0][4]).toBe('a | b, "c"');
    expect(page.rows[0][5]).toBe(1);
    expect(page.rows[0][6]).toBe(true);
    expect(typeof page.rows[0][0]).toBe('string');
    expect(page.rows[0][0]).toMatch(/1 day/);
    const table = text(await call(rt, 'run_query', { sql }));
    expect(table).not.toContain('[object Object]');
    expect(table.split('\n')[0].split(' | ')).toHaveLength(7);
    const csv = parseCsv(text(await call(rt, 'run_query', { sql, format: 'csv' }), 0));
    expect(csv[1][2]).toEqual({ value: '', quoted: false });
    expect(csv[1][3]).toEqual({ value: 'NULL', quoted: false });
    expect(csv[1][4]).toEqual({ value: 'a | b, "c"', quoted: true });
  }, 120_000);

  test('multi-statement scripts run in order, and session settings do not leak into the next call', async () => {
    const rt = runtime();
    const [schema, table] = TABLE.split('.');
    const scripted = text(await call(rt, 'run_query', { sql: `set search_path to ${schema}, public; select count(*) as n from ${table}` }));
    log(`script: ${scripted.split('\n').slice(-2).join(' / ')}`);
    expect(scripted).toContain(`${trueTotal}`);
    expect(scripted).toMatch(/Earlier statements: SET\n1 rows returned\. \(\d+ms\)$/);
    const after = text(await call(rt, 'run_query', { sql: 'show search_path' }));
    log(`search_path in the next call: ${after.split('\n')[2]?.trim()}`);
    expect(after).not.toContain(`${schema}, public`);
    const tx = text(await call(rt, 'run_query', { sql: `begin; select count(*) as n from ${TABLE}; commit;` }));
    expect(tx).toContain(`${trueTotal}`);
    expect(tx).toContain('Earlier statements: BEGIN, COMMIT');
  }, 120_000);

  // A leader-node query that runs about 6 seconds, hard-capped at 10 seconds by statement_timeout,
  // so a failed cancel can't leave load behind on the shared cluster.
  const HEAVY = 'select count(*) from (select a.n from (select generate_series(1, 4000) as n) a cross join (select generate_series(1, 4000) as n) b) x';

  async function cancelProbe(label: string): Promise<{ err: unknown; elapsed: number }> {
    const pool = await ensurePool();
    const lease = await Lease.acquire(pool);
    try {
      lease.markDiscard();
      await lease.query('set statement_timeout to 10000');
      const started = Date.now();
      const err = await lease.query(HEAVY, { timeoutMs: 1_000 }).catch((e) => e);
      const elapsed = Date.now() - started;
      log(`${label}: ${err instanceof Error ? err.message : 'query finished'} after ${elapsed}ms`);
      return { err, elapsed };
    } finally {
      lease.release();
    }
  }

  test('a protocol-level cancel stops a running query on Redshift', async () => {
    const grace = Lease.cancelGraceMs;
    // Push the pg_cancel_backend fallback past the query's natural end: only the protocol cancel can stop it early.
    Lease.cancelGraceMs = 20_000;
    try {
      const { err, elapsed } = await cancelProbe('protocol cancel');
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(elapsed).toBeLessThan(4_000);
    } finally {
      Lease.cancelGraceMs = grace;
    }
  }, 60_000);

  test('pg_cancel_backend is a working fallback', async () => {
    // Disable the protocol cancel at both levels: Client#cancel and the connection's CancelRequest.
    const clientProto = Client.prototype as unknown as { cancel: unknown };
    const connectionProto = Object.getPrototypeOf((new Client({}) as unknown as { connection: object }).connection) as { cancel: unknown };
    const originals = [clientProto.cancel, connectionProto.cancel];
    clientProto.cancel = () => undefined;
    connectionProto.cancel = () => undefined;
    const grace = Lease.cancelGraceMs;
    Lease.cancelGraceMs = 300;
    try {
      const { err, elapsed } = await cancelProbe('pg_cancel_backend fallback');
      expect(err).toBeInstanceOf(QueryTimeoutError);
      // The timeout (1s), the grace period (0.3s), then a new connection runs pg_cancel_backend.
      expect(elapsed).toBeGreaterThan(1_300);
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      [clientProto.cancel, connectionProto.cancel] = originals;
      Lease.cancelGraceMs = grace;
    }
    expect(getLastConnectionConfig()).not.toBeNull();
  }, 60_000);

  test('an idle open cursor and WLM: what stv_wlm_query_state shows while the cursor waits', async () => {
    const rt = runtime({ spoolThresholdBytes: 0 });
    const first = json(await call(rt, 'run_query', { sql: `select * from ${TABLE}`, format: 'json' }));
    expect(rt.results.openCursorCount).toBe(1);
    const config = getLastConnectionConfig();
    expect(config).not.toBeNull();
    const side = new Client(config as NonNullable<typeof config>);
    await side.connect();
    try {
      const r = await side.query('select query, service_class, state, queue_time, exec_time from stv_wlm_query_state order by query');
      log(`stv_wlm_query_state while one cursor is open and idle: ${JSON.stringify(r.rows)}`);
    } catch (e) {
      log(`stv_wlm_query_state: ${e instanceof Error ? e.message : e}`);
    } finally {
      await side.end();
    }
    await call(rt, 'fetch_rows', { resultId: first.resultId, maxRows: 1_000_000, maxChars: 5_000_000 });
    expect(rt.results.openCursorCount).toBe(0);
  }, 120_000);

  test.skipIf(!BIG_TABLE)('a large export streams without a cursor and keeps a bounded heap', async () => {
    const rt = runtime();
    const sql = `select * from ${BIG_TABLE} limit ${EXPORT_ROWS}`;
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 10);
    const started = Date.now();
    let out: any;
    try {
      out = json(await call(rt, 'export_query', { sql, format: 'jsonl', fileName: 'live-large' }));
    } finally {
      clearInterval(timer);
    }
    const seconds = (Date.now() - started) / 1000;
    log(`export: ${out.rowCount} rows, ${(out.bytes / MB).toFixed(1)} MB in ${seconds.toFixed(1)}s, heap peak +${((peak - baseline) / MB).toFixed(1)} MB, peak queued rows ${rt.exports.peakQueuedRows}`);
    expect(out.rowCount).toBe(EXPORT_ROWS);
    expect(out.truncated).toBe(false);
    expect(fs.statSync(out.path).size).toBe(out.bytes);
    expect(peak - baseline).toBeLessThan(200 * MB);
    const sidecar = JSON.parse(fs.readFileSync(out.schemaPath, 'utf8'));
    expect(sidecar.rowCount).toBe(EXPORT_ROWS);
    fs.rmSync(out.path, { force: true });
  }, 900_000);
});
