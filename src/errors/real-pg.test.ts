/**
 * Connection failures against the real pg driver (no mocks), using local sockets: a closed port,
 * a server that never answers, one that refuses SSL, and one that rejects the login. Checks the
 * error type, the wording that matters, the attempt count (retry gating) and connection_status.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { makeRuntime, teardown, call, textOf, until } from '../test/harness';
import { __setTestConnectionState, getActivePool } from '../db/pool';
import type { Runtime } from '../runtime';

const ENV_KEYS = [
  'SQL_AUTH_METHOD', 'SQL_HOST', 'SQL_PORT', 'SQL_DATABASE', 'SQL_USER', 'SQL_PASSWORD', 'SQL_SSL_MODE',
  'SQL_CONNECT_TIMEOUT_MS', 'SQL_SECRET_ID', 'SQL_CLUSTER_ID',
];
let saved: Record<string, string | undefined> = {};
let rt: Runtime;
const servers: net.Server[] = [];

interface TestServer {
  port: number;
  connections: () => number;
}

const openSockets = new Set<net.Socket>();

function listen(onConnection: (socket: net.Socket) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    let count = 0;
    const server = net.createServer((socket) => {
      count++;
      openSockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => openSockets.delete(socket));
      onConnection(socket);
      // Read (and ignore) whatever the client sends, so a client that hangs up is noticed.
      socket.resume();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, connections: () => count }));
  });
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A PostgreSQL ErrorResponse message. */
function errorResponse(code: string, message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0`, 'utf8'),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(5);
  header.write('E', 0, 'ascii');
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}

function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`, 'utf8');
}

/** A PostgreSQL protocol message: type byte, length, body. */
function message(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/**
 * A minimal PostgreSQL server: asks for a cleartext password (recorded in `seen`), accepts only
 * `expected`, and answers every simple query with one row of text columns.
 */
function passwordServer(expected: string, seen: string[], row: Record<string, string>): Promise<TestServer> {
  const names = Object.keys(row);
  const values = Object.values(row);
  const result = Buffer.concat([
    message('T', int16(names.length), ...names.map((n) => Buffer.concat([cstr(n), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]))),
    message('D', int16(values.length), ...values.map((v) => Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v, 'utf8')]))),
    message('C', cstr('SELECT 1')),
    message('Z', Buffer.from('I')),
  ]);
  return listen((socket) => {
    let buf = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          // StartupMessage: length, protocol version, parameters (no type byte).
          if (buf.length < 4) return;
          const length = buf.readInt32BE(0);
          if (buf.length < length) return;
          buf = buf.subarray(length);
          started = true;
          socket.write(message('R', int32(3)));
          continue;
        }
        if (buf.length < 5) return;
        const length = buf.readInt32BE(1);
        if (buf.length < 1 + length) return;
        const type = String.fromCharCode(buf[0]);
        const body = buf.subarray(5, 1 + length);
        buf = buf.subarray(1 + length);
        if (type === 'p') {
          const password = body.toString('utf8').replace(/\0$/, '');
          seen.push(password);
          if (password !== expected) {
            socket.end(errorResponse('28P01', 'password authentication failed for user "someone"'));
            return;
          }
          socket.write(Buffer.concat([message('R', int32(0)), message('K', int32(4242), int32(7)), message('Z', Buffer.from('I'))]));
        } else if (type === 'Q') {
          socket.write(result);
        } else if (type === 'X') {
          socket.end();
          return;
        }
      }
    });
  });
}

function useServer(port: number, sslMode = 'disable'): void {
  Object.assign(process.env, {
    SQL_AUTH_METHOD: 'direct',
    SQL_HOST: '127.0.0.1',
    SQL_PORT: String(port),
    SQL_DATABASE: 'db',
    SQL_USER: 'someone',
    SQL_PASSWORD: 'secret',
    SQL_SSL_MODE: sslMode,
  });
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SQL_CONNECT_TIMEOUT_MS = '300';
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
  rt = makeRuntime();
});

afterEach(async () => {
  await teardown();
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
});

describe('connection failures with the real driver', () => {
  test('nothing listening on a local port: connection_refused with the SSH tunnel hint, not retried', async () => {
    useServer(await closedPort());
    const started = Date.now();
    const result = await call(rt, 'run_query', { sql: 'select 1' });
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^Error: The database server at 127\.0\.0\.1:\d+ refused the connection \(ECONNREFUSED\)\./);
    expect(text).toContain('SSH tunnel');
    expect(text).toMatch(/Error type: connection_refused\. No SQL was run\.$/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a server that accepts TCP but never answers: connect_timeout after 2 attempts, each bounded by SQL_CONNECT_TIMEOUT_MS', async () => {
    const silent = await listen(() => undefined);
    useServer(silent.port);
    const started = Date.now();
    const result = await call(rt, 'run_query', { sql: 'select 1' });
    const text = textOf(result);
    expect(text).toMatch(/^Error: The database server at 127\.0\.0\.1:\d+ accepted the network connection but did not finish the login within 300 ms\./);
    expect(text).toContain('2 connection attempts');
    expect(text).toContain('a TCP connection to 127.0.0.1:');
    expect(text).toMatch(/Error type: connect_timeout\. No SQL was run\.$/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Two driver attempts plus the TCP check (whose accept may land just after the call returns).
    await until(() => silent.connections() >= 3, 2_000, 'the TCP check');
    await new Promise((r) => setTimeout(r, 50));
    expect(silent.connections()).toBe(3);
  });

  test('a server without SSL while SQL_SSL_MODE=require: tls, with the SQL_SSL_MODE fix', async () => {
    const noSsl = await listen((socket) => socket.once('data', () => socket.write('N')));
    useServer(noSsl.port, 'require');
    const text = textOf(await call(rt, 'run_query', { sql: 'select 1' }));
    expect(text).toMatch(/^Error: The database server does not accept SSL connections\./);
    expect(text).toContain('SQL_SSL_MODE=disable');
    expect(text).toMatch(/Error type: tls\. No SQL was run\.$/);
    expect(noSsl.connections()).toBe(1);
  });

  test('a rejected password: auth, one attempt, with the SQLSTATE', async () => {
    const reject = await listen((socket) => socket.once('data', () => socket.end(errorResponse('28P01', 'password authentication failed for user "someone"'))));
    useServer(reject.port);
    const text = textOf(await call(rt, 'run_query', { sql: 'select 1' }));
    expect(text).toMatch(/^Error: Login failed: password authentication failed for user "someone"\n/);
    expect(text).toContain('SQL_USER or SQL_PASSWORD is wrong');
    expect(text).toMatch(/Error type: auth \(SQLSTATE 28P01 invalid_password\)\. No SQL was run\.$/);
    expect(reject.connections()).toBe(1);
  });

  test('a missing database: database_not_found', async () => {
    const missing = await listen((socket) => socket.once('data', () => socket.end(errorResponse('3D000', 'database "db" does not exist'))));
    useServer(missing.port);
    const text = textOf(await call(rt, 'list_schemas', {}));
    expect(text).toMatch(/^Error: database "db" does not exist\n/);
    expect(text).toMatch(/Error type: database_not_found \(SQLSTATE 3D000 invalid_catalog_name\)\. No SQL was run\.$/);
  });

  test('export_query reports the same description and an errorType', async () => {
    useServer(await closedPort());
    const started = JSON.parse(textOf(await call(rt, 'export_query', { sql: 'select 1', wait: false })));
    await new Promise((r) => setTimeout(r, 300));
    const status = JSON.parse(textOf(await call(rt, 'export_status', { exportId: started.exportId })));
    expect(status.state).toBe('failed');
    expect(status.errorType).toBe('connection_refused');
    expect(status.error).toMatch(/^The database server at 127\.0\.0\.1:\d+ refused the connection/);
  });
});

describe('logging in with the real driver and pool', () => {
  test('the password reaches the server when the connect timeout is on (the 1.5.1 login bug)', async () => {
    const seen: string[] = [];
    const server = await passwordServer('secret', seen, {
      database: 'db', user: 'someone', host: '127.0.0.1', version: 'PostgreSQL 16.4 (test server)',
    });
    useServer(server.port);
    expect(process.env.SQL_CONNECT_TIMEOUT_MS).toBe('300');
    const result = await call(rt, 'connection_status', {});
    const lines = textOf(result).split('\n');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === 'secret')).toBe(true);
    expect(lines.slice(0, 4)).toEqual(['Connected', 'Database: db', 'User: someone', 'Host: 127.0.0.1']);
    expect(lines[4]).toBe('Server: PostgreSQL 16.4 (test server)');
    expect(lines[5]).toMatch(/^Round trip: \d+ ms$/);
    expect(lines[6]).toMatch(/^Pool: \d+ in use, \d+ idle, 0 waiting \(max 10\)$/);
    expect(lines).toHaveLength(7);
  });

  test('queries run on pooled connections that logged in with the password', async () => {
    const seen: string[] = [];
    const server = await passwordServer('secret', seen, { schema_name: 'analytics' });
    useServer(server.port);
    const text = textOf(await call(rt, 'list_schemas', {}));
    expect(text).toContain('analytics');
    expect(text).toMatch(/1 rows returned\./);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === 'secret')).toBe(true);
  });
});

describe('connection_status with the real driver', () => {
  test('closed port: the network step fails', async () => {
    useServer(await closedPort());
    const result = await call(rt, 'connection_status', {});
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/^Not connected: The database server at 127\.0\.0\.1:\d+ refused the connection/);
    expect(text).toContain('  Settings: ok (password login, user someone, database db at 127.0.0.1:');
    expect(text).toContain('  DNS: not needed (SQL_HOST is an IP address)');
    expect(text).toMatch(/ {2}Network: failed \(127\.0\.0\.1:\d+ refused the connection\)/);
    expect(text).toContain('  Login: not checked');
    expect(text).toMatch(/Error type: connection_refused\.$/);
  });

  test('silent server: the network step passes and the login times out', async () => {
    const silent = await listen(() => undefined);
    useServer(silent.port);
    const text = textOf(await call(rt, 'connection_status', {}));
    expect(text).toMatch(/^Not connected: The database server at 127\.0\.0\.1:\d+ accepted the network connection but did not finish the login within 300 ms\./);
    expect(text).toMatch(/ {2}Network: ok \(TCP connection to 127\.0\.0\.1:\d+ in /);
    expect(text).toContain('  Login: failed');
    expect(text).toMatch(/Error type: connect_timeout\.$/);
    expect(getActivePool()).toBeNull();
  });

  test('missing settings: the settings step fails', async () => {
    useServer(1);
    delete process.env.SQL_HOST;
    const text = textOf(await call(rt, 'connection_status', {}));
    expect(text).toMatch(/^Not connected: Missing SQL_HOST\./);
    expect(text).toContain('  Settings: failed');
    expect(text).toContain('  DNS: not checked');
    expect(text).toMatch(/Error type: config\.$/);
  });
});
