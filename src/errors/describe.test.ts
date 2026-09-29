/**
 * Error descriptions (1.5.1): one test per error type, the SQL status sentence, error positions,
 * and a property test that the text is never blank and always starts with "Error: ".
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { describeError, errorText, locate, statusSentence, isClearError, maskSecrets } from './describe';
import { annotate, ErrorContext } from './context';
import { __setNetworkForTests, ProbeOutcome } from './network';
import { QueryCancelledError, QueryTimeoutError } from '../db/lease';
import { EmptySqlError } from '../sql/classify';
import { ResultUnavailableError } from '../results/store';

const VPCE = { host: 'vpce-123.vpce-svc-456.ap-south-1.vpce.amazonaws.com', port: 5439 };
const ENV_KEYS = ['SQL_AUTH_METHOD', 'SQL_HOST', 'SQL_PORT', 'SQL_USER', 'SQL_SSL_MODE', 'SQL_AWS_REGION', 'SQL_CLUSTER_ID', 'SQL_SECRET_ID'];
let saved: Record<string, string | undefined> = {};
let lookups = 0;
let probes = 0;

function network(probe: ProbeOutcome, addresses = ['10.253.59.227', '10.253.33.116']): void {
  __setNetworkForTests({
    lookup: async () => {
      lookups++;
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    probe: async (address, port, timeoutMs) => {
      probes++;
      const code = probe === 'refused' ? 'ECONNREFUSED' : probe === 'unreachable' ? 'EHOSTUNREACH' : undefined;
      return { outcome: probe, address, port, timeoutMs, code, ms: probe === 'timeout' ? timeoutMs : 7 };
    },
  });
}

function dbError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', name: 'error', ...extra });
}

function netError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, errno: -1, ...extra });
}

function aggregate(errors: Error[], code: string): Error {
  const Aggregate = (globalThis as unknown as { AggregateError: new (errors: Error[], message: string) => Error }).AggregateError;
  return Object.assign(new Aggregate(errors, ''), { code });
}

async function text(err: unknown): Promise<string> {
  return (await describeError(err)).text;
}

async function typeOf(err: unknown): Promise<string | null> {
  return (await describeError(err)).type;
}

function lastLine(s: string): string {
  const lines = s.split('\n');
  return lines[lines.length - 1];
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  lookups = 0;
  probes = 0;
  network('open');
});

afterEach(() => {
  __setNetworkForTests(null);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('the server\'s own errors stay one line and unchanged', () => {
  test.each([
    ['cancelled', new QueryCancelledError(dbError('57014', 'canceling statement due to user request')), 'Error: The query was cancelled.'],
    ['timeout', new QueryTimeoutError(50), 'Error: The query exceeded timeoutMs=50 and was cancelled.'],
    ['empty SQL', new EmptySqlError(), 'Error: No SQL statement to run: the text contains only comments or semicolons.'],
    ['unavailable result', new ResultUnavailableError('r_abc', 'unknown result ID'), 'Error: result r_abc is no longer available (unknown result ID). Re-run the query, or use export_query.'],
    ['plain error', new Error('Unknown tool: nope'), 'Error: Unknown tool: nope'],
  ])('%s', async (_label, err, expected) => {
    expect(await text(err)).toBe(expected);
    expect(await typeOf(err)).toBeNull();
  });

  test('clear errors are recognised by name', () => {
    expect(isClearError(new QueryTimeoutError(1))).toBe(true);
    expect(isClearError(new Error('x'))).toBe(false);
  });
});

describe('settings and AWS credentials', () => {
  test('config: the message, the fix, no SQL run', async () => {
    const err = annotate(new Error('Missing SQL_HOST. Set it directly or include in Secrets Manager secret.'), { phase: 'config' });
    const out = await text(err);
    expect(out).toBe(
      'Error: Missing SQL_HOST. Set it directly or include in Secrets Manager secret.\n' +
      "To fix: Set it in this MCP server's env configuration (for example in mcp.json), then restart or reconnect the server.\n" +
      'Error type: config. No SQL was run.',
    );
    expect(lookups + probes).toBe(0);
  });

  test('config: an unreadable SSL file', async () => {
    const out = await text(annotate(new Error('Failed to load SQL_SSL_CA file at "/x.pem": ENOENT'), { phase: 'config' }));
    expect(out).toContain('To fix: Point that setting at a readable file');
  });

  const aws = (name: string, message: string, service: 'redshift' | 'secretsmanager' = 'redshift') => {
    const cause = Object.assign(new Error(message), { name });
    const wrapper = service === 'redshift' ? 'Failed to get IAM credentials' : 'Failed to retrieve secret from Secrets Manager';
    return annotate(Object.assign(new Error(`${wrapper}: ${message}`), { cause }), {
      phase: 'credentials',
      aws: { service, region: 'ap-south-1', resource: service === 'redshift' ? 'mx-cluster' : 'mx/secret' },
    });
  };

  test.each([
    ['no credentials', aws('CredentialsProviderError', 'Could not load credentials from any providers'), /No usable AWS credentials were found for the redshift:GetClusterCredentials call\./, /SQL_AWS_PROFILE/],
    ['expired', aws('ExpiredToken', 'The security token included in the request is expired'), /have expired/, /aws sso login/],
    ['invalid', aws('InvalidClientTokenId', 'The security token included in the request is invalid.'), /not valid/, /SQL_AWS_PROFILE/],
    ['access denied', aws('AccessDenied', 'User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: redshift:GetClusterCredentials'), /not allowed to call redshift:GetClusterCredentials/, /Grant redshift:GetClusterCredentials/],
    ['cluster not found', aws('ClusterNotFoundFault', 'Cluster mx-cluster not found.'), /There is no cluster "mx-cluster" in ap-south-1\./, /SQL_CLUSTER_ID/],
    ['secret not found', aws('ResourceNotFoundException', "Secrets Manager can't find the specified secret.", 'secretsmanager'), /The secret "mx\/secret" was not found in ap-south-1\./, /SQL_SECRET_ID/],
    ['AWS API unreachable', annotate(Object.assign(new Error('Failed to get IAM credentials: getaddrinfo ENOTFOUND redshift.ap-south-1.amazonaws.com'), {
      cause: netError('ENOTFOUND', 'getaddrinfo ENOTFOUND redshift.ap-south-1.amazonaws.com'),
    }), { phase: 'credentials', aws: { service: 'redshift', region: 'ap-south-1' } }), /The AWS API \(redshift in ap-south-1\) could not be reached/, /network connection/],
    ['bad secret JSON', aws('SyntaxError', 'Unexpected token } in JSON at position 3', 'secretsmanager'), /not the JSON the server expects/, /username and password/],
  ])('%s', async (_label, err, cause, fix) => {
    const out = await text(err);
    expect(out.split('\n')[0]).toMatch(/^Error: Failed to (get IAM credentials|retrieve secret from Secrets Manager): /);
    expect(out).toMatch(new RegExp(`Likely cause: .*${cause.source}`));
    expect(out).toMatch(new RegExp(`To fix: .*${fix.source}`));
    expect(lastLine(out)).toBe('Error type: aws_credentials. No SQL was run.');
  });
});

describe('network failures', () => {
  test('VPN off: pg connect timeout, private address, TCP check times out', async () => {
    network('timeout');
    const err = annotate(new Error('timeout expired'), { phase: 'connect', target: VPCE, connectTimeoutMs: 10_000, attempts: 2, elapsedMs: 20_150 });
    const out = await text(err);
    expect(out).toBe(
      `Error: Could not reach the database server at ${VPCE.host}:5439: the connection attempt timed out.\n` +
      'Likely cause: The host name resolves to a private address (10.253.59.227), which is only reachable through a VPN, a peered network or an SSH tunnel, and that path is not working.\n' +
      'To fix: Connect to the VPN (or start the SSH tunnel), then retry.\n' +
      'Checked: the host name resolves to 10.253.59.227, 10.253.33.116 (private); a TCP connection to 10.253.59.227:5439 got no answer within 3 s; ' +
      '2 connection attempts over 20 s, each stopped by the 10 s connect timeout (SQL_CONNECT_TIMEOUT_MS).\n' +
      'Error type: network_timeout. No SQL was run.',
    );
    expect(probes).toBe(1);
  });

  test('VPN off without a connect timeout: the OS AggregateError (empty message) is described from its parts', async () => {
    const err = annotate(aggregate([
      netError('ETIMEDOUT', 'connect ETIMEDOUT 10.253.59.227:5439', { syscall: 'connect', address: '10.253.59.227', port: 5439 }),
      netError('ETIMEDOUT', 'connect ETIMEDOUT 10.253.33.116:5439', { syscall: 'connect', address: '10.253.33.116', port: 5439 }),
    ], 'ETIMEDOUT'), { phase: 'connect', target: VPCE, attempts: 2, elapsedMs: 150_700 });
    const out = await text(err);
    expect(out).toMatch(/^Error: Could not reach the database server at .*: the connection attempt timed out\./);
    expect(out).toContain('private address (10.253.59.227)');
    expect(out).toContain('Driver message: connect ETIMEDOUT 10.253.59.227:5439; connect ETIMEDOUT 10.253.33.116:5439');
    expect(lastLine(out)).toBe('Error type: network_timeout. No SQL was run.');
    // The code decides the type, so no TCP check is needed.
    expect(probes).toBe(0);
  });

  test('an AggregateError is a connect failure even when only tagged as a query error', async () => {
    const err = aggregate([netError('ECONNREFUSED', 'connect ECONNREFUSED ::1:5439'), netError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5439')], 'ECONNREFUSED');
    expect(await typeOf(annotate(err, { phase: 'query' }))).toBe('connection_refused');
  });

  test('errors that did not come through a database connection are shown as they are', async () => {
    const disk = annotate(netError('ENOSPC', 'ENOSPC: no space left on device, write'), { phase: 'query', operation: 'export_query' });
    expect(await text(disk)).toBe('Error: ENOSPC: no space left on device, write');
    expect(await text(netError('ECONNREFUSED', 'connect ECONNREFUSED 10.9.9.9:443'))).toBe('Error: connect ECONNREFUSED 10.9.9.9:443');
    expect(await text(netError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'))).toBe('Error: unable to get local issuer certificate');
    expect(lookups + probes).toBe(0);
  });

  test('timeout to a public address: firewall and security group advice', async () => {
    network('timeout', ['52.66.1.2']);
    const out = await text(annotate(new Error('timeout expired'), { phase: 'connect', target: { host: 'db.example.com', port: 5432 }, connectTimeoutMs: 10_000, attempts: 2 }));
    expect(out).toContain('Likely cause: The server did not answer. A firewall or security group may be blocking this machine');
    expect(out).toContain('allows this machine on port 5432');
    expect(out).toContain('(public)');
  });

  test('TCP open but the login never finished: connect_timeout', async () => {
    network('open');
    const out = await text(annotate(new Error('timeout expired'), { phase: 'connect', target: VPCE, connectTimeoutMs: 10_000, attempts: 2, elapsedMs: 20_100 }));
    expect(out.split('\n')[0]).toBe(`Error: The database server at ${VPCE.host}:5439 accepted the network connection but did not finish the login within 10 s.`);
    expect(out).toContain('raise SQL_CONNECT_TIMEOUT_MS (now 10000 ms)');
    expect(lastLine(out)).toBe('Error type: connect_timeout. No SQL was run.');
  });

  test('pg timeout and the TCP check refused: connection_refused', async () => {
    network('refused', ['127.0.0.1']);
    const out = await text(annotate(new Error('timeout expired'), { phase: 'connect', target: { host: 'localhost', port: 5439 }, connectTimeoutMs: 10_000 }));
    expect(lastLine(out)).toBe('Error type: connection_refused. No SQL was run.');
    expect(out).toContain('SSH tunnel');
  });

  test('pg timeout and the DNS lookup fails: dns', async () => {
    __setNetworkForTests({ lookup: async () => { throw netError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN db.corp'); } });
    const out = await text(annotate(new Error('timeout expired'), { phase: 'connect', target: { host: 'db.corp', port: 5439 }, connectTimeoutMs: 10_000 }));
    expect(out.split('\n')[0]).toBe('Error: Could not look up the database host "db.corp" in DNS (EAI_AGAIN).');
    expect(out).toContain('The DNS server did not answer');
  });

  test('refused on localhost: the SSH tunnel is not running', async () => {
    network('open', ['127.0.0.1']);
    const err = annotate(netError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5439', { syscall: 'connect', address: '127.0.0.1', port: 5439 }), {
      phase: 'connect', target: { host: 'localhost', port: 5439 }, attempts: 1, elapsedMs: 3,
    });
    const out = await text(err);
    expect(out).toBe(
      'Error: The database server at localhost:5439 refused the connection (ECONNREFUSED).\n' +
      'Likely cause: Nothing is listening on that local port. If you reach the database through an SSH tunnel or a local proxy, it is not running.\n' +
      'To fix: Start the SSH tunnel (or the local proxy or database), then retry.\n' +
      'Checked: the host name resolves to 127.0.0.1 (loopback).\n' +
      'Driver message: connect ECONNREFUSED 127.0.0.1:5439\n' +
      'Error type: connection_refused. No SQL was run.',
    );
  });

  test('refused on a remote host: port and firewall advice', async () => {
    network('open', ['52.1.2.3']);
    const out = await text(annotate(netError('ECONNREFUSED', 'connect ECONNREFUSED 52.1.2.3:5439'), { phase: 'connect', target: { host: 'db.example.com', port: 5439 } }));
    expect(out).toContain('Redshift usually uses 5439 and PostgreSQL 5432');
  });

  test('no route to a private address: network_unreachable, connect to the VPN', async () => {
    network('open');
    const out = await text(annotate(netError('EHOSTUNREACH', 'connect EHOSTUNREACH 10.253.59.227:5439'), { phase: 'connect', target: VPCE }));
    expect(out.split('\n')[0]).toBe(`Error: Could not reach the database server at ${VPCE.host}:5439: there is no network route to it (EHOSTUNREACH).`);
    expect(out).toContain('To fix: Connect to the VPN (or start the SSH tunnel), then retry.');
    expect(lastLine(out)).toBe('Error type: network_unreachable. No SQL was run.');
  });

  test('an IP address in SQL_HOST is described as an address', async () => {
    network('timeout');
    const out = await text(annotate(new Error('timeout expired'), { phase: 'connect', target: { host: '10.1.2.3', port: 5439 }, connectTimeoutMs: 10_000 }));
    expect(out).toContain('Likely cause: 10.1.2.3 is a private address, which is only reachable through a VPN');
  });

  test('DNS: the name does not exist', async () => {
    const out = await text(annotate(netError('ENOTFOUND', 'getaddrinfo ENOTFOUND cluster.example.com', { syscall: 'getaddrinfo' }), {
      phase: 'connect', target: { host: 'cluster.example.com', port: 5439 },
    }));
    expect(out).toBe(
      'Error: Could not look up the database host "cluster.example.com" in DNS (ENOTFOUND).\n' +
      'Likely cause: The host name does not exist in DNS. It may be misspelled, or it is a private name that only resolves on a VPN or corporate network.\n' +
      'To fix: Check SQL_HOST. If it is a private endpoint, connect to the VPN, then retry.\n' +
      'Driver message: getaddrinfo ENOTFOUND cluster.example.com\n' +
      'Error type: dns. No SQL was run.',
    );
  });

  test('DNS with Secrets Manager: the secret may hold the host', async () => {
    process.env.SQL_AUTH_METHOD = 'secrets_manager';
    const out = await text(annotate(netError('ENOTFOUND', 'getaddrinfo ENOTFOUND h'), { phase: 'connect', target: { host: 'h', port: 1 } }));
    expect(out).toContain('Check SQL_HOST (or the value in the Secrets Manager secret).');
  });

  test('the server closed the connection during the login: server_unavailable', async () => {
    const out = await text(annotate(Object.assign(new Error('Connection terminated unexpectedly'), {}), { phase: 'connect', target: VPCE }));
    expect(out.split('\n')[0]).toBe(`Error: The database server at ${VPCE.host}:5439 closed the connection during the login (Connection terminated unexpectedly).`);
    expect(lastLine(out)).toBe('Error type: server_unavailable. No SQL was run.');
  });
});

describe('TLS and login', () => {
  test('the server has no SSL', async () => {
    const out = await text(annotate(new Error('The server does not support SSL connections'), { phase: 'connect', target: VPCE }));
    expect(out).toBe(
      'Error: The database server does not accept SSL connections.\n' +
      'Likely cause: SQL_SSL_MODE is require (the default), but SSL is turned off on the server.\n' +
      'To fix: Set SQL_SSL_MODE=disable if the network is trusted (the connection will not be encrypted), or turn on SSL on the server.\n' +
      'Error type: tls. No SQL was run.',
    );
  });

  test('the server requires SSL (28000 ... SSL off)', async () => {
    process.env.SQL_SSL_MODE = 'disable';
    const out = await text(annotate(dbError('28000', 'no pg_hba.conf entry for host "1.2.3.4", user "u", database "d", SSL off'), { phase: 'connect' }));
    expect(out).toContain('Likely cause: The server only accepts SSL connections, but SQL_SSL_MODE=disable.');
    expect(lastLine(out)).toBe('Error type: tls (SQLSTATE 28000 invalid_authorization_specification). No SQL was run.');
  });

  test('certificate verification with verify-full', async () => {
    process.env.SQL_SSL_MODE = 'verify-full';
    const out = await text(annotate(netError('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'), { phase: 'connect' }));
    expect(out.split('\n')[0]).toBe("Error: The server's SSL certificate could not be verified: self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN).");
    expect(out).toContain('SQL_SSL_MODE=verify-full verifies the certificate');
    expect(out).toContain('Set SQL_SSL_CA');
    expect(out).toContain('or use SQL_SSL_MODE=require');
  });

  test('a certificate for another host name', async () => {
    process.env.SQL_SSL_MODE = 'verify-full';
    const out = await text(annotate(netError('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"), { phase: 'connect', target: VPCE }));
    expect(out).toContain('VPC endpoint, proxy or tunnel');
  });

  test.each([
    ['direct', 'SQL_USER or SQL_PASSWORD is wrong'],
    ['iam', 'GetClusterCredentials were rejected'],
    ['secrets_manager', 'Secrets Manager secret is wrong or out of date'],
  ])('password rejected with %s authentication', async (method, cause) => {
    process.env.SQL_AUTH_METHOD = method;
    const out = await text(annotate(dbError('28P01', 'password authentication failed for user "u"'), { phase: 'connect' }));
    expect(out.split('\n')[0]).toBe('Error: Login failed: password authentication failed for user "u"');
    expect(out).toContain(cause);
    expect(lastLine(out)).toBe('Error type: auth (SQLSTATE 28P01 invalid_password). No SQL was run.');
  });

  test('Redshift reports a bad password as 28000', async () => {
    expect(await typeOf(annotate(dbError('28000', 'password authentication failed for user "u"'), { phase: 'connect' }))).toBe('auth');
  });

  test('database, connection limit and startup', async () => {
    expect(await typeOf(dbError('3D000', 'database "x" does not exist'))).toBe('database_not_found');
    expect(await typeOf(dbError('53300', 'too many connections for role "u"'))).toBe('too_many_connections');
    const starting = await text(dbError('57P03', 'the database system is starting up'));
    expect(starting).toContain('paused, resizing or rebooting');
    expect(lastLine(starting)).toBe('Error type: server_unavailable (SQLSTATE 57P03 cannot_connect_now). No SQL was run.');
  });
});

describe('SQL errors', () => {
  const sql = 'select a.id,\n       b.name\nfrom sales a\njoin custmers b on b.id = a.cid';

  test('the position is shown as a line, a column and a caret', async () => {
    // "join " starts at index 40, so "custmers" is character 46 (1-based).
    const err = annotate(dbError('42P01', 'relation "custmers" does not exist', { position: '46' }), {
      phase: 'query', sql, sentCount: 1, statement: { text: sql, offset: 0, shift: 0, index: 1 }, statementCount: 1,
    });
    expect(await text(err)).toBe(
      'Error: relation "custmers" does not exist\n' +
      'To fix: Check the table name and schema (list_schemas and list_tables show what exists), and write it as schema.table if it is not in the search path.\n' +
      'At line 4, column 6:\n' +
      '  join custmers b on b.id = a.cid\n' +
      '       ^\n' +
      'Error type: sql_error (SQLSTATE 42P01 undefined_table).',
    );
  });

  test('a failing statement in a script: which one, and what had completed', async () => {
    const script = "set search_path to 'x';\ninsert into t select * from s;\nselect * from nope";
    const err = annotate(dbError('42P01', 'relation "nope" does not exist', { position: '15' }), {
      phase: 'query', sql: script, sentCount: 1, completed: ['SET', 'INSERT (5 rows)'],
      statement: { text: 'select * from nope', offset: script.indexOf('select * from nope'), shift: 0, index: 3 }, statementCount: 3, isScript: true,
    });
    const out = await text(err);
    expect(out).toContain('At line 3, column 15:\n  select * from nope\n                ^');
    expect(lastLine(out)).toBe(
      'Error type: sql_error (SQLSTATE 42P01 undefined_table). Statement 3 of 3 failed and made no changes. The statements before it had completed: SET, INSERT (5 rows).',
    );
  });

  test('a Redshift message with line breaks stays on the first line', async () => {
    const sql = 'select 1 as a,\n  from t';
    const message = 'syntax error at or near "from" in context "as a,\n  from", at line 2, column 3';
    const err = annotate(dbError('42601', message, { position: '18' }), {
      phase: 'query', sql, sentCount: 1, statement: { text: sql, offset: 0, shift: 0, index: 1 }, statementCount: 1,
    });
    const out = await text(err);
    expect(out.split('\n')[0]).toBe('Error: syntax error at or near "from" in context "as a, from", at line 2, column 3');
    expect(out).toContain('At line 2, column 3:\n    from t\n    ^');
    expect(errorText(new Error('first\r\n   second\nthird'))).toBe('first second third');
  });

  test('a cursor query: the DECLARE prefix is not counted', async () => {
    const statement = 'select x from t';
    const err = annotate(dbError('42703', 'column "x" does not exist', { position: String('DECLARE mcp_c CURSOR FOR '.length + 8) }), {
      phase: 'query', sql: statement, sentCount: 1, statement: { text: statement, offset: 0, shift: 'DECLARE mcp_c CURSOR FOR '.length, index: 1 }, statementCount: 1,
    });
    const out = await text(err);
    expect(out).toContain('At line 1, column 8:\n  select x from t\n         ^');
    expect(out).toContain('describe_table');
  });

  test('detail, hint and where lines, and the Redshift detail block', async () => {
    const detail = "\n  -----------------------------------------------\n  error:  Invalid digit, Value 'a', Pos 0, Type: Integer \n  code:      1207\n  -----------------------------------------------\n";
    const out = await text(dbError('XX000', "Invalid digit, Value 'a', Pos 0, Type: Integer", { detail, hint: 'Cast the column.', where: 'SQL function "f"\nline 1' }));
    expect(out).toContain("Detail:\n  error:  Invalid digit, Value 'a', Pos 0, Type: Integer\n  code:      1207\n");
    expect(out).toContain('Hint: Cast the column.');
    expect(out).toContain('Where: SQL function "f"; line 1');
    expect(lastLine(out)).toBe('Error type: sql_error (SQLSTATE XX000 internal_error).');
  });

  test('a failed data-changing statement made no changes', async () => {
    const err = annotate(dbError('23505', 'duplicate key value violates unique constraint "t_pkey"'), {
      phase: 'query', sql: 'insert into t values (1)', sentCount: 1, statement: { text: 'insert into t values (1)', offset: 0, shift: 0, index: 1 }, statementCount: 1,
    });
    expect(lastLine(await text(err))).toBe('Error type: sql_error (SQLSTATE 23505 unique_violation). The statement made no changes.');
  });

  test('a transaction script sent as one request', async () => {
    const sql2 = 'begin; insert into t values (1); commit';
    const err = annotate(dbError('42601', 'syntax error at or near "comit"'), {
      phase: 'query', sql: sql2, sentCount: 1, statement: { text: sql2, offset: 0, shift: 0, index: null }, statementCount: 3, isScript: true,
    });
    expect(lastLine(await text(err))).toContain('The text was sent as one request, so statements before the failing one may have taken effect.');
  });

  test('Redshift leader-node-only functions', async () => {
    const out = await text(dbError('0A000', 'Specified types or functions (one per INFO message) not supported on Redshift tables.'));
    expect(out).toContain('generate_series');
  });

  test('permission denied: rewriting the SQL will not help', async () => {
    process.env.SQL_USER = 'reader';
    const out = await text(annotate(dbError('42501', 'permission denied for relation salaries'), { phase: 'query', sql: 'select * from salaries', sentCount: 1 }));
    expect(out).toBe(
      'Error: permission denied for relation salaries\n' +
      'Likely cause: The database user "reader" does not have the privilege this statement needs.\n' +
      'To fix: Rewriting the SQL will not help. Query objects this user can read, or ask the database administrator to grant access.\n' +
      'Error type: permission_denied (SQLSTATE 42501 insufficient_privilege).',
    );
  });

  test.each([
    ['Query (12345) cancelled by WLM abort action of Query Monitoring Rule "long".', 'WLM query monitoring rule'],
    ['canceling statement due to statement timeout', 'statement_timeout'],
    ['canceling statement due to user request', 'cancelled on the database side'],
  ])('a database-side cancellation: %s', async (message, cause) => {
    const out = await text(dbError('57014', message));
    expect(out).toContain(cause);
    expect(await typeOf(dbError('57014', message))).toBe('server_timeout');
  });
});

describe('lost connections', () => {
  const lost = (ctx: ErrorContext) => annotate(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }), { phase: 'query', target: VPCE, ...ctx });

  test('the database is reachable again: run it again', async () => {
    network('open');
    const out = await text(lost({ sql: 'select 1', sentCount: 1, statement: { text: 'select 1', offset: 0, shift: 0, index: 1 }, statementCount: 1 }));
    expect(out).toBe(
      'Error: Lost the connection to the database while the SQL was running (Connection terminated unexpectedly).\n' +
      'Likely cause: The network dropped briefly (for example a VPN reconnect or a Wi-Fi change), or the server ended the session (a restart, an idle timeout, a WLM rule or an administrator).\n' +
      'To fix: Run it again.\n' +
      'Checked: the database is reachable now (a TCP connection to 10.253.59.227:5439 succeeded in 7 ms).\n' +
      'Error type: connection_lost.',
    );
  });

  test('the database is not reachable now: reconnect the VPN, and check a data change', async () => {
    network('timeout');
    const insert = 'insert into t select * from s';
    const out = await text(lost({ sql: insert, sentCount: 1, statement: { text: insert, offset: 0, shift: 0, index: 1 }, statementCount: 1 }));
    expect(out).toContain('Likely cause: The database is not reachable now (a TCP connection to 10.253.59.227:5439 got no answer within 3 s), so the network or VPN connection dropped.');
    expect(out).toContain('To fix: Reconnect the VPN or network, then check whether the statement took effect before running it again.');
    expect(lastLine(out)).toBe('Error type: connection_lost. The statement may or may not have completed; check before re-running it.');
  });

  test('a script after earlier statements completed', async () => {
    network('open');
    const out = await text(lost({
      sql: 'insert into a values (1); select * from b', sentCount: 1, completed: ['INSERT (1 rows)'],
      statement: { text: 'select * from b', offset: 26, shift: 0, index: 2 }, statementCount: 2, isScript: true,
    }));
    expect(out).toContain('To fix: Run only the statements that had not completed (the earlier ones already took effect).');
    expect(lastLine(out)).toBe(
      'Error type: connection_lost. Statement 2 of 2 was running when the connection was lost. The statements before it had completed: INSERT (1 rows). It was not retried, because a retry would run them again.',
    );
  });

  test('before the SQL was sent', async () => {
    expect(lastLine(await text(lost({ sql: 'select 1', sentCount: 0 })))).toBe('Error type: connection_lost. No SQL was run.');
  });

  test('fetch_rows: the result was closed', async () => {
    const out = await text(lost({ operation: 'fetch_rows', resultClosed: true }));
    expect(out.split('\n')[0]).toBe('Error: Lost the connection to the database while reading rows (Connection terminated unexpectedly).');
    expect(out).toContain('To fix: Run the query again with run_query (this result cannot be continued).');
    expect(lastLine(out)).toBe('Error type: connection_lost. This result was closed.');
  });

  test('an administrator ended the session (57P01)', async () => {
    const out = await text(annotate(dbError('57P01', 'terminating connection due to administrator command'), { phase: 'query', sql: 'select 1', sentCount: 1 }));
    expect(out.split('\n')[0]).toBe('Error: The database ended the session while the SQL was running: terminating connection due to administrator command');
    expect(probes).toBe(0);
  });

  test('an earlier attempt sent the SQL, then reconnecting failed', async () => {
    network('timeout');
    const err = annotate(new Error('timeout expired'), { phase: 'connect', target: VPCE, connectTimeoutMs: 10_000, sql: 'delete from t', sentCount: 1 });
    expect(lastLine(await text(err))).toBe(
      'Error type: network_timeout. The SQL was sent on an earlier attempt, before the connection was lost, so it may or may not have completed; check before re-running statements that change data.',
    );
  });
});

describe('robustness', () => {
  test('errorText is never blank', () => {
    expect(errorText(new Error(''))).toBe('Unknown error (no message)');
    expect(errorText(aggregate([netError('ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:5')], 'ETIMEDOUT'))).toBe('connect ETIMEDOUT 1.2.3.4:5');
    expect(errorText(Object.assign(new Error(''), { code: 'EPIPE' }))).toBe('EPIPE');
    expect(errorText(Object.assign(new Error(''), { cause: new Error('inner') }))).toBe('inner');
    expect(errorText({ reason: 'x' })).toBe('{"reason":"x"}');
    expect(errorText(undefined)).toBe('Unknown error (no message)');
    expect(errorText(42)).toBe('42');
  });

  test('a network check that throws still yields a description', async () => {
    __setNetworkForTests({ lookup: async () => { throw new Error('resolver crashed'); }, probe: async () => { throw new Error('probe crashed'); } });
    const out = await text(annotate(new Error('timeout expired'), { phase: 'connect', target: VPCE, connectTimeoutMs: 10_000 }));
    expect(out).toMatch(/^Error: Could not look up the database host/);
  });

  test('property: any thrown value gives "Error: " and non-blank text', async () => {
    const errorLike = fc.record({
      message: fc.oneof(fc.constant(''), fc.string()),
      code: fc.option(fc.constantFrom('ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', '42P01', '28P01', '57014', 'XX000', 'EPIPE', 'weird'), { nil: undefined }),
      phase: fc.option(fc.constantFrom('config', 'credentials', 'connect', 'query'), { nil: undefined }),
      position: fc.option(fc.integer({ min: -3, max: 500 }).map(String), { nil: undefined }),
      sql: fc.option(fc.string(), { nil: undefined }),
    }).map(({ message, code, phase, position, sql }) => {
      const err = Object.assign(new Error(message), code ? { code } : {}, position ? { position } : {});
      return annotate(err, {
        phase: phase as ErrorContext['phase'],
        sql,
        target: VPCE,
        statement: sql !== undefined ? { text: sql, offset: 0, shift: 0, index: 1 } : undefined,
      });
    });
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.anything(), errorLike), async (value) => {
        const rendered = await describeError(value);
        expect(rendered.text.startsWith('Error: ')).toBe(true);
        expect(rendered.text.slice('Error: '.length).trim().length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });
});

describe('locate', () => {
  test('lines, columns and code points', () => {
    const sql = 'select 1;\nselect 😀, bad';
    const offset = sql.indexOf('select 😀');
    // Position counts characters: "select 😀, " is 10 characters, so "bad" is at 11.
    expect(locate(sql, { text: 'select 😀, bad', offset, shift: 0, index: 2 }, 11)).toEqual({ line: 2, column: 11, snippet: 'select 😀, bad', caret: 10 });
  });

  test('tabs, long lines and bad positions', () => {
    expect(locate('select\tx', { text: 'select\tx', offset: 0, shift: 0, index: 1 }, 8)?.snippet).toBe('select x');
    const long = `select ${'a, '.repeat(100)}zzz from t`;
    const at = locate(long, { text: long, offset: 0, shift: 0, index: 1 }, long.indexOf('zzz') + 1);
    expect(at?.snippet.startsWith('…')).toBe(true);
    expect(at && at.snippet.slice(at.caret, at.caret + 3)).toBe('zzz');
    expect(locate('select 1', { text: 'select 1', offset: 0, shift: 0, index: 1 }, 0)).toBeNull();
    expect(locate('select 1', { text: 'select 1', offset: 0, shift: 0, index: 1 }, 50)).toBeNull();
    expect(locate('select 1', { text: 'other', offset: 0, shift: 0, index: 1 }, 1)).toBeNull();
  });
});

describe('secrets stay out of error text', () => {
  test('credential literals in the SQL line are masked, and the caret still lines up', async () => {
    const sql = "copy t from 's3://b/k' credentials 'aws_access_key_id=AKIA;aws_secret_access_key=abc' csv bogus";
    const err = annotate(dbError('42601', 'syntax error at or near "bogus"', { position: String(sql.indexOf('bogus') + 1) }), {
      phase: 'query', sql, sentCount: 1, statement: { text: sql, offset: 0, shift: 0, index: 1 }, statementCount: 1,
    });
    const out = await text(err);
    expect(out).not.toContain('AKIA');
    expect(out).not.toContain('abc');
    const [snippet, caret] = out.split('\n').filter((l) => l.startsWith('  '));
    expect(snippet).toContain(`credentials '${'*'.repeat('aws_access_key_id=AKIA;aws_secret_access_key=abc'.length)}'`);
    expect(snippet.slice(caret.indexOf('^'), caret.indexOf('^') + 5)).toBe('bogus');
  });

  test('passwords in CREATE USER and ALTER USER are masked', () => {
    expect(maskSecrets("create user bob password 'Sup3r''secret' valid until 'x'")).toBe("create user bob password '*************' valid until 'x'");
    expect(maskSecrets("alter user bob password 'p'")).toBe("alter user bob password '*'");
    expect(maskSecrets("select 'password' as label")).toBe("select 'password' as label");
  });

  test('a thrown plain object never shows secret-looking fields', () => {
    const shown = errorText({ host: 'db', password: 'hunter2', nested: { apiKey: 'k', token: 't' } });
    expect(shown).toBe('{"host":"db","password":"[redacted]","nested":{"apiKey":"[redacted]","token":"[redacted]"}}');
  });
});

describe('statusSentence', () => {
  test('no SQL context: nothing to say for SQL errors', () => {
    expect(statusSentence('sql_error', {})).toBeNull();
    expect(statusSentence('dns', {})).toBe('No SQL was run.');
  });
});
