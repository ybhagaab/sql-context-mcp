/**
 * Unit test — `keepAlive`/`keepAliveInitialDelayMillis`/`max` present in the constructed `Pool`
 * config.
 *
 * Task 11.2 (mcp-server-connection-reliability bugfix spec): Task 11.1 added
 * `keepAlive: true, keepAliveInitialDelayMillis: 10000` to the config object returned by
 * `getConnectionConfig()` (merged into the object passed to `new Pool(...)`), per design.md
 * Hypothesized Root Cause #3 (undetected dead TCP connections) and Requirement 2.3. This is a
 * plain unit test (not a new property, per the task description) that confirms those keys
 * actually reach the `Pool` constructor for every supported `authMethod`.
 *
 * Updated for the per-query pool checkout refactor (concurrent executeQuery support): the pool
 * config now also carries `max` — the number of connections the pool may open, which is the
 * concurrency ceiling for parallel queries. `max` defaults to 10 (pg's own default) and is
 * overridable via the `SQL_POOL_MAX` env var; both behaviors are asserted below, including
 * fallback to 10 on invalid values.
 *
 * `getConnectionConfig()` is not exported, so this test verifies indirectly: `pg.Pool` is mocked
 * with a `MockPool` that captures the `config` object passed to its constructor (the same pattern
 * used by index.stale-connection.exploration.test.ts / index.iam-recycle.preservation.test.ts),
 * and `ensurePool()` (already exported as a test seam) is called with no pre-existing pool,
 * forcing it to fall through to `getConnectionConfig()` + `new Pool(config)`. The AWS SDK
 * clients used by the `'iam'` and `'secrets_manager'` auth paths are mocked so no real AWS call
 * is ever made.
 *
 * Validates: Requirements 2.3
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// `vi.hoisted` lets us define mutable state that both the hoisted `vi.mock()` factories below and
// the test body can read/write, working around vi.mock's hoisting to the top of the file.
const hoisted = vi.hoisted(() => {
  return {
    // Every `Pool` instance constructed by `new Pool(config)`, in construction order, so the test
    // can inspect the exact config object passed in.
    poolInstances: [] as Array<{ config: any }>,
  };
});

vi.mock('pg', () => {
  class MockPool {
    public config: any;
    query = vi.fn(async () => ({ rows: [], rowCount: 0, fields: [] }));
    end = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(config: any) {
      this.config = config;
      hoisted.poolInstances.push(this);
    }
  }
  return { Pool: MockPool };
});

vi.mock('@aws-sdk/client-redshift', () => {
  return {
    RedshiftClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        DbUser: 'mock-iam-db-user',
        DbPassword: 'mock-iam-db-password',
      }),
    })),
    GetClusterCredentialsCommand: vi.fn().mockImplementation((input: unknown) => input),
  };
});

vi.mock('@aws-sdk/client-secrets-manager', () => {
  return {
    SecretsManagerClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({
          host: 'mock-secrets-host',
          database: 'mock-secrets-db',
          username: 'mock-secrets-user',
          password: 'mock-secrets-pass',
        }),
      }),
    })),
    GetSecretValueCommand: vi.fn().mockImplementation((input: unknown) => input),
  };
});

import { ensurePool, __setTestConnectionState } from './index';

type AuthMethod = 'direct' | 'iam' | 'secrets_manager';

const ENV_KEYS = [
  'SQL_AUTH_METHOD',
  'SQL_HOST',
  'SQL_PORT',
  'SQL_DATABASE',
  'SQL_USER',
  'SQL_PASSWORD',
  'SQL_CLUSTER_ID',
  'SQL_SECRET_ID',
  'SQL_POOL_MAX',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.SQL_POOL_MAX;
  // Reset module-level connection state so each case starts from a clean slate (no pool, forcing
  // ensurePool() to fall through to getConnectionConfig()/new Pool(config)).
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
  hoisted.poolInstances = [];
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
});

function setDirectEnv() {
  process.env.SQL_AUTH_METHOD = 'direct';
  process.env.SQL_HOST = 'mock-host';
  process.env.SQL_PORT = '5439';
  process.env.SQL_DATABASE = 'mock-db';
  process.env.SQL_USER = 'mock-user';
  process.env.SQL_PASSWORD = 'mock-pass';
}

describe('keepAlive / keepAliveInitialDelayMillis / max present in constructed Pool config (Task 11.2)', () => {
  const cases: Array<{ authMethod: AuthMethod; setEnv: () => void }> = [
    {
      authMethod: 'direct',
      setEnv: setDirectEnv,
    },
    {
      authMethod: 'iam',
      setEnv: () => {
        process.env.SQL_AUTH_METHOD = 'iam';
        process.env.SQL_HOST = 'mock-iam-host';
        process.env.SQL_PORT = '5439';
        process.env.SQL_DATABASE = 'mock-iam-db';
        process.env.SQL_CLUSTER_ID = 'mock-cluster-id';
        process.env.SQL_USER = 'mock-db-user';
      },
    },
    {
      authMethod: 'secrets_manager',
      setEnv: () => {
        process.env.SQL_AUTH_METHOD = 'secrets_manager';
        process.env.SQL_SECRET_ID = 'mock-secret-id';
      },
    },
  ];

  for (const { authMethod, setEnv } of cases) {
    test(`config passed to new Pool(...) includes keepAlive: true, keepAliveInitialDelayMillis: 10000, and max: 10 (default) for authMethod='${authMethod}'`, async () => {
      setEnv();
      hoisted.poolInstances = [];

      await ensurePool();

      expect(hoisted.poolInstances).toHaveLength(1);
      const config = hoisted.poolInstances[0].config;
      expect(config.keepAlive).toBe(true);
      expect(config.keepAliveInitialDelayMillis).toBe(10000);
      expect(config.max).toBe(10);
    });
  }
});

describe('SQL_POOL_MAX controls the pool max (concurrent query ceiling)', () => {
  test('config passed to new Pool(...) uses SQL_POOL_MAX when set to a valid positive integer', async () => {
    setDirectEnv();
    process.env.SQL_POOL_MAX = '7';
    hoisted.poolInstances = [];

    await ensurePool();

    expect(hoisted.poolInstances).toHaveLength(1);
    expect(hoisted.poolInstances[0].config.max).toBe(7);
  });

  for (const invalid of ['0', '-3', 'abc', '']) {
    test(`config passed to new Pool(...) falls back to max: 10 for invalid SQL_POOL_MAX='${invalid}'`, async () => {
      setDirectEnv();
      process.env.SQL_POOL_MAX = invalid;
      hoisted.poolInstances = [];

      await ensurePool();

      expect(hoisted.poolInstances).toHaveLength(1);
      expect(hoisted.poolInstances[0].config.max).toBe(10);
    });
  }
});
