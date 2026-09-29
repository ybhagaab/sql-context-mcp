/**
 * Connection-level classification and retry gating for connect failures (1.5.1): refused,
 * unroutable and unresolvable connects are not retried, a connect timeout gets one more try, and
 * untagged connection errors keep the three attempts of the reliability contract.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pg', async () => (await import('../test/fake-pg')).fakePgModule);

import { isConnectionLevelError, withConnectionRetry, MAX_QUERY_ATTEMPTS, CONNECT_TIMEOUT_ATTEMPTS } from './pool';
import { annotate, contextOf } from '../errors/context';
import { setupFakeDb, teardown } from '../test/harness';

beforeEach(() => {
  setupFakeDb();
});

afterEach(async () => {
  await teardown();
});

describe('isConnectionLevelError additions', () => {
  test("pg's connect timeout counts, a database error with the same text would not", () => {
    expect(isConnectionLevelError(new Error('timeout expired'))).toBe(true);
    expect(isConnectionLevelError(Object.assign(new Error('timeout expired'), { code: '57014' }))).toBe(false);
  });

  test.each(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL'])('%s counts', (code) => {
    expect(isConnectionLevelError(Object.assign(new Error(`connect ${code} 10.0.0.1:5439`), { code }))).toBe(true);
  });
});

describe('retry gating', () => {
  const connectError = (code: string) =>
    annotate(Object.assign(new Error(`connect ${code} 10.0.0.1:5439`), { code }), { phase: 'connect' });

  test.each(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'])('a connect failure with %s is not retried', async (code) => {
    let calls = 0;
    const err = connectError(code);
    await expect(withConnectionRetry(async () => { calls++; throw err; })).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(contextOf(err).attempts).toBe(1);
  });

  test('a connect timeout is tried twice', async () => {
    let calls = 0;
    const err = annotate(new Error('timeout expired'), { phase: 'connect' });
    await expect(withConnectionRetry(async () => { calls++; throw err; })).rejects.toBe(err);
    expect(calls).toBe(CONNECT_TIMEOUT_ATTEMPTS);
    expect(contextOf(err)).toMatchObject({ attempts: 2 });
    expect(contextOf(err).elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test('an untagged connection error keeps the three attempts', async () => {
    let calls = 0;
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5439'), { code: 'ECONNREFUSED' });
    await expect(withConnectionRetry(async () => { calls++; throw err; })).rejects.toBe(err);
    expect(calls).toBe(MAX_QUERY_ATTEMPTS);
  });

  test('a lost connection during a query keeps the three attempts', async () => {
    let calls = 0;
    const err = annotate(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }), { phase: 'query' });
    await expect(withConnectionRetry(async () => { calls++; throw err; })).rejects.toBe(err);
    expect(calls).toBe(MAX_QUERY_ATTEMPTS);
  });

  test('application errors are thrown after one attempt, unchanged', async () => {
    let calls = 0;
    const err = Object.assign(new Error('syntax error at or near "SELET"'), { code: '42601' });
    await expect(withConnectionRetry(async () => { calls++; throw err; })).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(contextOf(err).attempts).toBe(1);
  });
});
