/**
 * Shared setup for integration tests that run the tools against the fake database.
 *
 * Test files must mock pg themselves (vi.mock is hoisted per file):
 *
 *   vi.mock('pg', async () => (await import('./test/fake-pg')).fakePgModule);
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fakeDb, FakePool } from './fake-pg';
import { __setTestConnectionState } from '../db/pool';
import { __resetEngineCache } from '../db/engine';
import { Lease } from '../db/lease';
import { DEFAULTS, ServerConfig } from '../config';
import { createRuntime, Runtime, RuntimeOptions } from '../runtime';
import { handleToolCall, ToolExtra, ToolResult } from '../tools';

const ENV = {
  SQL_AUTH_METHOD: 'direct',
  SQL_HOST: 'fake-host',
  SQL_PORT: '5439',
  SQL_DATABASE: 'fake-db',
  SQL_USER: 'fake-user',
  SQL_PASSWORD: 'fake-password',
  SQL_SSL_MODE: 'disable',
};

let savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
const runtimes: Runtime[] = [];

/** Plenty of free disk space (so tests don't depend on the machine). */
export const plentyOfSpace = async (): Promise<{ bavail: number; bsize: number }> => ({ bavail: 1e12, bsize: 1 });

export function lowSpaceAfter(calls: number): () => Promise<{ bavail: number; bsize: number }> {
  let n = 0;
  return async () => {
    n++;
    return n > calls ? { bavail: 1_000, bsize: 1 } : { bavail: 1e12, bsize: 1 };
  };
}

/** Resets the fake database and installs a fresh fake pool as the active pool. */
export function setupFakeDb(poolMax = 10): FakePool {
  savedEnv = {};
  for (const [key, value] of Object.entries(ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  fakeDb.reset();
  __resetEngineCache();
  Lease.cancelGraceMs = 30;
  const pool = new FakePool({ max: poolMax });
  __setTestConnectionState({ pool: pool as never, iamCredentialsCache: null });
  return pool;
}

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-test-'));
  tempDirs.push(dir);
  return dir;
}

export function makeRuntime(overrides: Partial<ServerConfig> = {}, opts: RuntimeOptions = {}): Runtime {
  const runtime = createRuntime({ ...DEFAULTS, ...overrides }, { baseDir: tempDir(), statfs: plentyOfSpace, ...opts });
  runtimes.push(runtime);
  return runtime;
}

/** Deletes every temporary folder created by tempDir(). */
export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export async function teardown(): Promise<void> {
  for (const runtime of runtimes.splice(0)) {
    await runtime.results.closeAll().catch(() => undefined);
    await runtime.exports.closeAll().catch(() => undefined);
  }
  removeTempDirs();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
}

export function call(runtime: Runtime, name: string, args: unknown, extra: ToolExtra = {}, resourceLinks = true): Promise<ToolResult> {
  return handleToolCall(name, args, extra, { runtime, resourceLinks });
}

export function textOf(result: ToolResult, block = 0): string {
  const item = result.content[block];
  if (!item || item.type !== 'text') throw new Error(`block ${block} is not text: ${JSON.stringify(result.content)}`);
  return item.text;
}

export function jsonOf<T = any>(result: ToolResult, block = 0): T {
  return JSON.parse(textOf(result, block)) as T;
}

/** Rows generated lazily: `[String(i), ...extra(i)]`. */
export function lazyRows(count: number, extra: (i: number) => Array<string | null> = (i) => [`name-${i}`]) {
  return () => (function* () {
    for (let i = 0; i < count; i++) yield [String(i), ...extra(i)];
  })();
}

/** RFC 4180 parser for test assertions (fields keep their quoting information). */
export function parseCsv(text: string): Array<Array<{ value: string; quoted: boolean }>> {
  const rows: Array<Array<{ value: string; quoted: boolean }>> = [];
  let row: Array<{ value: string; quoted: boolean }> = [];
  let i = 0;
  if (text.length === 0) return rows;
  for (;;) {
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      for (;;) {
        if (i >= text.length) throw new Error('unterminated quoted field');
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i++];
      }
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '\n') value += text[i++];
    }
    row.push({ value, quoted });
    if (i >= text.length) {
      rows.push(row);
      return rows;
    }
    if (text[i] === ',') {
      i++;
      continue;
    }
    // newline
    i++;
    rows.push(row);
    row = [];
    if (i >= text.length) return rows;
  }
}

/** Waits until `predicate` holds (polling), or fails after `timeoutMs`. */
export async function until(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
