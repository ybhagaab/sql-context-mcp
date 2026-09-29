/**
 * Error descriptions and connection_status through the tools, against the fake database and a
 * fake network: SQL positions in scripts, no retry after data-changing SQL was sent, export and
 * fetch_rows failures, catalog errors, and each connection_status path.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { fakeDb, FakePool, FakeColumn, dbError, connectionError } from '../test/fake-pg';
import { setupFakeDb, makeRuntime, teardown, call, textOf, jsonOf, lazyRows, until, fakeNetwork } from '../test/harness';
import { INFO_SQL, statusLimits } from '../diagnostics';
import { getActivePool, __setTestConnectionState } from '../db/pool';
import type { Runtime } from '../runtime';

const ID_NAME: FakeColumn[] = [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }];
const REDSHIFT_VERSION = 'PostgreSQL 8.0.2 on i686-pc-linux-gnu, compiled by GCC gcc (GCC) 3.4.2 20041017 (Red Hat 3.4.2-6.fc3), Redshift 1.0.99999';

let pool: FakePool;
let rt: Runtime;
const savedLimits = { ...statusLimits };

function defineInfo(): void {
  fakeDb.define(INFO_SQL, {
    columns: [{ name: 'database', oid: 25 }, { name: 'user', oid: 25 }, { name: 'host', oid: 25 }, { name: 'version', oid: 25 }],
    rows: [['fake-db', 'fake-user', '10.0.0.5', REDSHIFT_VERSION]],
  });
}

function lastLine(text: string): string {
  const lines = text.split('\n');
  return lines[lines.length - 1];
}

beforeEach(() => {
  pool = setupFakeDb();
  rt = makeRuntime();
  defineInfo();
});

afterEach(async () => {
  Object.assign(statusLimits, savedLimits);
  delete process.env.SQL_CONNECT_TIMEOUT_MS;
  await teardown();
});

describe('run_query errors', () => {
  test('a SQL error in a script shows the statement, the position and what had completed', async () => {
    const failing = 'select * from missing_table where id = 1';
    fakeDb.define(failing, { error: Object.assign(dbError('42P01', 'relation "missing_table" does not exist'), { position: '15' }) });
    const result = await call(rt, 'run_query', { sql: `set search_path to 'x';\n${failing};\nselect 1` });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Error: relation "missing_table" does not exist\n' +
      'To fix: Check the table name and schema (list_schemas and list_tables show what exists), and write it as schema.table if it is not in the search path.\n' +
      'At line 2, column 15:\n' +
      `  ${failing};\n` +
      `  ${' '.repeat(14)}^\n` +
      'Error type: sql_error (SQLSTATE 42P01 undefined_table). Statement 2 of 3 failed and made no changes; the statements after it did not run. ' +
      'The statements before it had completed: SET.',
    );
  });

  test('a data-changing statement is not re-sent after a lost connection', async () => {
    fakeDb.define('insert into t values (1)', { command: 'INSERT', rowCount: 1 });
    fakeDb.failWhen(/^insert/i, connectionError(), 1);
    const text = textOf(await call(rt, 'run_query', { sql: 'insert into t values (1)' }));
    expect(text.split('\n')[0]).toBe('Error: Lost the connection to the database while the SQL was running (Connection terminated unexpectedly).');
    expect(text).toContain('To fix: Check whether the statement took effect before running it again.');
    expect(lastLine(text)).toBe('Error type: connection_lost. The statement may or may not have completed; check before re-running it.');
    expect(fakeDb.statementsMatching(/^insert into t/)).toHaveLength(1);
  });

  test('a read-only statement is still retried on a fresh connection', async () => {
    fakeDb.define('select id, name from t', { columns: ID_NAME, rows: [['1', 'a']] });
    fakeDb.failWhen(/^DECLARE/i, connectionError(), 1);
    expect(textOf(await call(rt, 'run_query', { sql: 'select id, name from t' }))).toContain('1 rows returned.');
  });

  test('a connection that cannot be opened: no SQL was run', async () => {
    fakeNetwork.probe = 'timeout';
    fakeDb.failWhen('connect', Object.assign(new Error('timeout expired')), 5);
    const text = textOf(await call(rt, 'run_query', { sql: 'select 1' }));
    expect(text).toMatch(/^Error: Could not reach the database server at fake-host:5439: the connection attempt timed out\./);
    expect(text).toContain('private address (10.0.0.5)');
    expect(lastLine(text)).toBe('Error type: network_timeout. No SQL was run.');
  });

  test('catalog tools: a permission error without an SQL status sentence', async () => {
    fakeDb.failWhen(/information_schema\.tables/, dbError('42501', 'permission denied for relation tables'), 1);
    const text = textOf(await call(rt, 'list_tables', { schema: 'x' }));
    expect(text.split('\n')[0]).toBe('Error: permission denied for relation tables');
    expect(lastLine(text)).toBe('Error type: permission_denied (SQLSTATE 42501 insufficient_privilege).');
  });
});

describe('export and fetch_rows errors', () => {
  test('export_status reports the description and the error type', async () => {
    fakeDb.define('select id, name from t', { columns: ID_NAME, rows: lazyRows(100), rowCount: 100 });
    fakeDb.failWhen('__row_5__', connectionError(), 1);
    const started = jsonOf(await call(rt, 'export_query', { sql: 'select id, name from t', wait: false }));
    await until(() => rt.exports.list().every((j) => j.isFinished), 3_000, 'export');
    const status = jsonOf(await call(rt, 'export_status', { exportId: started.exportId }));
    expect(status.state).toBe('failed');
    expect(status.errorType).toBe('connection_lost');
    expect(status.error).toMatch(/^Lost the connection to the database while exporting \(Connection terminated unexpectedly\)\./);
  });

  test('fetch_rows on an open cursor: the result is closed', async () => {
    rt = makeRuntime({ spoolThresholdBytes: 0 });
    fakeDb.define('select id, name from big', { columns: ID_NAME, rows: lazyRows(300), rowCount: 300 });
    const first = jsonOf(await call(rt, 'run_query', { sql: 'select id, name from big', format: 'json' }));
    fakeDb.failWhen(/^FETCH/i, connectionError(), 1);
    const failed = textOf(await call(rt, 'fetch_rows', { resultId: first.resultId }));
    expect(failed.split('\n')[0]).toBe('Error: Lost the connection to the database while reading rows (Connection terminated unexpectedly).');
    expect(failed).toContain('To fix: Run the query again with run_query (this result cannot be continued).');
    expect(lastLine(failed)).toBe('Error type: connection_lost. This result was closed.');
    const again = textOf(await call(rt, 'fetch_rows', { resultId: first.resultId }));
    expect(again).toBe(`Error: result ${first.resultId} is no longer available (reading it failed: Connection terminated unexpectedly). Re-run the query, or use export_query.`);
  });
});

describe('connection_status', () => {
  test('connected: the first four lines are unchanged, then server, round trip and pool', async () => {
    const result = await call(rt, 'connection_status', {});
    expect(result.isError).toBeUndefined();
    const lines = textOf(result).split('\n');
    expect(lines.slice(0, 4)).toEqual(['Connected', 'Database: fake-db', 'User: fake-user', 'Host: 10.0.0.5']);
    expect(lines[4]).toBe(`Server: ${REDSHIFT_VERSION}`);
    expect(lines[5]).toMatch(/^Round trip: \d+ ms$/);
    expect(lines[6]).toBe('Pool: 0 in use, 1 idle, 0 waiting (max 10)');
    expect(lines).toHaveLength(7);
    // The healthy path doesn't touch the network checks.
    expect(fakeNetwork.lookups + fakeNetwork.probes).toBe(0);
  });

  test('the pool lost its connection and the network is down: the network step fails', async () => {
    fakeDb.failWhen(/current_database/, connectionError(), 1);
    fakeNetwork.probe = 'timeout';
    const text = textOf(await call(rt, 'connection_status', {}));
    expect(text).toBe(
      'Not connected: Could not reach the database server at fake-host:5439: the connection attempt timed out.\n' +
      'Likely cause: The host name resolves to a private address (10.0.0.5), which is only reachable through a VPN, a peered network or an SSH tunnel, and that path is not working.\n' +
      'To fix: Connect to the VPN (or start the SSH tunnel), then retry.\n' +
      'Checks:\n' +
      '  Settings: ok (password login, user fake-user, database fake-db at fake-host:5439, SSL mode disable)\n' +
      '  DNS: ok (resolves to 10.0.0.5, private)\n' +
      '  Network: failed (no answer from 10.0.0.5:5439 within 5 s)\n' +
      '  Login: not checked\n' +
      'Error type: network_timeout.',
    );
    expect(pool.ended).toBe(true);
  });

  test('the pool lost its connection but the network works: a new pool logs in', async () => {
    fakeDb.failWhen(/current_database/, connectionError(), 1);
    const text = textOf(await call(rt, 'connection_status', {}));
    expect(text.split('\n')[0]).toBe('Connected');
    expect(getActivePool()).not.toBe(pool);
    expect(fakeNetwork.probes).toBe(1);
  });

  test('the DNS step fails', async () => {
    fakeDb.failWhen(/current_database/, connectionError(), 1);
    fakeNetwork.lookupError = 'ENOTFOUND';
    const text = textOf(await call(rt, 'connection_status', {}));
    expect(text.split('\n')[0]).toBe('Not connected: Could not look up the database host "fake-host" in DNS (ENOTFOUND).');
    expect(text).toContain('  DNS: failed (fake-host: ENOTFOUND)\n  Network: not checked\n  Login: not checked\nError type: dns.');
  });

  test('the login fails: the database error is described', async () => {
    // No pool yet, so the check logs in with a new one.
    __setTestConnectionState({ pool: null });
    fakeDb.failWhen('connect', dbError('28P01', 'password authentication failed for user "fake-user"'), 1);
    const text = textOf(await call(rt, 'connection_status', {}));
    expect(text.split('\n')[0]).toBe('Not connected: Login failed: password authentication failed for user "fake-user"');
    expect(text).toContain('  Network: ok (TCP connection to 10.0.0.5:5439 in 3 ms)\n  Login: failed\n');
    expect(lastLine(text)).toBe('Error type: auth (SQLSTATE 28P01 invalid_password).');
  });

  test('missing settings: nothing else is checked', async () => {
    delete process.env.SQL_DATABASE;
    const text = textOf(await call(rt, 'connection_status', {}));
    expect(text).toBe(
      'Not connected: Missing SQL_DATABASE. Set it directly or include in Secrets Manager secret.\n' +
      "To fix: Set it in this MCP server's env configuration (for example in mcp.json), then restart or reconnect the server.\n" +
      'Checks:\n  Settings: failed\n  DNS: not checked\n  Network: not checked\n  Login: not checked\n' +
      'Error type: config.',
    );
  });

  test('every pooled connection is busy: a new connection proves the database works', async () => {
    pool = new FakePool({ max: 1 });
    __setTestConnectionState({ pool: pool as never });
    process.env.SQL_CONNECT_TIMEOUT_MS = '50';
    statusLimits.queryLimitMs = 100;
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(1), delayMs: 5_000 });
    const controller = new AbortController();
    const slow = call(rt, 'run_query', { sql: 'select id, name from slow' }, { signal: controller.signal });
    await until(() => pool.checkedOutCount === 1, 2_000, 'busy pool');
    const text = textOf(await call(rt, 'connection_status', {}));
    const lines = text.split('\n');
    expect(lines[0]).toBe('Connected');
    expect(lines[lines.length - 1]).toMatch(
      /^Note: a new connection works, but the existing connection pool did not answer within 150 ms \(1 in use, 0 idle, \d+ waiting \(max 1\)\)\. Long-running queries or open results may be holding every connection\.$/,
    );
    controller.abort();
    await slow;
  });
});
