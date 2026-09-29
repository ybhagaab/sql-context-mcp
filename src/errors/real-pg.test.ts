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
