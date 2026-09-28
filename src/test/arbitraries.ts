/**
 * Shared fast-check arbitraries for result sets, raw wire values per type OID, and SQL scripts.
 */
import fc from 'fast-check';

export const OIDS = {
  BOOL: 16,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  FLOAT4: 700,
  FLOAT8: 701,
  BPCHAR: 1042,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  INTERVAL: 1186,
  NUMERIC: 1700,
  SUPER: 4000,
} as const;

const digits = (min: number, max: number) =>
  fc.array(fc.constantFrom(...'0123456789'.split('')), { minLength: min, maxLength: max }).map((d) => d.join(''));

const pad2 = (n: number) => String(n).padStart(2, '0');

export const dateText = fc
  .record({ y: fc.integer({ min: 1990, max: 2035 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) })
  .map(({ y, m, d }) => `${y}-${pad2(m)}-${pad2(d)}`);

export const timeText = fc
  .record({ h: fc.integer({ min: 0, max: 23 }), mi: fc.integer({ min: 0, max: 59 }), s: fc.integer({ min: 0, max: 59 }) })
  .map(({ h, mi, s }) => `${pad2(h)}:${pad2(mi)}:${pad2(s)}`);

const plainChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.'.split('');
/** Characters that break naive formats: separators, quotes, newlines, table pipes. */
const trickyChars = [',', '"', "'", '\n', '\r', '|', ';', '\t', '\\'];

export const plainText = fc.array(fc.constantFrom(...plainChars), { minLength: 0, maxLength: 12 }).map((c) => c.join(''));

export const trickyText = fc
  .array(fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...plainChars) }, { weight: 1, arbitrary: fc.constantFrom(...trickyChars) }), {
    minLength: 0,
    maxLength: 16,
  })
  .map((c) => c.join(''));

/** Text values including the literal string 'NULL' and the empty string. */
export const varcharText = fc.oneof(
  { weight: 6, arbitrary: trickyText },
  { weight: 1, arbitrary: fc.constant('NULL') },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constant('a | b') },
);

export function rawTextFor(oid: number): fc.Arbitrary<string> {
  switch (oid) {
    case OIDS.BOOL:
      return fc.constantFrom('t', 'f');
    case OIDS.INT2:
      return fc.integer({ min: -32768, max: 32767 }).map(String);
    case OIDS.INT4:
      return fc.integer({ min: -2147483648, max: 2147483647 }).map(String);
    case OIDS.INT8:
      return fc.tuple(fc.constantFrom('', '-'), fc.constantFrom('1', '9'), digits(0, 18)).map(([s, a, b]) => `${s}${a}${b}`);
    case OIDS.NUMERIC:
      return fc.tuple(fc.constantFrom('', '-'), digits(1, 12), digits(1, 6)).map(([s, a, b]) => `${s}${a}.${b}`);
    case OIDS.FLOAT4:
    case OIDS.FLOAT8:
      return fc.oneof(
        { weight: 8, arbitrary: fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e12, max: 1e12 }).map((n) => String(n)) },
        { weight: 1, arbitrary: fc.constantFrom('NaN', 'Infinity', '-Infinity') },
      );
    case OIDS.DATE:
      return dateText;
    case OIDS.TIME:
      return timeText;
    case OIDS.TIMESTAMP:
      return fc.tuple(dateText, timeText).map(([d, t]) => `${d} ${t}`);
    case OIDS.TIMESTAMPTZ:
      return fc.tuple(dateText, timeText, fc.constantFrom('+00', '+05:30', '-07')).map(([d, t, z]) => `${d} ${t}${z}`);
    case OIDS.INTERVAL:
      return fc.oneof(
        fc.tuple(fc.integer({ min: 1, max: 400 }), timeText).map(([d, t]) => `${d} days ${t}`),
        timeText,
        fc.integer({ min: 1, max: 5 }).map((y) => `${y} years 2 mons`),
      );
    case OIDS.SUPER:
      return fc.oneof(fc.constant('{"a":1}'), fc.constant('[1,2,3]'), plainText.map((s) => JSON.stringify(s)));
    default:
      return varcharText;
  }
}

export const cellOidArb = fc.constantFrom<number>(
  OIDS.BOOL, OIDS.INT2, OIDS.INT4, OIDS.INT8, OIDS.NUMERIC, OIDS.FLOAT8, OIDS.DATE, OIDS.TIME,
  OIDS.TIMESTAMP, OIDS.TIMESTAMPTZ, OIDS.INTERVAL, OIDS.VARCHAR, OIDS.SUPER,
);

const baseNames = ['id', 'name', 'event_date', 'campaign_id', 'installs', 'spend', 'channel', 'note'];

/** Column names, including duplicates and number-like names such as "2025". */
export const columnNameArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...baseNames) },
  { weight: 2, arbitrary: fc.array(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 1, maxLength: 6 }).map((c) => c.join('')) },
  { weight: 1, arbitrary: fc.constantFrom('2025', '2026', '1', '42') },
);

export interface GenColumn { name: string; oid: number }
export type GenRow = Array<string | null>;
export interface GenResult { columns: GenColumn[]; rows: GenRow[] }

export const columnsArb = (minLength = 1, maxLength = 6): fc.Arbitrary<GenColumn[]> =>
  fc.array(fc.record({ name: columnNameArb, oid: cellOidArb }), { minLength, maxLength });

export function rowArb(columns: GenColumn[], nullWeight = 1): fc.Arbitrary<GenRow> {
  return fc.tuple(
    ...columns.map((c) =>
      fc.oneof({ weight: 8, arbitrary: rawTextFor(c.oid) as fc.Arbitrary<string | null> }, { weight: nullWeight, arbitrary: fc.constant(null) }),
    ),
  ) as unknown as fc.Arbitrary<GenRow>;
}

export const resultSetArb = (opts: { minRows?: number; maxRows?: number; minCols?: number; maxCols?: number } = {}): fc.Arbitrary<GenResult> =>
  columnsArb(opts.minCols ?? 1, opts.maxCols ?? 6).chain((columns) =>
    fc
      .array(rowArb(columns), { minLength: opts.minRows ?? 0, maxLength: opts.maxRows ?? 150 })
      .map((rows) => ({ columns, rows })),
  );

/** SQL fragments that contain ';' in places where it must NOT split a statement. */
const trickyFragment = fc.oneof(
  plainText.map((t) => `'${t.replace(/'/g, "''")};x'`),
  plainText.map((t) => `"col;${t.replace(/"/g, '""')}"`),
  plainText.map((t) => `-- note; ${t.replace(/\n/g, ' ')}\n`),
  plainText.map((t) => `/* a; /* nested; */ ${t.replace(/\*\//g, '')} */`),
  plainText.map((t) => `$$body; ${t.replace(/\$\$/g, '')}$$`),
  plainText.map((t) => `$fn$ x; ${t.replace(/\$fn\$/g, '')} $fn$`),
  fc.constant("'it''s; fine'"),
  fc.constant("'back\\'slash; x'"),
);

const statementArb = fc
  .tuple(fc.constantFrom('select 1', 'select a from t', 'set search_path to x', 'insert into t values (1)', 'with q as (select 1) select * from q'), fc.array(trickyFragment, { maxLength: 3 }))
  .map(([head, frags]) => [head, ...frags].join(' '));

/** A list of statements (each free of top-level ';') and the script produced by joining them. */
export const scriptArb = fc.array(statementArb, { minLength: 1, maxLength: 5 }).map((statements) => ({
  statements,
  script: statements.join(';\n'),
}));
