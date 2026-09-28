/**
 * Page builder and renderers (design Component 7).
 *
 * Property 1: Page budget - within budget (except a lone oversized row), row boundaries, maximal.
 * Property 3: Exact values - csv/json round-trip; NULL distinct from 'NULL' and ''.
 * Property 4: Column alignment - one value per column, in order, for every format.
 * Property 5: Legacy table preservation - identical to today's formatResults.
 *
 * Validates: Requirements 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 4.5, 10.1, 10.2
 */
import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { PageBuilder, RowTooLargeError, type PageMeta, type Format } from './page';
import { typeName, toExact, type ColumnInfo } from './values';
import { formatResults } from './legacy';
import { sanitizeString, sanitizeRows, sanitizeColumns } from '../validation/sanitizer';
import { resultSetArb, rowArb, OIDS, type GenColumn, type GenRow } from '../test/arbitraries';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgTypes = require('pg-types');

const CEILING = 5_000_000;

function cols(columns: GenColumn[]): ColumnInfo[] {
  return columns.map((c) => ({ name: c.name, oid: c.oid, type: typeName(c.oid) }));
}

const worstMeta: PageMeta = {
  mode: 'run',
  offset: 0,
  totalRows: 999_999_999_999,
  hasMore: true,
  resultId: 'r_abcdefghijklmnop',
  executionTimeMs: 999_999_999,
  statements: Array.from({ length: 12 }, () => 'INSERT (999999999 rows)'),
};

/** RFC 4180 parser that reports whether each field was quoted (to tell NULL from ''). */
function parseCsv(text: string): Array<Array<{ value: string; quoted: boolean }>> {
  const records: Array<Array<{ value: string; quoted: boolean }>> = [];
  let record: Array<{ value: string; quoted: boolean }> = [];
  let i = 0;
  while (i <= text.length) {
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { value += '"'; i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        value += text[i++];
      }
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '\n') value += text[i++];
    }
    record.push({ value, quoted });
    if (i >= text.length) { records.push(record); break; }
    if (text[i] === ',') { i++; continue; }
    // Rendered CSV never ends with a newline, so a final "\n" is followed by one more record
    // (for example a single-column row whose value is NULL, rendered as an empty line).
    if (text[i] === '\n') { records.push(record); record = []; i++; }
  }
  return records;
}

function expectedCsvCell(raw: string | null, oid: number): { value: string; quoted: boolean } | { value: string } {
  if (raw === null) return { value: '', quoted: false };
  if (oid === OIDS.BOOL) return { value: raw === 't' ? 'true' : 'false' };
  const s = sanitizeString(raw);
  if (s === '') return { value: '', quoted: true };
  return { value: s };
}

function expectedJsonCell(raw: string | null, oid: number): unknown {
  const exact = toExact(raw, oid);
  return typeof exact === 'string' ? sanitizeString(exact) : exact;
}

function buildPages(rows: GenRow[], opts: { format: Format; columns: ColumnInfo[]; maxRows: number; maxChars: number }) {
  const pages: Array<{ builder: PageBuilder; start: number; end: number }> = [];
  let i = 0;
  while (i < rows.length) {
    const builder = new PageBuilder({ ...opts, ceiling: CEILING });
    const start = i;
    while (i < rows.length && builder.tryAdd(rows[i])) i++;
    pages.push({ builder, start, end: i });
    if (i === start) throw new Error('page builder made no progress');
  }
  return pages;
}

describe('Property 1: page budget', () => {
  test('pages stay within budget, end at row boundaries, are maximal, and cover every row', () => {
    fc.assert(
      fc.property(
        resultSetArb({ maxRows: 120 }),
        fc.constantFrom<Format>('table', 'csv', 'json'),
        fc.integer({ min: 1, max: 150 }),
        fc.integer({ min: 1000, max: 20_000 }),
        (rs, format, maxRows, maxChars) => {
          const columns = cols(rs.columns);
          const pages = buildPages(rs.rows, { format, columns, maxRows, maxChars });
          for (const { builder, start, end } of pages) {
            const size = builder.render(worstMeta).blocks.join('').length;
            if (builder.count > 1) expect(size).toBeLessThanOrEqual(maxChars);
            expect(builder.count).toBeLessThanOrEqual(maxRows);
            if (end < rs.rows.length && builder.count < maxRows) {
              const probe = new PageBuilder({ format, columns, maxRows, maxChars, ceiling: CEILING });
              for (const r of rs.rows.slice(start, end)) expect(probe.tryAdd(r)).toBe(true);
              expect(probe.tryAdd(rs.rows[end])).toBe(false);
            }
          }
          expect(pages.flatMap((p) => p.builder.rows)).toEqual(rs.rows);
        },
      ),
      { numRuns: 150 },
    );
  });

  test('a single row larger than the budget is returned alone if it fits the ceiling', () => {
    const columns: ColumnInfo[] = [{ name: 'note', oid: OIDS.VARCHAR, type: 'varchar' }];
    const big = ['x'.repeat(5_000)];
    const b = new PageBuilder({ format: 'csv', columns, maxRows: 100, maxChars: 1_000, ceiling: 10_000 });
    expect(b.tryAdd(big)).toBe(true);
    expect(b.isFull).toBe(true);
    expect(b.tryAdd(['small'])).toBe(false);
    const tight = new PageBuilder({ format: 'csv', columns, maxRows: 100, maxChars: 1_000, ceiling: 2_000 });
    expect(() => tight.tryAdd(big)).toThrow(RowTooLargeError);
  });
});

describe('Property 3: exact values round-trip through csv and json', () => {
  test('json rows decode to exact values; csv distinguishes NULL, empty and the text NULL', () => {
    fc.assert(
      fc.property(resultSetArb({ maxRows: 40 }), (rs) => {
        const columns = cols(rs.columns);
        const json = new PageBuilder({ format: 'json', columns, maxRows: 1000, maxChars: CEILING, ceiling: CEILING });
        const csv = new PageBuilder({ format: 'csv', columns, maxRows: 1000, maxChars: CEILING, ceiling: CEILING });
        for (const r of rs.rows) { json.tryAdd(r); csv.tryAdd(r); }
        const meta: PageMeta = { mode: 'run', offset: 0, totalRows: rs.rows.length, hasMore: false, resultId: null, executionTimeMs: 1 };

        const payload = JSON.parse(json.render(meta).blocks[0]);
        expect(payload.columns).toEqual(columns.map((c) => ({ name: sanitizeString(c.name), type: c.type })));
        payload.rows.forEach((row: unknown[], r: number) => {
          row.forEach((cell, c) => expect(cell).toEqual(expectedJsonCell(rs.rows[r][c], rs.columns[c].oid)));
        });

        const blocks = csv.render(meta).blocks;
        expect(blocks).toHaveLength(2);
        const records = parseCsv(blocks[0]);
        expect(records[0].map((f) => f.value)).toEqual(columns.map((c) => sanitizeString(c.name)));
        records.slice(1).forEach((record, r) => {
          record.forEach((field, c) => expect(field).toMatchObject(expectedCsvCell(rs.rows[r][c], rs.columns[c].oid)));
        });
        expect(records.length - 1).toBe(rs.rows.length);
      }),
      { numRuns: 150 },
    );
  });
});

describe('Property 4: column alignment', () => {
  test('every rendered row has exactly one value per column, including duplicate and number-like names', () => {
    fc.assert(
      fc.property(resultSetArb({ minRows: 1, maxRows: 30 }), (rs) => {
        const columns = cols(rs.columns);
        const meta: PageMeta = { mode: 'run', offset: 0, totalRows: rs.rows.length, hasMore: false, resultId: null, executionTimeMs: 1 };
        const json = new PageBuilder({ format: 'json', columns, maxRows: 1000, maxChars: CEILING, ceiling: CEILING });
        const csv = new PageBuilder({ format: 'csv', columns, maxRows: 1000, maxChars: CEILING, ceiling: CEILING });
        // Newlines inside values legitimately break table lines, so the table check uses one-line values.
        const oneLine = rs.rows.map((r) => r.map((v) => (v === null ? null : v.replace(/[\r\n]/g, ' '))));
        const table = new PageBuilder({ format: 'table', columns, maxRows: 1000, maxChars: CEILING, ceiling: CEILING });
        rs.rows.forEach((r, i) => { json.tryAdd(r); csv.tryAdd(r); table.tryAdd(oneLine[i]); });

        for (const row of JSON.parse(json.render(meta).blocks[0]).rows) expect(row).toHaveLength(columns.length);
        for (const record of parseCsv(csv.render(meta).blocks[0])) expect(record).toHaveLength(columns.length);
        const lines = table.render(meta).blocks[0].split('\n\n')[0].split('\n');
        const width = lines[0].length;
        for (const line of lines) expect(line.length).toBe(width);
      }),
      { numRuns: 150 },
    );
  });
});

describe('Property 5: legacy table preservation', () => {
  const nonObjectOids = [OIDS.BOOL, OIDS.INT2, OIDS.INT4, OIDS.INT8, OIDS.NUMERIC, OIDS.FLOAT8, OIDS.DATE, OIDS.TIME, OIDS.TIMESTAMP, OIDS.TIMESTAMPTZ, OIDS.VARCHAR];
  const legacySafeResult = fc
    .uniqueArray(fc.constantFrom('id', 'name', 'event_date', 'campaign_id', 'installs', 'spend', 'channel', 'note'), { minLength: 1, maxLength: 5 })
    .chain((names) => fc.tuple(fc.constant(names), fc.array(fc.constantFrom(...nonObjectOids), { minLength: names.length, maxLength: names.length })))
    .chain(([names, oids]) => {
      const columns = names.map((name, i) => ({ name, oid: oids[i] }));
      return fc.array(rowArb(columns), { minLength: 0, maxLength: 100 }).map((rows) => ({ columns, rows }));
    });

  test('table output equals today\'s formatResults for results of at most 100 rows', () => {
    fc.assert(
      fc.property(legacySafeResult, (rs) => {
        const parsedRows = rs.rows.map((r) => r.map((cell, i) => (cell === null ? null : pgTypes.getTypeParser(rs.columns[i].oid, 'text')(cell))));
        const oracle = formatResults({
          columns: sanitizeColumns(rs.columns.map((c) => c.name)),
          rows: sanitizeRows(parsedRows),
          rowCount: rs.rows.length,
          executionTime: 7,
        });
        const builder = new PageBuilder({ format: 'table', columns: cols(rs.columns), maxRows: 100, maxChars: 1_000_000, ceiling: CEILING });
        for (const r of rs.rows) expect(builder.tryAdd(r)).toBe(true);
        const rendered = builder.render({ mode: 'run', offset: 0, totalRows: rs.rows.length, hasMore: false, resultId: null, executionTimeMs: 7 });
        expect(rendered.blocks).toEqual([oracle]);
      }),
      { numRuns: 200 },
    );
  });
});

describe('status lines and envelopes', () => {
  const columns: ColumnInfo[] = [{ name: 'n', oid: OIDS.INT4, type: 'int4' }];
  const filled = (format: Format, n: number) => {
    const b = new PageBuilder({ format, columns, maxRows: 1000, maxChars: CEILING, ceiling: CEILING });
    for (let i = 0; i < n; i++) b.tryAdd([String(i)]);
    return b;
  };

  test('run/table: partial result keeps legacy lines and adds the paging line', () => {
    const text = filled('table', 3).render({ mode: 'run', offset: 0, totalRows: 1794, hasMore: true, resultId: 'r_abcdefghijklmnop', executionTimeMs: 2300 }).blocks[0];
    expect(text).toContain('\n... (1791 more rows)\n\n1794 rows returned. (2300ms)\n');
    expect(text.endsWith('More rows: fetch_rows {"resultId":"r_abcdefghijklmnop"}; full result: export_query')).toBe(true);
  });

  test('run/table: busy paging, unknown totals and earlier statements', () => {
    const busy = filled('table', 2).render({ mode: 'run', offset: 0, totalRows: 50, hasMore: true, resultId: null, pagingUnavailable: 'busy', executionTimeMs: 1 }).blocks[0];
    expect(busy).toContain('More rows exist, but paging is busy. Use export_query or narrow the query.');
    const unknown = filled('table', 2).render({ mode: 'run', offset: 0, totalRows: null, hasMore: true, resultId: 'r_abcdefghijklmnop', executionTimeMs: 1 }).blocks[0];
    expect(unknown).toContain('... (more rows)');
    expect(unknown).toContain('More than 2 rows returned. (1ms)');
    const script = filled('table', 1).render({ mode: 'run', offset: 0, totalRows: 1, hasMore: false, resultId: null, executionTimeMs: 1, statements: ['SET', 'INSERT (5 rows)'] }).blocks[0];
    expect(script.endsWith('1 rows returned. (1ms)\nEarlier statements: SET, INSERT (5 rows)')).toBe(true);
  });

  test('run/table: statements without rows keep the legacy message', () => {
    const b = new PageBuilder({ format: 'table', columns: [], maxRows: 100, maxChars: CEILING, ceiling: CEILING });
    expect(b.render({ mode: 'run', offset: 0, totalRows: 0, hasMore: false, resultId: null, executionTimeMs: 4, command: 'INSERT', rowsAffected: 5 }).blocks)
      .toEqual(['Query executed successfully. 5 rows affected. (4ms)']);
    expect(filled('table', 0).render({ mode: 'run', offset: 0, totalRows: 0, hasMore: false, resultId: null, executionTimeMs: 4 }).blocks)
      .toEqual(['Query executed successfully. 0 rows affected. (4ms)']);
  });

  test('fetch/table and csv status lines report the row range', () => {
    const page = filled('table', 3).render({ mode: 'fetch', offset: 100, totalRows: 1794, hasMore: true, resultId: 'r_abcdefghijklmnop', executionTimeMs: 0 }).blocks[0];
    expect(page.endsWith('\n\nRows 101–103 of 1794.\nMore rows: fetch_rows {"resultId":"r_abcdefghijklmnop"}')).toBe(true);
    const csvBlocks = filled('csv', 2).render({ mode: 'run', offset: 0, totalRows: 2, hasMore: false, resultId: null, executionTimeMs: 9 }).blocks;
    expect(csvBlocks).toEqual(['n\n0\n1', 'Rows 1–2 of 2. (9ms)']);
    const empty = filled('csv', 0).render({ mode: 'fetch', offset: 2, totalRows: 2, hasMore: false, resultId: null, executionTimeMs: 0 }).blocks;
    expect(empty[1]).toBe('No rows at offset 2 (total 2).');
  });

  test('json envelope carries the fields client programs rely on, and paging metadata', () => {
    const payload = JSON.parse(filled('json', 2).render({ mode: 'run', offset: 0, totalRows: 10, hasMore: true, resultId: 'r_abcdefghijklmnop', executionTimeMs: 172, statements: ['SET'] }).blocks[0]);
    expect(payload).toEqual({
      columns: [{ name: 'n', type: 'int4' }],
      rows: [[0], [1]],
      rowCount: 2,
      offset: 0,
      totalRows: 10,
      hasMore: true,
      truncated: true,
      resultId: 'r_abcdefghijklmnop',
      executionTimeMs: 172,
      statements: ['SET'],
    });
    const none = new PageBuilder({ format: 'json', columns: [], maxRows: 100, maxChars: CEILING, ceiling: CEILING });
    expect(JSON.parse(none.render({ mode: 'run', offset: 0, totalRows: 0, hasMore: false, resultId: null, executionTimeMs: 3, command: 'INSERT', rowsAffected: 5 }).blocks[0]))
      .toMatchObject({ columns: [], rows: [], rowCount: 0, command: 'INSERT', rowsAffected: 5, truncated: false });
  });
});
