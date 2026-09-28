/**
 * Bug condition exploration test — bounded reconnect-and-retry on connection-level errors.
 *
 * Property 5: Bug Condition - Connection-Level Errors Surface Raw With No Retry
 *
 * This test was originally written and run BEFORE any fix was implemented (Phase 1 of the
 * bugfix methodology). It encodes the EXPECTED (post-fix) behavior of `executeQuery()` per
 * design.md's Correctness Property 5:
 *
 *   "For any input where executeQuery()'s underlying query throws an error classified as
 *    connection-level (e.g. ECONNRESET, ECONNREFUSED, 'Connection terminated', socket errors), the
 *    fixed system SHALL discard the dead connection/pool, re-establish a new connection, and retry
 *    the same operation ... returning the successful result to the caller if any retry succeeds."
 *
 * Updated for the per-query pool checkout refactor (concurrent executeQuery support): queries now
 * run via `pool.query()` (per-query checkout) instead of a single shared cached client, and on a
 * connection-level error the WHOLE pool is discarded (drained in the background) before the retry
 * rebuilds a fresh pool via `ensurePool()`/`createPool()`. The retry contract itself is unchanged:
 * `MAX_QUERY_ATTEMPTS = 3` total attempts, short exponential backoff (100ms, 300ms), only
 * connection-level errors retried.
 *
 * NOTE on the mock shape: `createPool()` eagerly validates each new pool with `SELECT 1`
 * immediately after construction. Because that validation goes through the same mocked `query`
 * path, the mocks below behave differently based on the SQL text: `'SELECT 1'` (the validation
 * text) always succeeds, while the distinct `REAL_QUERY_SQL` text used for the actual
 * `executeQuery()` call under test carries the generated fault — counted via a shared tracker
 * that spans pool discard/rebuild cycles, since the pool OBJECT changes between attempts. This
 * keeps the property under test scoped to mid-query connection loss (Property 5) rather than
 * pool-creation failures.
 *
 * `pg.Pool` is mocked so no real database is ever contacted. `executeQuery()`,
 * `__setTestConnectionState()`, and `__getTestConnectionState()` are imported directly from
 * `./index` as a minimal, additive test seam (see the NOTE comments next to their declarations
 * in `src/index.ts`).
 *
 * Validates: Requirements 1.6, 2.6, 2.7, 2.9
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// `vi.hoisted` lets us define mutable state that both the hoisted `vi.mock()` factory below and
// the test body can read/write, working around vi.mock's hoisting to the top of the file.
// `queryImpl` is the per-test behavior every MockPool instance delegates to, so replacement pools
// built during a discard-and-rebuild cycle share the same fault model as the injected one.
const hoisted = vi.hoisted(() => {
  return {
    queryImpl: null as null | ((sql: string, params?: unknown) => Promise<any>),
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
    query = vi.fn(async (sql: string, params?: unknown) => {
      if (!hoisted.queryImpl) throw new Error('test error: hoisted.queryImpl not set');
      return hoisted.queryImpl(sql, params);
    });
    end = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(config: unknown) {
      this.config = config;
      hoisted.poolInstances.push(this as any);
    }
  }
  return { Pool: MockPool };
});

import { executeQuery, __setTestConnectionState, __getTestConnectionState } from './index';

const ENV_KEYS = [
  'SQL_AUTH_METHOD',
  'SQL_HOST',
  'SQL_PORT',
  'SQL_DATABASE',
  'SQL_USER',
  'SQL_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined> = {};

// The SQL text used for the "real" query under test in this file, deliberately distinct from
// `'SELECT 1'` (the eager pool-validation text used internally by `createPool()`) so the fault
// model below can fail/succeed the real query independently of pool creation.
const REAL_QUERY_SQL = 'SELECT * FROM property_test_table';

// Property-generate connection-level error shapes: `code` and message variants per design.md's
// `isConnectionLevelError` classifier vocabulary.
const connectionErrorCodeArb = fc.constantFrom('ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT');
const connectionErrorMessageArb = fc.constantFrom(
  'Connection terminated unexpectedly',
  'Connection terminated',
  'read ECONNRESET',
  'terminated unexpectedly'
);
const connectionErrorArb = fc
  .record({ code: connectionErrorCodeArb, message: connectionErrorMessageArb })
  .map(({ code, message }) => Object.assign(new Error(message), { code }));

/** Shared counter tracking how many times the REAL query (`REAL_QUERY_SQL`) has been attempted,
 * independent of which pool object handled the call — this lets the fault model ("fails N times,
 * then succeeds") span a discard-and-rebuild cycle where the pool itself changes between
 * attempts, matching the real fix's discard/reconnect behavior. */
function makeRealQueryTracker() {
  return { attempts: 0 };
}

/** Installs the shared fault model: `query('SELECT 1')` (pool validation) ALWAYS succeeds, and
 * `query(REAL_QUERY_SQL)` rejects with `rejectError` for the first `failCount` attempts (counted
 * via the shared `tracker`, across however many pool objects are used), then succeeds. */
function installQueryImpl(tracker: { attempts: number }, rejectError: unknown, failCount: number) {
  hoisted.queryImpl = async (sql: unknown) => {
    // executeQuery passes a query config (`{ text, rowMode: 'array', types }`); pool validation a string.
    const text = typeof sql === 'string' ? sql : (sql as { text?: string } | null)?.text;
    if (text !== REAL_QUERY_SQL) {
      // Pool validation or any other non-real-query call: always succeed so it never interferes
      // with the mid-query retry semantics under test here.
      return { rows: [], rowCount: 0, fields: [] };
    }
    tracker.attempts += 1;
    if (tracker.attempts <= failCount) {
      throw rejectError;
    }
    return { rows: [], rowCount: 0, fields: [] };
  };
}

/** A standalone mocked pool (the "currently active" pool injected via the seam) that delegates
 * to the same shared `queryImpl` fault model as MockPool instances. */
function makeInjectedPool() {
  return {
    query: vi.fn(async (sql: string, params?: unknown) => {
      if (!hoisted.queryImpl) throw new Error('test error: hoisted.queryImpl not set');
      return hoisted.queryImpl(sql, params);
    }),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SQL_AUTH_METHOD = 'direct';
  process.env.SQL_HOST = 'mock-host';
  process.env.SQL_PORT = '5439';
  process.env.SQL_DATABASE = 'mock-db';
  process.env.SQL_USER = 'mock-user';
  process.env.SQL_PASSWORD = 'mock-pass';
  // Reset module-level connection state so each property run/example starts from a clean slate.
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
  hoisted.queryImpl = null;
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

describe('Bug condition exploration: mid-query connection loss with bounded reconnect-and-retry (Property 5)', () => {
  test(
    'executeQuery() retries and succeeds after a transient connection-level error on the real query (counterexample surfaced on unfixed code)',
    async () => {
      await fc.assert(
        fc.asyncProperty(connectionErrorArb, async (generatedError) => {
          const tracker = makeRealQueryTracker();
          installQueryImpl(tracker, generatedError, 1);
          const injectedPool = makeInjectedPool();
          __setTestConnectionState({ pool: injectedPool as any });

          let resolvedResult: unknown;
          let thrown: unknown;
          try {
            resolvedResult = await executeQuery(REAL_QUERY_SQL);
          } catch (error) {
            thrown = error;
          }

          // Expected (fixed) behavior, Property 5: a connection-level error on the real query
          // should trigger a bounded reconnect-and-retry, so the real query must be attempted
          // MORE THAN once (across the discard-and-rebuild cycle), and because a later attempt
          // succeeds, executeQuery() must resolve successfully rather than throwing the raw
          // connection error straight through.
          expect(tracker.attempts).toBeGreaterThan(1);
          expect(thrown).toBeUndefined();
          expect(resolvedResult).toBeDefined();
        }),
        { numRuns: 15 }
      );
    },
    30_000
  );

  test('direct auth: a single transient ECONNRESET on the real query is now retried and succeeds, with the dead pool drained (documents the fixed behavior)', async () => {
    const generatedError = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'ECONNRESET',
    });
    const tracker = makeRealQueryTracker();
    installQueryImpl(tracker, generatedError, 1);
    const injectedPool = makeInjectedPool();
    __setTestConnectionState({ pool: injectedPool as any });

    // This is the fixed behavior: a connection-level error on the real query triggers a bounded
    // reconnect-and-retry, so a single transient ECONNRESET that succeeds on the second attempt
    // now resolves successfully rather than propagating straight through.
    const result = await executeQuery(REAL_QUERY_SQL);
    expect(result).toBeDefined();
    expect(tracker.attempts).toBeGreaterThan(1);
    expect(tracker.attempts).toBeLessThanOrEqual(3);

    // The dead pool from the first (failed) attempt was discarded during the retry: its drain
    // (`end()`) was initiated, and the module's active pool is no longer that same dead instance
    // (it was replaced by a freshly-built pool during reconnection).
    expect(injectedPool.end).toHaveBeenCalledTimes(1);
    expect(hoisted.poolInstances.length).toBeGreaterThanOrEqual(1);
    expect(__getTestConnectionState().pool).not.toBe(injectedPool);
  });

  test('direct auth: a persistently failing connection-level error on the real query exhausts retries at MAX_QUERY_ATTEMPTS, returns a clear error, and never crashes the process (retry-exhaustion edge case)', async () => {
    const generatedError = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'ECONNRESET',
    });
    // failCount = Infinity: the real query NEVER succeeds, on any attempt against any (re)built
    // pool — modeling a persistent (non-transient) connection-level fault rather than a one-off
    // blip. Pool validation ('SELECT 1') still succeeds, so each retry reaches the real query.
    const tracker = makeRealQueryTracker();
    installQueryImpl(tracker, generatedError, Infinity);
    const injectedPool = makeInjectedPool();
    __setTestConnectionState({ pool: injectedPool as any });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit should never be called during retry exhaustion');
    }) as any);

    let thrown: unknown;
    try {
      await executeQuery(REAL_QUERY_SQL);
    } catch (error) {
      thrown = error;
    }

    // (a) executeQuery() ultimately throws a clear error (the connection-level error, or a
    // wrapped version of it) after exactly MAX_QUERY_ATTEMPTS (3) real-query attempts — not more,
    // not fewer.
    expect(thrown).toBeDefined();
    expect(tracker.attempts).toBe(3);

    // (b) every pool involved was discarded: the injected pool's drain was initiated, as was the
    // drain of each replacement pool whose real query also failed.
    expect(injectedPool.end).toHaveBeenCalledTimes(1);
    for (const rebuiltPool of hoisted.poolInstances) {
      expect(rebuiltPool.end).toHaveBeenCalledTimes(1);
    }

    // (c) no crash / no process.exit call during the exhaustion path.
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();

    // (d) the module remains in a valid state for a subsequent call to retry again: the pool is
    // null after exhaustion (no permanent poisoned flag), ready for the next ensurePool() call
    // to rebuild it, per design.md's Property 5 guarantee.
    const finalState = __getTestConnectionState();
    expect(finalState.pool).toBeNull();
  });
});
