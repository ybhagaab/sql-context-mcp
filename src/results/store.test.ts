/**
 * Result store (design Component 8).
 *
 * Property 2: Paging completeness - in spooled and open-cursor modes, for any page sizes and
 * formats, the concatenated pages equal the full result exactly and in order.
 * Property 8 (store level): open cursors stay at or below SQL_MAX_OPEN_CURSORS, spool bytes stay
 * within SQL_SPOOL_MAX_TOTAL_BYTES, and no open result is closed to make room for another.
 *
 * Validates: Requirements 3.1-3.8, 6.4, 7.3, 7.6
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import fc from 'fast-check';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { fakeDb, FakePool } from '../test/fake-pg';
import { tempDir, removeTempDirs, plentyOfSpace, lowSpaceAfter, parseCsv } from '../test/harness';
import { FileStore, DiskNearlyFullError } from '../files/store';
import {
  ResultStore,
  SpoolFile,
  SpoolSession,
  CursorSession,
  ResultUnavailableError,
  ForwardOnlyError,
  OffsetOutOfRangeError,
  SpoolLimitError,
  StoreLimits,
  PageRequest,
} from './store';
import { Lease } from '../db/lease';
import { detectEngine, __resetEngineCache } from '../db/engine';
import { CursorReader } from '../db/cursor';
import type { ColumnInfo } from './values';

const COLUMNS: ColumnInfo[] = [
  { name: 'id', oid: 25, type: 'text' },
  { name: 'v', oid: 1043, type: 'varchar' },
];
const CEILING = 5_000_000;

function limits(overrides: Partial<StoreLimits> = {}): StoreLimits {
  return { spoolMaxTotalBytes: 2 ** 31, maxOpenCursors: 3, cursorIdleTtlMs: 900_000, fetchBatchRows: 500, minFreeBytes: 0, ...overrides };
}

function newStore(overrides: Partial<StoreLimits> = {}, opts: ConstructorParameters<typeof ResultStore>[2] = { statfs: plentyOfSpace }): ResultStore {
  return new ResultStore(new FileStore(tempDir()), limits(overrides), opts);
}

const valueArb = fc.oneof(
  { weight: 5, arbitrary: fc.string({ maxLength: 12 }) },
  { weight: 1, arbitrary: fc.constantFrom('', 'NULL', 'a | b', 'x,y', 'say "hi"', 'line1\nline2', 'ünïcödé ✓') },
  { weight: 1, arbitrary: fc.constant(null) },
);

function rowsOf(values: Array<string | null>): unknown[][] {
  return values.map((v, i) => [String(i), v]);
}

/** Rows of a rendered page, decoded exactly (json and csv). */
function pageRows(format: 'json' | 'csv', blocks: string[]): unknown[][] {
  if (format === 'json') return JSON.parse(blocks[0]).rows;
  const parsed = parseCsv(blocks[0]);
  return parsed.slice(1).map((r) => r.map((f) => (f.quoted ? f.value : f.value === '' ? null : f.value)));
}

function hasMore(format: 'json' | 'csv', blocks: string[]): boolean {
  if (format === 'json') return JSON.parse(blocks[0]).hasMore;
  return blocks[1].includes('More rows');
}

/** Strips characters the inline sanitizer removes, so expected values match rendered ones. */
function inline(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uE000-\uF8FF\uFE00-\uFE0F]/g, '').replace(/[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, '') : v;
}

beforeEach(() => {
  fakeDb.reset();
  __resetEngineCache();
  Lease.cancelGraceMs = 30;
});

afterEach(() => {
  vi.useRealTimers();
  removeTempDirs();
});

describe('SpoolFile', () => {
  test('appends in batches and reads back from any offset through the sparse index', async () => {
    const file = `${tempDir()}/s.jsonl`;
    const spool = await SpoolFile.create(file);
    const rows = rowsOf(Array.from({ length: 5_500 }, (_, i) => (i % 7 === 0 ? null : `value ${i} ✓`)));
    let i = 0;
    for (const size of [1, 999, 1, 2_000, 1_499, 1_000]) {
      await spool.write(spool.encode(rows.slice(i, i + size)));
      i += size;
    }
    expect(spool.rowsWritten).toBe(5_500);
    for (const from of [0, 1, 999, 1_000, 1_001, 2_999, 4_000, 5_499]) {
      const got: unknown[][] = [];
      for await (const row of spool.read(from)) {
        got.push(row);
        if (got.length === 3) break;
      }
      expect(got).toEqual(rows.slice(from, from + 3));
    }
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    await spool.destroy();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('Property 2: paging completeness (spooled mode)', () => {
  test('sequential pages concatenate to the full result, for any page sizes and formats', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(valueArb, { maxLength: 2_500 }),
        fc.array(fc.record({ maxRows: fc.integer({ min: 1, max: 400 }), maxChars: fc.integer({ min: 1_000, max: 40_000 }), format: fc.constantFrom<'json' | 'csv'>('json', 'csv') }), { minLength: 1, maxLength: 8 }),
        async (values, pages) => {
          const store = newStore();
          const all = rowsOf(values);
          const session = (await store.createSpool(COLUMNS, { totalRows: all.length })) as SpoolSession;
          for (let i = 0; i < all.length; i += 777) await session.append(all.slice(i, i + 777));
          session.finish();
          const got: unknown[][] = [];
          for (let n = 0; n < 10_000; n++) {
            const p = pages[n % pages.length];
            const page = await store.fetch(session.id, { format: p.format, maxRows: p.maxRows, maxChars: p.maxChars, ceiling: CEILING });
            const rows = pageRows(p.format, page.blocks);
            got.push(...rows);
            if (!hasMore(p.format, page.blocks)) break;
            expect(rows.length).toBeGreaterThan(0);
          }
          expect(got).toEqual(all.map((r) => r.map(inline)));
          await store.closeAll();
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);

  test('any offset from 0 to the total starts the page there; past the end is an error', async () => {
    const store = newStore();
    const all = rowsOf(Array.from({ length: 3_210 }, (_, i) => `v${i}`));
    const session = (await store.createSpool(COLUMNS, { totalRows: all.length })) as SpoolSession;
    await session.append(all);
    session.finish();
    for (const offset of [0, 1, 999, 1_000, 2_001, 3_209]) {
      const page = JSON.parse((await store.fetch(session.id, { format: 'json', maxRows: 5, maxChars: 100_000, ceiling: CEILING, offset })).blocks[0]);
      expect(page.offset).toBe(offset);
      expect(page.rows).toEqual(all.slice(offset, offset + 5));
      expect(page.totalRows).toBe(3_210);
    }
    const end = JSON.parse((await store.fetch(session.id, { format: 'json', maxRows: 5, maxChars: 100_000, ceiling: CEILING, offset: 3_210 })).blocks[0]);
    expect(end).toMatchObject({ rows: [], hasMore: false, rowCount: 0 });
    await expect(store.fetch(session.id, { format: 'json', maxRows: 5, maxChars: 100_000, ceiling: CEILING, offset: 3_211 })).rejects.toBeInstanceOf(OffsetOutOfRangeError);
    await store.closeAll();
  });

  test('a fetch during spooling waits for the rows it needs', async () => {
    const store = newStore();
    const all = rowsOf(Array.from({ length: 300 }, (_, i) => `v${i}`));
    const session = (await store.createSpool(COLUMNS, { totalRows: 300 })) as SpoolSession;
    await session.append(all.slice(0, 100));
    const pending = store.fetch(session.id, { format: 'json', maxRows: 150, maxChars: 100_000, ceiling: CEILING, offset: 50 });
    await new Promise((r) => setTimeout(r, 20));
    await session.append(all.slice(100, 300));
    session.finish();
    const page = JSON.parse((await pending).blocks[0]);
    expect(page.rows).toEqual(all.slice(50, 200));
    expect(page.hasMore).toBe(true);
    await store.closeAll();
  });

  test('table pages report contiguous ranges', async () => {
    const store = newStore();
    const all = rowsOf(Array.from({ length: 250 }, (_, i) => `v${i}`));
    const session = (await store.createSpool(COLUMNS, { totalRows: 250 })) as SpoolSession;
    await session.append(all);
    session.finish();
    const first = (await store.fetch(session.id, { format: 'table', maxRows: 100, maxChars: 100_000, ceiling: CEILING })).blocks[0];
    expect(first).toContain('Rows 1–100 of 250.');
    expect(first).toContain(`More rows: fetch_rows {"resultId":"${session.id}"}`);
    const second = (await store.fetch(session.id, { format: 'table', maxRows: 100, maxChars: 100_000, ceiling: CEILING })).blocks[0];
    expect(second).toContain('Rows 101–200 of 250.');
    const third = (await store.fetch(session.id, { format: 'table', maxRows: 100, maxChars: 100_000, ceiling: CEILING })).blocks[0];
    expect(third).toContain('Rows 201–250 of 250.');
    expect(third).not.toContain('More rows');
    await store.closeAll();
  });
});

async function openCursorSession(store: ResultStore, pool: FakePool, total: number, served: number, opts: { fetchDelayMs?: number } = {}) {
  fakeDb.define('select id, v from t', {
    columns: [{ name: 'id', oid: 25 }, { name: 'v', oid: 1043 }],
    rows: () => (function* () { for (let i = 0; i < total; i++) yield [String(i), `v${i}`]; })(),
    rowCount: total,
    fetchDelayMs: opts.fetchDelayMs,
  });
  const lease = await Lease.acquire(pool as never);
  const engine = await detectEngine(pool as never, lease);
  const reader = await CursorReader.open(lease, 'select id, v from t', engine);
  const first = served > 0 ? await reader.fetch(served) : [];
  const session = store.createCursor(COLUMNS, { lease, reader, carry: [], position: first.length, totalRows: total, fetchBatch: 64, timeoutMs: 0 });
  return { session, lease, first };
}

describe('Property 2: paging completeness (open-cursor mode)', () => {
  test('pages read forward concatenate to the full result, then the cursor closes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_500 }),
        fc.integer({ min: 0, max: 50 }),
        fc.array(fc.record({ maxRows: fc.integer({ min: 1, max: 300 }), format: fc.constantFrom<'json' | 'csv'>('json', 'csv') }), { minLength: 1, maxLength: 5 }),
        async (total, servedWanted, pages) => {
          fakeDb.reset();
          __resetEngineCache();
          const store = newStore();
          const pool = new FakePool();
          const served = Math.min(servedWanted, total);
          const { session, first } = await openCursorSession(store, pool, total, served);
          const cursor = session as CursorSession;
          const got: unknown[][] = [...first];
          for (let n = 0; n < 10_000; n++) {
            const p = pages[n % pages.length];
            const page = await store.fetch(cursor.id, { format: p.format, maxRows: p.maxRows, maxChars: 1_000_000, ceiling: CEILING });
            got.push(...pageRows(p.format, page.blocks));
            if (!hasMore(p.format, page.blocks)) break;
          }
          expect(got).toEqual(Array.from({ length: total }, (_, i) => [String(i), `v${i}`]));
          expect(cursor.mode).toBe('closed');
          expect(store.openCursorCount).toBe(0);
          expect(pool.checkedOutCount).toBe(0);
          expect(fakeDb.leakedTransactions()).toHaveLength(0);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);

  test('only forward offsets are accepted; skipping ahead discards the rows in between', async () => {
    const store = newStore();
    const pool = new FakePool();
    const { session } = await openCursorSession(store, pool, 500, 10);
    const s = session as CursorSession;
    await expect(store.fetch(s.id, { format: 'json', maxRows: 5, maxChars: 100_000, ceiling: CEILING, offset: 3 })).rejects.toThrow(ForwardOnlyError);
    await expect(store.fetch(s.id, { format: 'json', maxRows: 5, maxChars: 100_000, ceiling: CEILING, offset: 3 })).rejects.toThrow('current position is 10');
    const page = JSON.parse((await store.fetch(s.id, { format: 'json', maxRows: 5, maxChars: 100_000, ceiling: CEILING, offset: 200 })).blocks[0]);
    expect(page.offset).toBe(200);
    expect(page.rows[0]).toEqual(['200', 'v200']);
    expect(page.totalRows).toBe(500);
    expect(s.position).toBe(205);
    await expect(store.fetch(s.id, { format: 'json', maxRows: 5, maxChars: 100_000, ceiling: CEILING, offset: 900 })).rejects.toBeInstanceOf(OffsetOutOfRangeError);
    expect(s.mode).toBe('closed');
    expect(pool.checkedOutCount).toBe(0);
  });
});

describe('Property 8 (store level): resource bounds', () => {
  test('open cursors never exceed the limit, and a slot frees when a cursor closes', async () => {
    const store = newStore({ maxOpenCursors: 2 });
    const pool = new FakePool();
    const a = await openCursorSession(store, pool, 50, 1);
    fakeDb.results.clear();
    const b = await openCursorSession(store, pool, 50, 1);
    expect(a.session).toBeInstanceOf(CursorSession);
    expect(b.session).toBeInstanceOf(CursorSession);
    expect(store.canOpenCursor()).toBe(false);
    const c = await openCursorSession(store, pool, 50, 1);
    expect(c.session).toBeNull();
    c.lease.release();
    expect(store.openCursorCount).toBe(2);
    await store.fetch((a.session as CursorSession).id, { format: 'json', maxRows: 1_000, maxChars: 1_000_000, ceiling: CEILING });
    expect(store.openCursorCount).toBe(1);
    expect(store.canOpenCursor()).toBe(true);
    await store.closeAll();
    expect(pool.checkedOutCount).toBe(0);
  });

  test('for any interleaving, spool bytes stay within the budget and evictions are least-recently-used spooled results only', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant<'spool'>('spool'), rows: fc.integer({ min: 1, max: 400 }) }),
            fc.record({ op: fc.constant<'read'>('read'), pick: fc.nat() }),
          ),
          { minLength: 1, maxLength: 25 },
        ),
        async (ops) => {
          const budget = 20_000;
          const store = newStore({ spoolMaxTotalBytes: budget });
          const live: SpoolSession[] = [];
          let clock = 0;
          for (const op of ops) {
            if (op.op === 'spool') {
              const rows = rowsOf(Array.from({ length: op.rows }, (_, i) => `row-${i}`));
              const estimate = rows.reduce((sum, r) => sum + JSON.stringify(r).length + 1, 0);
              const before = new Map(live.map((s) => [s, s.mode]));
              const session = await store.createSpool(COLUMNS, { totalRows: rows.length, reserveBytes: estimate });
              if (estimate > budget) {
                expect(session).toBeNull();
              } else {
                expect(session).not.toBeNull();
                const s = session as SpoolSession;
                await s.append(rows);
                s.finish();
                s.lastAccess = ++clock;
                // Anything evicted was spooled, and older than every survivor.
                const evicted = [...before.keys()].filter((x) => before.get(x) === 'spooled' && x.mode === 'evicted');
                const survivors = live.filter((x) => x.mode === 'spooled');
                for (const e of evicted) for (const k of survivors) expect(e.lastAccess).toBeLessThanOrEqual(k.lastAccess);
                live.push(s);
              }
            } else if (live.length) {
              const s = live[op.pick % live.length];
              if (s.mode === 'spooled') {
                s.lastAccess = ++clock;
                const page = JSON.parse((await store.fetch(s.id, { format: 'json', maxRows: 3, maxChars: 10_000, ceiling: CEILING, offset: 0 })).blocks[0]);
                expect(page.rows.length).toBe(Math.min(3, s.rowsWritten));
                s.lastAccess = clock;
              } else {
                await expect(store.fetch(s.id, { format: 'json', maxRows: 3, maxChars: 10_000, ceiling: CEILING })).rejects.toBeInstanceOf(ResultUnavailableError);
              }
            }
            expect(store.spoolBytes).toBeLessThanOrEqual(budget);
            const counted = live.filter((s) => s.mode === 'spooled').reduce((sum, s) => sum + s.bytes, 0);
            expect(store.spoolBytes).toBe(counted);
          }
          await store.closeAll();
        },
      ),
      { numRuns: 60 },
    );
  }, 120_000);

  test('an open cursor is never closed to make room, and an evicted result explains itself', async () => {
    const rows = rowsOf(Array.from({ length: 60 }, (_, i) => `row-${i}`));
    const size = rows.reduce((sum, r) => sum + JSON.stringify(r).length + 1, 0);
    // Room for two of the three spools.
    const store = newStore({ spoolMaxTotalBytes: size * 2 + 10 });
    const pool = new FakePool();
    const { session: cursor } = await openCursorSession(store, pool, 100, 1);
    const a = (await store.createSpool(COLUMNS, { totalRows: 60, reserveBytes: size })) as SpoolSession;
    await a.append(rows);
    a.finish();
    a.lastAccess = 1;
    const b = (await store.createSpool(COLUMNS, { totalRows: 60, reserveBytes: size })) as SpoolSession;
    await b.append(rows);
    b.finish();
    b.lastAccess = 2;
    const c = (await store.createSpool(COLUMNS, { totalRows: 60, reserveBytes: size })) as SpoolSession;
    expect(c).not.toBeNull();
    expect(a.mode).toBe('evicted');
    expect(b.mode).toBe('spooled');
    expect((cursor as CursorSession).mode).toBe('cursor');
    const err = await store.fetch(a.id, { format: 'json', maxRows: 3, maxChars: 10_000, ceiling: CEILING }).catch((e) => e);
    expect(err).toBeInstanceOf(ResultUnavailableError);
    expect(err.message).toBe(`result ${a.id} is no longer available (it was evicted to make room for newer results (SQL_SPOOL_MAX_TOTAL_BYTES)). Re-run the query, or use export_query.`);
    await store.closeAll();
  });

  test('a result larger than the whole budget is not spooled', async () => {
    const store = newStore({ spoolMaxTotalBytes: 1_000 });
    expect(await store.createSpool(COLUMNS, { totalRows: 10, reserveBytes: 1_001 })).toBeNull();
    expect(store.spoolBytes).toBe(0);
  });
});

describe('open-cursor idle timeout', () => {
  test('expires after the idle TTL, releases the connection, and explains itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = newStore({ cursorIdleTtlMs: 1_000 });
    const pool = new FakePool();
    const { session } = await openCursorSession(store, pool, 100, 5);
    const s = session as CursorSession;
    await vi.advanceTimersByTimeAsync(999);
    expect(s.mode).toBe('cursor');
    await vi.advanceTimersByTimeAsync(2);
    await vi.waitFor(() => expect(s.mode).toBe('expired'));
    expect(store.openCursorCount).toBe(0);
    expect(pool.checkedOutCount).toBe(0);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
    const err = await store.fetch(s.id, { format: 'json', maxRows: 3, maxChars: 10_000, ceiling: CEILING }).catch((e) => e);
    expect(err).toBeInstanceOf(ResultUnavailableError);
    expect(err.message).toContain('closed after 1s without a fetch_rows call');
  });

  test('never fires while a page is being read, and restarts after each call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = newStore({ cursorIdleTtlMs: 1_000 });
    const pool = new FakePool();
    const { session } = await openCursorSession(store, pool, 1_000, 5);
    const s = session as CursorSession;
    // Every later FETCH takes 5 seconds: longer than the idle TTL.
    (fakeDb.resolve('select id, v from t') as { fetchDelayMs?: number }).fetchDelayMs = 5_000;
    const reading = store.fetch(s.id, { format: 'json', maxRows: 10, maxChars: 100_000, ceiling: CEILING });
    await vi.advanceTimersByTimeAsync(3_000);
    // Three times the TTL has passed, but the page is still being read.
    expect(s.mode).toBe('cursor');
    // The FETCH completes at 5s; the idle timer starts then.
    await vi.advanceTimersByTimeAsync(2_000);
    const page = JSON.parse((await reading).blocks[0]);
    expect(page.rows[0]).toEqual(['5', 'v5']);
    await vi.advanceTimersByTimeAsync(900);
    expect(s.mode).toBe('cursor');
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(s.mode).toBe('expired'));
    expect(pool.checkedOutCount).toBe(0);
  });
});

describe('spool failures', () => {
  test('no spool (and so no paging) when free space is already below the reserve', async () => {
    const store = newStore({ minFreeBytes: 1_000_000 }, { statfs: lowSpaceAfter(0) });
    expect(await store.createSpool(COLUMNS, { totalRows: 10 })).toBeNull();
    expect(store.spoolBytes).toBe(0);
  });

  test('a low-disk stop while spooling fails the result, deletes its file, and returns its budget', async () => {
    const store = newStore({ minFreeBytes: 1_000_000 }, { statfs: lowSpaceAfter(1), freeSpaceCheckEveryBytes: 1_024 });
    const session = (await store.createSpool(COLUMNS, { totalRows: null })) as SpoolSession;
    const rows = rowsOf(Array.from({ length: 200 }, (_, i) => `row-${i}`));
    const err = await session.append(rows).catch((e) => e);
    expect(err).toBeInstanceOf(DiskNearlyFullError);
    session.fail(err);
    expect(store.spoolBytes).toBe(0);
    const fetchErr = await store.fetch(session.id, { format: 'json', maxRows: 3, maxChars: 10_000, ceiling: CEILING }).catch((e) => e);
    expect(fetchErr).toBeInstanceOf(ResultUnavailableError);
    expect(fetchErr.message).toContain('spooling it failed: Disk nearly full');
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.readdirSync(store.files.spoolDir)).toEqual([]);
  });

  test('a size cap stops spooling with SpoolLimitError', async () => {
    const store = newStore();
    const session = (await store.createSpool(COLUMNS, { totalRows: null, capBytes: 500 })) as SpoolSession;
    const err = await session.append(rowsOf(Array.from({ length: 100 }, (_, i) => `row-${i}`))).catch((e) => e);
    expect(err).toBeInstanceOf(SpoolLimitError);
    expect(err.reason).toBe('too-large');
    await store.closeAll();
  });

  test('a waiting fetch sees the failure', async () => {
    const store = newStore();
    const session = (await store.createSpool(COLUMNS, { totalRows: 100 })) as SpoolSession;
    await session.append(rowsOf(['a', 'b']));
    const pending = store.fetch(session.id, { format: 'json', maxRows: 50, maxChars: 10_000, ceiling: CEILING }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    session.fail(new Error('network gone'));
    const err = await pending;
    expect(err).toBeInstanceOf(ResultUnavailableError);
    expect(err.message).toContain('spooling it failed: network gone');
  });
});

describe('store lifecycle', () => {
  test('an unknown result ID explains that results do not survive a restart', async () => {
    const store = newStore();
    const req: PageRequest = { format: 'table', maxRows: 10, maxChars: 10_000, ceiling: CEILING };
    const err = await store.fetch('r_aaaaaaaaaaaaaaaa', req).catch((e) => e);
    expect(err).toBeInstanceOf(ResultUnavailableError);
    expect(err.message).toBe('result r_aaaaaaaaaaaaaaaa is no longer available (unknown result ID; results are kept only until the server restarts). Re-run the query, or use export_query.');
  });

  test('closeAll closes open cursors, releases connections and deletes spool files', async () => {
    const store = newStore();
    const pool = new FakePool();
    const { session } = await openCursorSession(store, pool, 100, 3);
    const spool = (await store.createSpool(COLUMNS, { totalRows: 2 })) as SpoolSession;
    await spool.append(rowsOf(['a', 'b']));
    spool.finish();
    await store.closeAll();
    expect((session as CursorSession).mode).toBe('closed');
    expect(pool.checkedOutCount).toBe(0);
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.readdirSync(store.files.spoolDir)).toEqual([]);
    const err = await store.fetch(spool.id, { format: 'json', maxRows: 3, maxChars: 10_000, ceiling: CEILING }).catch((e) => e);
    expect(err.message).toContain('the server shut down');
    expect(await store.createSpool(COLUMNS, { totalRows: 1 })).toBeNull();
  });
});
