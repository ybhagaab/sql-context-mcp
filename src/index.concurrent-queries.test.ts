/**
 * Concurrency test — concurrent executeQuery() calls genuinely overlap.
 *
 * Pins the fix for the serialization defect found in production: the previous implementation
 * funneled every query through ONE shared cached `PoolClient`. node-postgres serializes queries
 * issued on a single client through an internal per-connection queue, so N concurrent MCP tool
 * calls executed one-by-one — six 7-minute queries took ~42 minutes of wall clock, and callers
 * with deadlines timed out waiting in that invisible internal line.
 *
 * The refactor makes `executeQuery()` check a client out of the pool PER QUERY (`pool.query()`),
 * so concurrent calls run on separate connections in parallel, up to the pool's `max`
 * (SQL_POOL_MAX, default 10).
 *
 * The mocked pool below faithfully emulates the part of pg that matters here: a fixed number of
 * connection slots (`max`), where each in-flight query occupies one slot for its full duration
 * and further queries wait for a free slot — exactly how `pg.Pool` behaves with real
 * connections. Against this model:
 *
 *   - the OLD one-shared-client code would show at most 1 query in flight at any instant
 *     (single connection slot, everything queued behind it) and total wall time ~ N * duration;
 *   - the NEW per-query-checkout code shows min(N, max) queries in flight simultaneously and
 *     total wall time ~ duration (for N <= max).
 *
 * Assertions cover both the overlap itself (peak in-flight count) and the wall-clock consequence
 * (total elapsed far below the serial sum), plus the `max`-bounded case (N > max queues the
 * excess rather than over-opening connections).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pg', () => {
  class MockPool {
    public config: unknown;
    query = vi.fn(async () => ({ rows: [], rowCount: 0, fields: [] }));
    end = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(config: unknown) {
      this.config = config;
    }
  }
  return { Pool: MockPool };
});

import { executeQuery, __setTestConnectionState } from './index';

const ENV_KEYS = [
  'SQL_AUTH_METHOD',
  'SQL_HOST',
  'SQL_PORT',
  'SQL_DATABASE',
  'SQL_USER',
  'SQL_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SQL_AUTH_METHOD = 'direct';
  process.env.SQL_HOST = 'mock-host';
  process.env.SQL_PORT = '5439';
  process.env.SQL_DATABASE = 'mock-db';
  process.env.SQL_USER = 'mock-user';
  process.env.SQL_PASSWORD = 'mock-pass';
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __setTestConnectionState({ pool: null, iamCredentialsCache: null });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A mocked pool that emulates pg.Pool's connection-slot semantics: at most `max` queries run
 * simultaneously; each occupies a slot for `queryDurationMs`; excess queries wait (FIFO) for a
 * free slot. Tracks the peak number of simultaneously in-flight queries.
 */
function makeSlottedPool(max: number, queryDurationMs: number) {
  let inFlight = 0;
  let peakInFlight = 0;
  const waiters: Array<() => void> = [];

  const acquireSlot = async (): Promise<void> => {
    if (inFlight < max) {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
  };

  const releaseSlot = (): void => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  const pool = {
    query: vi.fn(async (sql: string) => {
      await acquireSlot();
      try {
        await sleep(queryDurationMs);
        return {
          rows: [{ echo: sql }],
          rowCount: 1,
          fields: [{ name: 'echo' }],
        };
      } finally {
        releaseSlot();
      }
    }),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
    getPeakInFlight: () => peakInFlight,
  };
  return pool;
}

describe('Concurrent executeQuery() calls run in parallel via per-query pool checkout', () => {
  test('6 concurrent queries overlap on separate connection slots: peak in-flight is 6 and wall time is ~1x query duration, not ~6x', async () => {
    const QUERY_MS = 200;
    const N = 6;
    const pool = makeSlottedPool(10, QUERY_MS);
    __setTestConnectionState({ pool: pool as any });

    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => executeQuery(`SELECT ${i} AS q`))
    );
    const elapsed = Date.now() - startedAt;

    // All six resolve successfully with their own results.
    expect(results).toHaveLength(N);
    results.forEach((result, i) => {
      expect(result.rows).toEqual([[`SELECT ${i} AS q`]]);
    });
    expect(pool.query).toHaveBeenCalledTimes(N);

    // The core regression assertion: all 6 queries were in flight SIMULTANEOUSLY. The old
    // one-shared-client implementation could never exceed 1 here — its single connection slot
    // queued the other five.
    expect(pool.getPeakInFlight()).toBe(N);

    // Wall-clock consequence: ~1x the query duration (parallel), nowhere near the ~6x serial
    // sum (1200ms). The 3x bound leaves generous headroom for slow CI machines while still
    // being far below any serialized execution.
    expect(elapsed).toBeLessThan(QUERY_MS * 3);
  });

  test('with more concurrent queries than pool slots (N=5, max=2), overlap is capped at max and the rest queue: wall time ~ ceil(N/max) rounds, still far below serial', async () => {
    const QUERY_MS = 100;
    const N = 5;
    const MAX = 2;
    const pool = makeSlottedPool(MAX, QUERY_MS);
    __setTestConnectionState({ pool: pool as any });

    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => executeQuery(`SELECT ${i} AS q`))
    );
    const elapsed = Date.now() - startedAt;

    expect(results).toHaveLength(N);
    // Parallelism saturates the pool's slots — never exceeds them, but fully uses them.
    expect(pool.getPeakInFlight()).toBe(MAX);
    // ceil(5/2) = 3 rounds of ~100ms each. Serial would be ~500ms; assert we beat it with margin.
    expect(elapsed).toBeLessThan(QUERY_MS * 4.5);
  });
});
