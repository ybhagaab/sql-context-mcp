/**
 * Value conversion (exact and legacy) and type names (design Component 6).
 *
 * Property 3 (value level): exact conversion is lossless and keeps NULL distinct from 'NULL'.
 *
 * Validates: Requirements 4.1, 4.2, 4.4
 */
import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { toExact, toLegacyDisplay, typeName, registerTypeNames, unknownOids, columnsFromFields } from './values';
import { OIDS, cellOidArb, rawTextFor } from '../test/arbitraries';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgTypes = require('pg-types');

describe('exact conversion', () => {
  test('per-OID rules', () => {
    expect(toExact('42', OIDS.INT4)).toBe(42);
    expect(toExact('-7', OIDS.INT2)).toBe(-7);
    expect(toExact('12345678901234567', OIDS.INT8)).toBe('12345678901234567');
    expect(toExact('1.10', OIDS.NUMERIC)).toBe('1.10');
    expect(toExact('3.5', OIDS.FLOAT8)).toBe(3.5);
    expect(toExact('NaN', OIDS.FLOAT8)).toBe('NaN');
    expect(toExact('Infinity', OIDS.FLOAT4)).toBe('Infinity');
    expect(toExact('t', OIDS.BOOL)).toBe(true);
    expect(toExact('f', OIDS.BOOL)).toBe(false);
    expect(toExact('2026-09-05', OIDS.DATE)).toBe('2026-09-05');
    expect(toExact('2026-09-05 04:41:12+00', OIDS.TIMESTAMPTZ)).toBe('2026-09-05 04:41:12+00');
    expect(toExact('1 day 02:00:00', OIDS.INTERVAL)).toBe('1 day 02:00:00');
    expect(toExact('NULL', OIDS.VARCHAR)).toBe('NULL');
    expect(toExact(null, OIDS.VARCHAR)).toBeNull();
    expect(toExact(undefined, OIDS.INT4)).toBeNull();
  });

  test('Property 3 (value level): exact values decode back to the warehouse value for every type', () => {
    fc.assert(
      fc.property(cellOidArb.chain((oid) => fc.tuple(fc.constant(oid), rawTextFor(oid))), ([oid, raw]) => {
        const exact = toExact(raw, oid);
        const decoded = JSON.parse(JSON.stringify(exact));
        if (oid === OIDS.INT2 || oid === OIDS.INT4) {
          expect(decoded).toBe(Number(raw));
        } else if (oid === OIDS.FLOAT8 || oid === OIDS.FLOAT4) {
          if (Number.isFinite(Number(raw))) expect(decoded).toBe(Number(raw));
          else expect(decoded).toBe(raw);
        } else if (oid === OIDS.BOOL) {
          expect(decoded).toBe(raw === 't');
        } else {
          expect(decoded).toBe(raw);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('legacy display (table format keeps today\'s look)', () => {
  test('matches String() of the default pg parser for non-object types', () => {
    for (const [raw, oid] of [
      ['2026-09-05', OIDS.DATE],
      ['2026-09-05 10:11:12', OIDS.TIMESTAMP],
      ['2026-09-05 10:11:12+05:30', OIDS.TIMESTAMPTZ],
      ['3.5', OIDS.FLOAT8],
      ['t', OIDS.BOOL],
      ['12345678901234567', OIDS.INT8],
      ['a | b', OIDS.VARCHAR],
    ] as Array<[string, number]>) {
      expect(toLegacyDisplay(raw, oid)).toBe(String(pgTypes.getTypeParser(oid, 'text')(raw)));
    }
  });

  test('object-producing types render as warehouse text instead of [object Object]', () => {
    expect(toLegacyDisplay('1 day 02:00:00', OIDS.INTERVAL)).toBe('1 day 02:00:00');
    expect(toLegacyDisplay('{"a":1}', 114)).toBe('{"a":1}');
    expect(toLegacyDisplay('{1,2}', 1007)).toBe('{1,2}');
  });

  test('null and non-string inputs', () => {
    expect(toLegacyDisplay(null, OIDS.VARCHAR)).toBe('NULL');
    expect(toLegacyDisplay(undefined, OIDS.VARCHAR)).toBe('NULL');
    expect(toLegacyDisplay(5, 0)).toBe('5');
    expect(toLegacyDisplay(true, 0)).toBe('true');
  });
});

describe('type names', () => {
  test('builtins resolve to lower-case pg names', () => {
    expect(typeName(OIDS.DATE)).toBe('date');
    expect(typeName(OIDS.FLOAT8)).toBe('float8');
    expect(typeName(OIDS.INT8)).toBe('int8');
    expect(typeName(OIDS.VARCHAR)).toBe('varchar');
    expect(typeName(OIDS.TIMESTAMPTZ)).toBe('timestamptz');
    expect(typeName(OIDS.INTERVAL)).toBe('interval');
  });

  test('unknown OIDs fall back to the OID as a string until registered', () => {
    expect(typeName(99001)).toBe('99001');
    expect(unknownOids([OIDS.DATE, 99001, 99001])).toEqual([99001]);
    registerTypeNames({ 99001: 'super' });
    expect(typeName(99001)).toBe('super');
    expect(unknownOids([99001])).toEqual([]);
  });

  test('columnsFromFields keeps order and duplicate names', () => {
    const cols = columnsFromFields([
      { name: 'id', dataTypeID: OIDS.INT4 },
      { name: 'id', dataTypeID: OIDS.INT4 },
      { name: '2025', dataTypeID: OIDS.INT8 },
    ]);
    expect(cols).toEqual([
      { name: 'id', oid: OIDS.INT4, type: 'int4' },
      { name: 'id', oid: OIDS.INT4, type: 'int4' },
      { name: '2025', oid: OIDS.INT8, type: 'int8' },
    ]);
  });
});
