/**
 * The MCP server end to end over an in-memory transport (Task 17 and design Components 11-12):
 * instructions, the tool list, resource_link gating by protocol version, progress notifications,
 * and client-side cancellation.
 *
 * Validates: Requirements 5.4, 5.5, 5.7, 6.2, 6.3, 8.4
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pg', async () => (await import('./test/fake-pg')).fakePgModule);

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { fakeDb, FakePool, FakeColumn } from './test/fake-pg';
import { setupFakeDb, makeRuntime, teardown, lazyRows, until } from './test/harness';
import { createMcpServer, SERVER_INSTRUCTIONS, SERVER_VERSION } from './server';
import type { Runtime } from './runtime';

const ID_NAME: FakeColumn[] = [{ name: 'id', oid: 23 }, { name: 'name', oid: 1043 }];

let pool: FakePool;
let rt: Runtime;
const closers: Array<() => Promise<void>> = [];

async function connectClient(runtime: Runtime): Promise<Client> {
  const handle = createMcpServer(() => runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  closers.push(() => client.close());
  return client;
}

/** A raw JSON-RPC client, to initialize with a specific protocol version. */
async function connectRaw(runtime: Runtime, protocolVersion: string) {
  const handle = createMcpServer(() => runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const inbox: JSONRPCMessage[] = [];
  clientTransport.onmessage = (m) => inbox.push(m);
  await clientTransport.start();
  await handle.connect(serverTransport);
  closers.push(() => clientTransport.close());
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    await clientTransport.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    await until(() => inbox.some((m) => (m as { id?: number }).id === id), 5_000, method);
    return inbox.find((m) => (m as { id?: number }).id === id) as { result: any };
  };
  const init = await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '0' } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  return { init, request, handle };
}

beforeEach(() => {
  pool = setupFakeDb();
  rt = makeRuntime({ progressIntervalMs: 40 });
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  await teardown();
});

describe('initialize and tools/list', () => {
  test('the server sends its instructions and version', async () => {
    const client = await connectClient(rt);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getServerVersion()).toEqual({ name: 'sql-context-presets-mcp', version: SERVER_VERSION });
  });

  test('the tool list includes the paging and export tools with their arguments', async () => {
    const client = await connectClient(rt);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'run_query', 'fetch_rows', 'export_query', 'export_status', 'list_schemas', 'list_tables', 'describe_table',
      'get_sample_data', 'connection_status', 'get_schema_context', 'list_presets',
    ]);
    const run = tools.find((t) => t.name === 'run_query')!;
    expect(Object.keys(run.inputSchema.properties ?? {})).toEqual(['sql', 'format', 'maxRows', 'maxChars', 'timeoutMs']);
    expect(run.description).toContain('fetch_rows');
    expect(run.description).toContain('aggregate in SQL');
    expect(run.description).toContain('Session settings (SET) do not carry over');
    const exp = tools.find((t) => t.name === 'export_query')!;
    expect(Object.keys(exp.inputSchema.properties ?? {})).toEqual(['sql', 'format', 'fileName', 'wait', 'maxRows', 'maxBytes', 'timeoutMs']);
  });
});

describe('tools over MCP', () => {
  test('run_query and fetch_rows page through a result', async () => {
    fakeDb.define('select id, name from big', { columns: ID_NAME, rows: lazyRows(150), rowCount: 150 });
    const client = await connectClient(rt);
    const first = await client.callTool({ name: 'run_query', arguments: { sql: 'select id, name from big', format: 'csv' } });
    const content = first.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(2);
    const resultId = /"resultId":"(r_[a-z2-7]{16})"/.exec(content[1].text)![1];
    const next = await client.callTool({ name: 'fetch_rows', arguments: { resultId, format: 'json' } });
    const page = JSON.parse((next.content as Array<{ text: string }>)[0].text);
    expect(page).toMatchObject({ offset: 100, rowCount: 50, totalRows: 150, hasMore: false });
  });

  test('export_query links the file for clients on MCP 2025-06-18 or later', async () => {
    fakeDb.define('select id, name from t', { columns: ID_NAME, rows: lazyRows(3) });
    const client = await connectClient(rt);
    const result = await client.callTool({ name: 'export_query', arguments: { sql: 'select id, name from t' } });
    const content = result.content as Array<{ type: string; uri?: string }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'resource_link']);
    expect(content[1].uri).toMatch(/^file:\/\/\/.+\.csv$/);
  });

  test('older protocol versions get the JSON result without a resource_link', async () => {
    fakeDb.define('select id, name from t', { columns: ID_NAME, rows: lazyRows(3) });
    const raw = await connectRaw(rt, '2025-03-26');
    expect(raw.init.result.protocolVersion).toBe('2025-03-26');
    expect(raw.handle.protocolVersion()).toBe('2025-03-26');
    const response = await raw.request('tools/call', { name: 'export_query', arguments: { sql: 'select id, name from t' } });
    expect(response.result.content.map((c: { type: string }) => c.type)).toEqual(['text']);
    const modern = await connectRaw(rt, '2025-06-18');
    const linked = await modern.request('tools/call', { name: 'export_query', arguments: { sql: 'select id, name from t' } });
    expect(linked.result.content.map((c: { type: string }) => c.type)).toEqual(['text', 'resource_link']);
  });

  test('long calls send progress notifications with increasing progress', async () => {
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(5), delayMs: 300 });
    const client = await connectClient(rt);
    const updates: Array<{ progress: number; message?: string }> = [];
    const result = await client.callTool(
      { name: 'run_query', arguments: { sql: 'select id, name from slow' } },
      undefined,
      { onprogress: (p) => updates.push(p) },
    );
    expect((result.content as Array<{ text: string }>)[0].text).toContain('5 rows returned.');
    expect(updates.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < updates.length; i++) expect(updates[i].progress).toBeGreaterThan(updates[i - 1].progress);
    expect(updates.some((u) => /^query running on the database \(\d+s\)$/.test(u.message ?? ''))).toBe(true);
  });

  test('export progress reports rows and bytes', async () => {
    fakeDb.define('select id, name from big', { columns: ID_NAME, rows: lazyRows(200_000), rowCount: 200_000 });
    const client = await connectClient(rt);
    const updates: Array<{ progress: number; message?: string }> = [];
    await client.callTool(
      { name: 'export_query', arguments: { sql: 'select id, name from big', format: 'jsonl' } },
      undefined,
      { onprogress: (p) => updates.push(p), timeout: 60_000 },
    );
    expect(updates.some((u) => /^exporting \([\d,]+ rows, \d+ (B|KB|MB)\)$/.test(u.message ?? ''))).toBe(true);
  }, 60_000);

  test('cancelling a call from the client cancels the query and releases the connection', async () => {
    fakeDb.define('select id, name from slow', { columns: ID_NAME, rows: lazyRows(5), delayMs: 10_000 });
    const client = await connectClient(rt);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'run_query', arguments: { sql: 'select id, name from slow' } }, undefined, { signal: controller.signal });
    await until(() => fakeDb.log.some((s) => s.startsWith('DECLARE')), 2_000, 'declare');
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await until(() => fakeDb.cancelRequests.length > 0, 2_000, 'cancel request');
    await until(() => pool.checkedOutCount === 0, 2_000, 'release');
    expect(fakeDb.leakedTransactions()).toHaveLength(0);
  });
});
