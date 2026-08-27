/**
 * Unit tests — `isConnectionLevelError(error)` classifier.
 *
 * Task 13.1 of the mcp-server-connection-reliability bugfix spec. Direct example-based
 * assertions covering each connection-level error `code`, each connection-level message phrase,
 * a `ZodError` instance, and a `pg`-shaped application-level error (matching the shapes used by
 * `index.mid-query-retry.exploration.test.ts` and `index.app-error-no-retry.preservation.test.ts`).
 *
 * **Validates: Requirements 2.6, 2.8**
 */
import { describe, test, expect } from 'vitest';
import { ZodError, z } from 'zod';
import { isConnectionLevelError } from './index';

describe('isConnectionLevelError()', () => {
  test.each(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'])(
    'returns true for a connection-level error code: %s',
    (code) => {
      const error = Object.assign(new Error('some socket fault'), { code });
      expect(isConnectionLevelError(error)).toBe(true);
    }
  );

  test.each([
    'Connection terminated unexpectedly',
    'Connection terminated',
    'terminated unexpectedly',
    'Client has encountered a connection error',
    // Benign race under concurrent queries: a checkout against a pool that a concurrent
    // failure has just discarded/drained. Classified connection-level so the bounded retry
    // transparently picks up the replacement pool.
    'Cannot use a pool after calling end on the pool',
  ])('returns true for a connection-level message phrase: %s', (message) => {
    const error = new Error(message);
    expect(isConnectionLevelError(error)).toBe(true);
  });

  test('returns false for a ZodError instance', () => {
    const schema = z.object({ sql: z.string().min(1) });
    let thrown: unknown;
    try {
      schema.parse({ sql: '' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ZodError);
    expect(isConnectionLevelError(thrown)).toBe(false);
  });

  test('returns false for a pg-shaped application-level error (syntax error, code 42601)', () => {
    const error = Object.assign(new Error('syntax error at or near "SELET"'), { code: '42601' });
    expect(isConnectionLevelError(error)).toBe(false);
  });

  test('returns false for a pg-shaped application-level error (unique constraint violation, code 23505)', () => {
    const error = Object.assign(
      new Error('duplicate key value violates unique constraint "users_pkey"'),
      { code: '23505' }
    );
    expect(isConnectionLevelError(error)).toBe(false);
  });

  test('returns false for a plain string and for undefined/null', () => {
    expect(isConnectionLevelError('some random string')).toBe(false);
    expect(isConnectionLevelError(undefined)).toBe(false);
    expect(isConnectionLevelError(null)).toBe(false);
  });
});
