/**
 * Statement splitter and classifier.
 *
 * Property 7: Splitter safety - never splits inside quotes, quoted identifiers, comments or
 * dollar-quoted bodies; joining statements reproduces the input apart from separators;
 * unterminated input is reported as incomplete.
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 */
import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { splitStatements } from './split';
import { classifyStatement, planScript } from './classify';
import { scriptArb } from '../test/arbitraries';

describe('Property 7: splitter safety', () => {
  test('splitting a joined script returns exactly the original statements', () => {
    fc.assert(
      fc.property(scriptArb, ({ statements, script }) => {
        const result = splitStatements(script);
        expect(result.complete).toBe(true);
        expect(result.statements).toEqual(statements.map((s) => s.trim()));
      }),
      { numRuns: 300 },
    );
  });

  test('unterminated quotes, identifiers, comments and dollar quotes are reported incomplete', () => {
    for (const sql of ["select 'abc", 'select "abc', 'select 1 /* open', 'select $$ body', 'select $t$ x $u$']) {
      expect(splitStatements(sql).complete).toBe(false);
    }
  });
});

describe('splitter cases', () => {
  test('simple, trailing and repeated separators', () => {
    expect(splitStatements('select 1; select 2').statements).toEqual(['select 1', 'select 2']);
    expect(splitStatements('select 1;').statements).toEqual(['select 1']);
    expect(splitStatements(';;select 1;;').statements).toEqual(['select 1']);
  });

  test('separators inside literals, identifiers, comments and dollar quotes do not split', () => {
    expect(splitStatements("select ';' as a").statements).toHaveLength(1);
    expect(splitStatements("select 'it''s; ok'").statements).toHaveLength(1);
    expect(splitStatements("select 'back\\'slash; x'").statements).toHaveLength(1);
    expect(splitStatements('select 1 as "a;b"').statements).toHaveLength(1);
    expect(splitStatements('select 1 -- trailing; comment\n; select 2').statements).toHaveLength(2);
    expect(splitStatements('/* a /* nested; */ b; */ select 1; select 2').statements).toHaveLength(2);
    expect(splitStatements('select $$a;b$$; select $fn$ x; y $fn$').statements).toHaveLength(2);
  });

  test('comment-only and empty statements are dropped', () => {
    expect(splitStatements('-- just a comment').statements).toEqual([]);
    expect(splitStatements('/* c */ ; select 1').statements).toEqual(['select 1']);
    expect(splitStatements('').statements).toEqual([]);
  });

  test('$1-style placeholders are not dollar quotes', () => {
    expect(splitStatements('select $1; select $2').statements).toEqual(['select $1', 'select $2']);
  });
});

describe('classifier', () => {
  test('keywords map to kinds', () => {
    expect(classifyStatement('select 1').kind).toBe('rows');
    expect(classifyStatement('  /* c */ -- x\n WITH q AS (select 1) select * from q').kind).toBe('rows');
    expect(classifyStatement('(select 1) union (select 2)').kind).toBe('rows');
    expect(classifyStatement('BEGIN').kind).toBe('transaction');
    expect(classifyStatement('start transaction').kind).toBe('transaction');
    expect(classifyStatement('commit').kind).toBe('transaction');
    expect(classifyStatement('END').kind).toBe('transaction');
    expect(classifyStatement('rollback').kind).toBe('transaction');
    expect(classifyStatement('declare c cursor for select 1').kind).toBe('transaction');
    expect(classifyStatement("SET search_path TO 'x'").kind).toBe('session');
    expect(classifyStatement('reset all').kind).toBe('session');
    expect(classifyStatement('create temp table t as select 1').kind).toBe('session');
    expect(classifyStatement('CREATE TEMPORARY TABLE t (a int)').kind).toBe('session');
    expect(classifyStatement('create local temp table t (a int)').kind).toBe('session');
    expect(classifyStatement('create table t (a int)').kind).toBe('other');
    expect(classifyStatement('insert into t values (1)').kind).toBe('other');
    expect(classifyStatement('show search_path').kind).toBe('other');
  });

  test('session changes are detected', () => {
    expect(classifyStatement('set x to 1').changesSession).toBe(true);
    expect(classifyStatement('select * into temp t from x').changesSession).toBe(true);
    expect(classifyStatement('select 1').changesSession).toBe(false);
    expect(classifyStatement('insert into t values (1)').changesSession).toBe(false);
  });

  test('planScript describes scripts', () => {
    const p = planScript("set search_path to 'x'; select 1");
    expect(p.complete).toBe(true);
    expect(p.isScript).toBe(true);
    expect(p.prefix.map((s) => s.keyword)).toEqual(['set']);
    expect(p.last?.kind).toBe('rows');
    expect(p.changesSession).toBe(true);
    expect(p.hasTransactionControl).toBe(false);

    expect(planScript('begin; select 1; commit').hasTransactionControl).toBe(true);

    const single = planScript('select 1;');
    expect(single.isScript).toBe(false);
    expect(single.changesSession).toBe(false);
    expect(single.last?.text).toBe('select 1');

    const broken = planScript("select 'oops");
    expect(broken.complete).toBe(false);
    expect(broken.statements).toHaveLength(1);

    expect(planScript('-- nothing').last).toBeNull();
  });
});
