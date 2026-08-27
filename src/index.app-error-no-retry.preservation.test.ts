/**
 * Preservation property test — application-level errors are never retried.
 *
 * Property 6: Preservation - Application-Level Errors Bypass Retry, Single Attempt
 *
 * This test encodes behavior that must hold both before and after fixes/refactors of
 * `executeQuery()`, per design.md's Correctness Property 6:
 *
 *   "For any input that is an application-level error (Zod validation failure, or a pg SQL
 *    syntax/constraint error), the system SHALL make exactly ONE execution attempt (no
 *    reconnect-and-retry) and SHALL surface the same formatted error text as the original system."
 *
 * Updated for the per-query pool checkout refactor (concurrent executeQuery support): queries now
 * run via `pool.query()` (per-query checkout) instead of a single shared cached client. The
 * preserved property is identical — an application-level error must result in exactly one
 * `pool.query()` attempt, no retry, no pool discard/drain, and the error object propagating
 * completely unchanged to the handler's formatting path.
 *
 * Two related but distinct scenarios are covered, per the task's own guidance, because the
 * `ZodError` formatting ("Validation Error: ...") happens in the `CallToolRequestSchema` handler's
 * catch block (a `switch` inside `server.setRequestHandler(CallToolRequestSchema, ...)`), NOT
 * inside `executeQuery()` itself — `executeQuery()` only ever receives a raw SQL string and never
 * throws a `ZodError` on its own. The request handler registered via `server.setRequestHandler(...)`
 * is not exported/callable directly (only the underlying `Server` instance is constructed and
 * wired to stdio transport in `main()`), so:
 *
 *   1. The ZodError/validation portion is tested by calling `RunQueryInputSchema.parse(...)`
 *      directly on generated invalid inputs (mirroring exactly how the `run_query` case in the
 *      handler invokes it BEFORE ever calling `executeQuery()`), asserting it throws a `ZodError`,
 *      that the handler's documented issue-formatting logic (replicated verbatim below from the
 *      `catch` block in `src/index.ts`) produces `"Validation Error: ..."` text, and that zero
 *      `pool.query()` calls ever occur as a result (since `executeQuery()` is never reached at
 *      all when validation fails first).
 *
 *   2. The pg syntax/constraint-error portion is tested by mocking `pool.query()` to reject with a
 *      `pg`-shaped error (`code` `'42601'` syntax error or `'23505'` unique-constraint violation,
 *      with a message that does NOT match any connection-level phrase/code), calling
 *      `executeQuery()` directly, and asserting `pool.query()` was called exactly once and the
 *      original error propagates completely unchanged (no retry, no pool discard) — matching the
 *      handler's generic `catch` branch, which would format it as `"Error: ${message}"`.
 *
 * `pg.Pool` is mocked so no real database is ever contacted. `executeQuery()`,
 * `__setTestConnectionState()`, and `__getTestConnectionState()` are imported directly from
 * `./index` as a minimal, additive test seam (see the NOTE comments next to their declarations
 * in `src/index.ts`), and `RunQueryInputSchema` is imported directly from
 * `./validation/schemas.js`.
 *
 * **Validates: Requirements 2.8, 3.4**
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { ZodError } from 'zod';

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

import { executeQuery, __setTestConnectionState, __getTestConnectionState } from './index';
import { RunQueryInputSchema } from './validation/schemas.js';

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

/**
 * Replicates VERBATIM the ZodError-formatting logic from the `catch` block of
 * `server.setRequestHandler(CallToolRequestSchema, ...)` in `src/index.ts`:
 *
 *   if (error instanceof ZodError) {
 *     const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
 *     return { ..., text: sanitizeResponseText(`Validation Error: ${issues}`) ..., isError: true };
 *   }
 *
 * `sanitizeResponseText` only strips hidden/control characters from an otherwise plain string, so
 * for the plain-ASCII messages generated here it is the identity function and is intentionally
 * omitted for a direct, dependency-free comparison.
 */
function formatZodErrorAsHandlerWould(error: ZodError): string {
  const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return `Validation Error: ${issues}`;
}

/**
 * Replicates VERBATIM the generic-error-formatting logic from the same `catch` block:
 *
 *   const message = error instanceof Error ? error.message : 'Unknown error';
 *   return { ..., text: sanitizeResponseText(`Error: ${message}`) ..., isError: true };
 */
function formatGenericErrorAsHandlerWould(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return `Error: ${message}`;
}

// ---------------------------------------------------------------------------
// Scenario 1: ZodError-shaped invalid input never reaches executeQuery()/pool.query()
// ---------------------------------------------------------------------------

// Property-generate invalid `run_query` inputs that fail `RunQueryInputSchema`, mirroring the
// validation the `run_query` case performs via `RunQueryInputSchema.parse(args)` BEFORE ever
// calling `executeQuery()`.
const invalidRunQueryInputArb = fc.oneof(
  fc.constant({ sql: '' }), // fails .min(1)
  fc.constant({}), // missing required 'sql' key
  fc.constant({ sql: 'SELECT 1\x00' }), // fails the null-byte .refine()
  fc.integer().map((n) => ({ sql: n })), // wrong type entirely
  fc.constant({ sql: 'x'.repeat(100_001) }) // fails .max(MAX_SQL_LENGTH)
);

describe('Preservation: ZodError-shaped invalid input bypasses executeQuery() with a single validation attempt (Property 6)', () => {
  test('RunQueryInputSchema.parse() throws ZodError for invalid input, formats as "Validation Error: ..." text, and executeQuery()/pool.query() is never invoked (0 attempts)', async () => {
    await fc.assert(
      fc.property(invalidRunQueryInputArb, (invalidInput) => {
        // Fresh pool for each example; if executeQuery() were ever (incorrectly) reached, this
        // would let us detect it via call count below.
        const mockPool = {
          query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [] }),
          end: vi.fn(async () => undefined),
          on: vi.fn(),
        };
        __setTestConnectionState({ pool: mockPool as any });

        let thrown: unknown;
        try {
          RunQueryInputSchema.parse(invalidInput);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(ZodError);
        const formatted = formatZodErrorAsHandlerWould(thrown as ZodError);
        expect(formatted.startsWith('Validation Error: ')).toBe(true);

        // Validation fails before executeQuery()/pool.query() is ever reached: exactly one
        // "attempt" occurs overall (the validation call itself), and zero query executions.
        expect(mockPool.query).not.toHaveBeenCalled();
      }),
      { numRuns: 25 }
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: pg syntax/constraint (application-level) errors propagate with exactly one attempt
// ---------------------------------------------------------------------------

// Property-generate `pg`-shaped application-level error codes (SQLSTATE) and messages that do
// NOT match any connection-level phrase/code from design.md's `isConnectionLevelError`
// vocabulary (`ECONNRESET`/`ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`, "Connection terminated",
// "terminated unexpectedly", "Client has encountered a connection error", "Cannot use a pool
// after calling end").
const appErrorCodeArb = fc.constantFrom('42601', '23505');
const appErrorMessageArb = fc.constantFrom(
  'syntax error at or near "SELET"',
  'column "nonexistent_col" does not exist',
  'duplicate key value violates unique constraint "users_pkey"',
  'null value in column "id" violates not-null constraint'
);
const appErrorArb = fc
  .record({ code: appErrorCodeArb, message: appErrorMessageArb })
  .map(({ code, message }) => Object.assign(new Error(message), { code }));

// The SQL text used for the "real" query under test in this scenario, deliberately distinct from
// `'SELECT 1'` (the eager pool-validation text used internally by `createPool()`) so the mock
// below can succeed the validation query while still rejecting the actual query being tested —
// mirroring the same `REAL_QUERY_SQL` split used in
// `index.mid-query-retry.exploration.test.ts`.
const REAL_QUERY_SQL = 'SELECT * FROM nonexistent';

/** A mocked pool whose `query('SELECT 1')` (eager creation-time validation) ALWAYS succeeds, and
 * whose `query(REAL_QUERY_SQL)` always rejects with `rejectError` — so pool validation never
 * interferes with the exactly-one-attempt assertion this test makes about the actual
 * application-level (syntax/constraint) error path. */
function makeAppErrorPool(rejectError: unknown) {
  const query = vi.fn(async (sql: string, ..._rest: unknown[]) => {
    if (sql === 'SELECT 1') {
      return { rows: [], rowCount: 0, fields: [] };
    }
    throw rejectError;
  });
  return { query, end: vi.fn(async () => undefined), on: vi.fn() };
}

describe('Preservation: pg syntax/constraint errors propagate through executeQuery() with exactly one attempt (Property 6)', () => {
  test('executeQuery() makes exactly one pool.query() attempt and rethrows the original pg error unchanged for random syntax/constraint errors', async () => {
    await fc.assert(
      fc.asyncProperty(appErrorArb, async (generatedError) => {
        const mockPool = makeAppErrorPool(generatedError);
        __setTestConnectionState({ pool: mockPool as any });

        let thrown: unknown;
        try {
          await executeQuery(REAL_QUERY_SQL);
        } catch (error) {
          thrown = error;
        }

        // Exactly one execution attempt of the REAL query under test: no reconnect, no retry.
        const realQueryCalls = mockPool.query.mock.calls.filter(([sql]) => sql === REAL_QUERY_SQL);
        expect(realQueryCalls.length).toBe(1);

        // The original error propagates completely unchanged (same instance, same code/message).
        expect(thrown).toBe(generatedError);

        // No discard/drain occurred: the same pool remains the module's active pool, and its
        // `end()` was never called as part of a retry-discard path.
        expect(__getTestConnectionState().pool).toBe(mockPool);
        expect(mockPool.end).not.toHaveBeenCalled();

        // Matches the handler's generic catch-branch formatting exactly.
        const formatted = formatGenericErrorAsHandlerWould(thrown);
        expect(formatted).toBe(`Error: ${(generatedError as Error).message}`);
      }),
      { numRuns: 25 }
    );
  });
});
