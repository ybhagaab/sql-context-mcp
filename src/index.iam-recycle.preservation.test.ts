/**
 * Preservation property test — IAM credential-expiry recycling path.
 *
 * Property 4: Preservation - IAM Credential-Expiry Recycle Path Unchanged
 *
 * Updated for the per-query pool checkout refactor (concurrent executeQuery support): the module
 * no longer caches a single `PoolClient` — the pooled equivalent of the recycle path lives in
 * `ensurePool()`. The PRESERVED property is unchanged in substance:
 *
 *   "For any input where `authMethod === 'iam'` and `iamCredentialsCache.expiry` is in the past,
 *    ensurePool() SHALL discard (drain) the old pool and establish a brand-new pool with freshly
 *    fetched IAM credentials — this specific recycle path must continue to behave identically."
 *
 * Why this still matters with a pool: the pool's config captures the IAM password at pool
 * creation time, so once the cached credentials expire, the old pool must never be allowed to
 * mint a NEW connection with the stale password. Expiry alone is sufficient to trigger the
 * recycle — `ensurePool()` never probes the old pool (no query of any kind is issued against it)
 * before discarding it, exactly like the pre-refactor code never probed the old cached client's
 * socket on this path.
 *
 * Concretely, on the refactored `src/index.ts`, `ensurePool()`'s expiry branch is:
 *
 *   if (pool && iamCredentialsExpired) discardPool(pool);   // pool.end() drain, in background
 *   if (pool) return pool;                                   // (pool is now null)
 *   creatingPool = createPool();                             // new Pool(config) + 'SELECT 1'
 *
 * This test asserts that observed baseline sequence — old `pool.end()` called exactly once, a
 * brand-new `Pool` constructed and eagerly validated with `SELECT 1`, `ensurePool()` resolving to
 * the new pool — for randomly generated past-expiry timestamps and random old-pool socket states.
 *
 * `pg.Pool` and `@aws-sdk/client-redshift` are mocked so no real database or AWS call is ever
 * made; `ensurePool()`, `__setTestConnectionState()`, and `__getTestConnectionState()` are
 * imported directly from `./index` as the same minimal, additive test seam used by
 * `index.stale-connection.exploration.test.ts` (Task 3).
 *
 * Validates: Requirements 3.2
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// `vi.hoisted` lets us define mutable state that both the hoisted `vi.mock()` factories below and
// the test body can read/write, working around vi.mock's hoisting to the top of the file.
const hoisted = vi.hoisted(() => {
  return {
    // Every `Pool` instance constructed by `new Pool(config)` inside `createPool()`, in
    // construction order. Used to confirm a brand-new Pool is created on each recycle and to
    // inspect its eager `SELECT 1` validation relative to the old pool's `end()`.
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

// The `'iam'` auth path's `getIAMCredentials()` dynamically imports `@aws-sdk/client-redshift` and
// calls `RedshiftClient`/`GetClusterCredentialsCommand` whenever the cache is missing or expired,
// so it must be mocked to keep this test hermetic (mirrors how Task 3's test mocks
// `@aws-sdk/client-secrets-manager` for the `'secrets_manager'` auth path).
vi.mock('@aws-sdk/client-redshift', () => {
  return {
    RedshiftClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        DbUser: 'fresh-iam-db-user',
        DbPassword: 'fresh-iam-db-password',
      }),
    })),
    GetClusterCredentialsCommand: vi.fn().mockImplementation((input: unknown) => input),
  };
});

import { ensurePool, __setTestConnectionState, __getTestConnectionState } from './index';

const ENV_KEYS = [
  'SQL_AUTH_METHOD',
  'SQL_HOST',
  'SQL_PORT',
  'SQL_DATABASE',
  'SQL_USER',
  'SQL_PASSWORD',
  'SQL_CLUSTER_ID',
] as const;
let savedEnv: Record<string, string | undefined> = {};

function makeOldPool(isLive: boolean) {
  return {
    // Whether the old pool's connections are alive or dead is irrelevant to this recycle path:
    // the code never probes the old pool at all — it recycles purely because the cached IAM
    // credentials have expired. `query` is included only for realism/shape parity with other
    // tests; it is asserted to NEVER be called by this branch.
    query: isLive
      ? vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [] })
      : vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
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

describe('Preservation: IAM credential-expiry recycle path unchanged (Property 4)', () => {
  // Past expiry: anywhere from 1ms ago to 15 minutes ago. `Date.now() >= iamCredentialsCache.expiry`
  // must hold for every generated value.
  const pastExpiryOffsetMsArb = fc.integer({ min: 1, max: 900_000 });
  const oldPoolIsLiveArb = fc.boolean();

  test(
    'ensurePool() always drains the old pool and reconnects via a brand-new Pool when IAM credentials have expired, regardless of old socket liveness',
    async () => {
      await fc.assert(
        fc.asyncProperty(pastExpiryOffsetMsArb, oldPoolIsLiveArb, async (pastExpiryOffsetMs, oldPoolIsLive) => {
          process.env.SQL_AUTH_METHOD = 'iam';
          process.env.SQL_HOST = 'mock-iam-host';
          process.env.SQL_PORT = '5439';
          process.env.SQL_DATABASE = 'mock-iam-db';
          process.env.SQL_CLUSTER_ID = 'mock-cluster-id';
          process.env.SQL_USER = 'mock-db-user';

          const oldPool = makeOldPool(oldPoolIsLive);
          hoisted.poolInstances = [];

          __setTestConnectionState({
            pool: oldPool as any,
            iamCredentialsCache: {
              user: 'stale-cached-iam-user',
              password: 'stale-cached-iam-password',
              expiry: Date.now() - pastExpiryOffsetMs,
            },
          });

          const resolvedPool = await ensurePool();

          // Observed baseline: the old pool is always drained on expiry, independent of whether
          // its connections were live or dead (this branch never probes the old pool).
          expect(oldPool.end).toHaveBeenCalledTimes(1);
          expect(oldPool.query).not.toHaveBeenCalled();

          // Observed baseline: exactly one new Pool is constructed, eagerly validated with
          // `SELECT 1`, and ensurePool() resolves to that brand-new pool, never the old one.
          expect(hoisted.poolInstances).toHaveLength(1);
          const newPoolInstance = hoisted.poolInstances[0];
          expect(newPoolInstance.query).toHaveBeenCalledWith('SELECT 1');
          expect(resolvedPool).toBe(newPoolInstance);
          expect(resolvedPool).not.toBe(oldPool);

          // Observed baseline ordering: old pool.end() (drain initiated) -> new pool's eager
          // `SELECT 1` validation.
          const endOrder = oldPool.end.mock.invocationCallOrder[0];
          const validateOrder = newPoolInstance.query.mock.invocationCallOrder[0];
          expect(endOrder).toBeLessThan(validateOrder);

          // Post-call module state reflects the new pool, not the stale one, and the fresh IAM
          // credentials were cached with a future expiry.
          const state = __getTestConnectionState();
          expect(state.pool).toBe(newPoolInstance);
          expect(state.pool).not.toBe(oldPool);
          expect(state.iamCredentialsCache).not.toBeNull();
          expect(state.iamCredentialsCache!.expiry).toBeGreaterThan(Date.now());
        }),
        { numRuns: 25 }
      );
    },
    30_000
  );

  test('documents the observed baseline for a single concrete example (past expiry, live old pool)', async () => {
    process.env.SQL_AUTH_METHOD = 'iam';
    process.env.SQL_HOST = 'mock-iam-host';
    process.env.SQL_PORT = '5439';
    process.env.SQL_DATABASE = 'mock-iam-db';
    process.env.SQL_CLUSTER_ID = 'mock-cluster-id';
    process.env.SQL_USER = 'mock-db-user';

    const oldPool = makeOldPool(true);
    hoisted.poolInstances = [];

    __setTestConnectionState({
      pool: oldPool as any,
      iamCredentialsCache: {
        user: 'stale-cached-iam-user',
        password: 'stale-cached-iam-password',
        expiry: Date.now() - 60_000, // expired 1 minute ago
      },
    });

    const resolvedPool = await ensurePool();

    expect(oldPool.end).toHaveBeenCalledTimes(1);
    expect(hoisted.poolInstances).toHaveLength(1);
    expect(resolvedPool).toBe(hoisted.poolInstances[0]);
  });
});
