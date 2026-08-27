/**
 * Bug condition exploration test — stale connections transparently replaced.
 *
 * Property 3: Stale Connections Replaced for All Auth Methods
 *
 * Originally this file pinned the fix for "a dead cached client is reused without a liveness
 * check" by asserting `ensureConnection()` ran `SELECT 1` against the cached client before
 * reuse. The per-query pool checkout refactor (concurrent executeQuery support) removed the
 * single cached client entirely: queries now run via `pool.query()`, and a per-reuse liveness
 * probe no longer maps to a pool (each query may check out a DIFFERENT pooled connection, and pg
 * offers no checkout-time validation hook — probing one connection says nothing about the one
 * the real query will get).
 *
 * The USER-VISIBLE property this spec actually cares about is unchanged, and is what this file
 * now pins at the `executeQuery()` level, per design.md's Correctness Property 3:
 *
 *   "For any input where the active connection state is stale/dead, regardless of authMethod
 *    being 'direct', 'iam', or 'secrets_manager', the system SHALL discard the stale state and
 *    transparently establish a new connection — the caller's query succeeds without ever seeing
 *    the connection-level fault."
 *
 * Mechanically, staleness is now handled reactively by `executeQuery()`'s bounded retry: the
 * dead pooled connection fails the query with a connection-level error, the WHOLE pool is
 * discarded (covering the "every idle connection died together" case, e.g. network drop or
 * laptop sleep), and the retry rebuilds a fresh pool — so this test injects a pool whose
 * connections are all dead and asserts the query still resolves successfully, the dead pool is
 * drained, and the module ends up holding a brand-new pool. For `'iam'`, credentials are
 * generated NOT yet expired, so only the sockets are dead — confirming the socket-death recovery
 * path is independent of the credential-expiry recycle path (Property 4).
 *
 * `pg.Pool` and `@aws-sdk/client-secrets-manager` are mocked so no real database or AWS call is
 * ever made; `executeQuery()`, `__setTestConnectionState()`, and `__getTestConnectionState()`
 * are imported directly from `./index` as a minimal, additive test seam (see the NOTE comments
 * next to their declarations in `src/index.ts`).
 *
 * Validates: Requirements 1.2
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// `vi.hoisted` lets us define mutable state that both the hoisted `vi.mock()` factories below and
// the test body can read/write, working around vi.mock's hoisting to the top of the file.
const hoisted = vi.hoisted(() => {
  return {
    // Every `Pool` instance constructed by `new Pool(config)` inside `createPool()` (i.e. each
    // replacement pool built after the dead one is discarded), in construction order. Their
    // `query` always succeeds — the replacement pool is healthy.
    poolInstances: [] as Array<{
      query: ReturnType<typeof import('vitest').vi.fn>;
      end: ReturnType<typeof import('vitest').vi.fn>;
      on: ReturnType<typeof import('vitest').vi.fn>;
      config: unknown;
    }>,
  };
});

vi.mock('pg', () => {
  class MockPool {
    public config: unknown;
    query = vi.fn(async () => ({ rows: [], rowCount: 0, fields: [] }));
    end = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(config: unknown) {
      this.config = config;
      hoisted.poolInstances.push(this as any);
    }
  }
  return { Pool: MockPool };
});

// `'secrets_manager'` auth unconditionally calls out to AWS Secrets Manager inside
// `getConnectionConfig()` (no caching), so it must be mocked to keep this test hermetic.
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

import { executeQuery, __setTestConnectionState, __getTestConnectionState } from './index';

type AuthMethod = 'direct' | 'iam' | 'secrets_manager';

const ENV_KEYS = [
  'SQL_AUTH_METHOD',
  'SQL_HOST',
  'SQL_PORT',
  'SQL_DATABASE',
  'SQL_USER',
  'SQL_PASSWORD',
  'SQL_SECRET_ID',
] as const;
let savedEnv: Record<string, string | undefined> = {};

const TEST_QUERY_SQL = 'SELECT * FROM stale_connection_probe';

/** A pool ALL of whose connections are dead: every per-query checkout fails with a
 * connection-level error (the pooled equivalent of the pre-refactor "dead cached client"). */
function makeDeadPool() {
  const deadSocketError = Object.assign(new Error('Connection terminated unexpectedly'), {
    code: 'ECONNRESET',
  });
  return {
    query: vi.fn().mockRejectedValue(deadSocketError),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // Reset module-level connection state so each property run/example starts from a clean slate.
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

describe('Bug condition exploration: stale connections transparently replaced (Property 3)', () => {
  const authMethodArb = fc.constantFrom<AuthMethod>('direct', 'iam', 'secrets_manager');
  const iamExpiryOffsetMsArb = fc.integer({ min: 60_000, max: 900_000 }); // 1–15 min in the future

  test(
    'executeQuery() discards a dead pool and transparently succeeds on a fresh one, for every auth method',
    async () => {
      await fc.assert(
        fc.asyncProperty(authMethodArb, iamExpiryOffsetMsArb, async (authMethod, iamExpiryOffsetMs) => {
          process.env.SQL_AUTH_METHOD = authMethod;
          process.env.SQL_HOST = 'mock-host';
          process.env.SQL_PORT = '5439';
          process.env.SQL_DATABASE = 'mock-db';
          process.env.SQL_USER = 'mock-user';
          process.env.SQL_PASSWORD = 'mock-pass';
          if (authMethod === 'secrets_manager') process.env.SQL_SECRET_ID = 'mock-secret-id';

          const deadPool = makeDeadPool();
          hoisted.poolInstances = [];

          const testState: Parameters<typeof __setTestConnectionState>[0] = { pool: deadPool as any };
          if (authMethod === 'iam') {
            // Credentials have NOT yet expired — only the sockets are dead. This pins the
            // socket-death recovery path as independent of the credential-expiry recycle path:
            // recovery must fire even when expiry alone would NOT have triggered a recycle.
            testState.iamCredentialsCache = {
              user: 'cached-iam-user',
              password: 'cached-iam-password',
              expiry: Date.now() + iamExpiryOffsetMs,
            };
          }
          __setTestConnectionState(testState);

          const result = await executeQuery(TEST_QUERY_SQL);

          // Expected behavior, Property 3: the query was attempted against the stale pool (that
          // is how staleness is detected), the dead pool was then discarded (drained), and the
          // caller's query transparently succeeded on a freshly built pool — the caller never
          // sees the connection-level fault.
          expect(deadPool.query).toHaveBeenCalledWith(TEST_QUERY_SQL, undefined);
          expect(deadPool.end).toHaveBeenCalledTimes(1);
          expect(result).toBeDefined();
          expect(result.rowCount).toBe(0);

          // A brand-new pool was constructed and is now the module's active pool.
          expect(hoisted.poolInstances.length).toBeGreaterThanOrEqual(1);
          const state = __getTestConnectionState();
          expect(state.pool).not.toBe(deadPool);
          expect(state.pool).toBe(hoisted.poolInstances[hoisted.poolInstances.length - 1]);
        }),
        { numRuns: 15 }
      );
    },
    30_000
  );

  test('direct auth: dead pool is discarded and replaced, query succeeds transparently (documents the fixed behavior)', async () => {
    process.env.SQL_AUTH_METHOD = 'direct';
    process.env.SQL_HOST = 'mock-host';
    process.env.SQL_PORT = '5439';
    process.env.SQL_DATABASE = 'mock-db';
    process.env.SQL_USER = 'mock-user';
    process.env.SQL_PASSWORD = 'mock-pass';
    const deadPool = makeDeadPool();
    __setTestConnectionState({ pool: deadPool as any });

    const result = await executeQuery(TEST_QUERY_SQL);

    expect(deadPool.query).toHaveBeenCalledWith(TEST_QUERY_SQL, undefined);
    expect(deadPool.end).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(__getTestConnectionState().pool).not.toBe(deadPool);
  });

  test('secrets_manager auth: dead pool is discarded and replaced, query succeeds transparently (documents the fixed behavior)', async () => {
    process.env.SQL_AUTH_METHOD = 'secrets_manager';
    process.env.SQL_SECRET_ID = 'mock-secret-id';
    const deadPool = makeDeadPool();
    __setTestConnectionState({ pool: deadPool as any });

    const result = await executeQuery(TEST_QUERY_SQL);

    expect(deadPool.query).toHaveBeenCalledWith(TEST_QUERY_SQL, undefined);
    expect(deadPool.end).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(__getTestConnectionState().pool).not.toBe(deadPool);
  });

  test('iam auth with non-expired credentials: dead pool (dead sockets only) is discarded and replaced (confirms socket-death recovery is independent of credential expiry)', async () => {
    process.env.SQL_AUTH_METHOD = 'iam';
    process.env.SQL_HOST = 'mock-host';
    process.env.SQL_PORT = '5439';
    process.env.SQL_DATABASE = 'mock-db';
    process.env.SQL_USER = 'mock-user';
    process.env.SQL_PASSWORD = 'mock-pass';
    const deadPool = makeDeadPool();
    __setTestConnectionState({
      pool: deadPool as any,
      iamCredentialsCache: {
        user: 'cached-iam-user',
        password: 'cached-iam-password',
        expiry: Date.now() + 5 * 60_000, // 5 minutes in the future: not yet expired
      },
    });

    const result = await executeQuery(TEST_QUERY_SQL);

    expect(deadPool.query).toHaveBeenCalledWith(TEST_QUERY_SQL, undefined);
    expect(deadPool.end).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(__getTestConnectionState().pool).not.toBe(deadPool);
  });
});
