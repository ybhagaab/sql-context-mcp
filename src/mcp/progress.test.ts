/**
 * Progress notifications (design Component 11).
 *
 * Validates: Requirement 6.3
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { ProgressReporter } from './progress';

afterEach(() => vi.useRealTimers());

function fakeExtra(token?: string | number) {
  const sent: any[] = [];
  return {
    sent,
    extra: {
      _meta: token === undefined ? undefined : { progressToken: token },
      sendNotification: async (n: any) => { sent.push(n); },
    },
  };
}

describe('ProgressReporter', () => {
  test('is only created when the client supplied a progressToken', () => {
    expect(ProgressReporter.fromExtra(fakeExtra().extra as never, 30_000)).toBeNull();
    expect(ProgressReporter.fromExtra(fakeExtra('t1').extra as never, 30_000)).toBeInstanceOf(ProgressReporter);
  });

  test('sends a notification every interval with increasing progress and the current phase', async () => {
    vi.useFakeTimers();
    const { sent, extra } = fakeExtra('tok');
    const reporter = ProgressReporter.fromExtra(extra as never, 1_000) as ProgressReporter;
    reporter.phase('waiting for a database connection');
    reporter.start();
    await vi.advanceTimersByTimeAsync(1_000);
    reporter.phase('query running on the database');
    await vi.advanceTimersByTimeAsync(3_000);
    reporter.phase('exporting');
    reporter.setRows(3_200_000);
    await vi.advanceTimersByTimeAsync(1_000);
    reporter.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent).toHaveLength(5);
    expect(sent.every((n) => n.method === 'notifications/progress' && n.params.progressToken === 'tok')).toBe(true);
    const values = sent.map((n) => n.params.progress);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(sent[0].params.message).toMatch(/^waiting for a database connection \(\d+s\)$/);
    expect(sent[1].params.message).toMatch(/^query running on the database \(\d+s\)$/);
    expect(sent[4].params.message).toBe('exporting (3,200,000 rows)');
  });

  test('elapsed time is shown in minutes and seconds for long phases', async () => {
    vi.useFakeTimers();
    const { sent, extra } = fakeExtra(7);
    const reporter = ProgressReporter.fromExtra(extra as never, 30_000) as ProgressReporter;
    reporter.phase('query running on the database');
    reporter.start();
    await vi.advanceTimersByTimeAsync(750_000);
    reporter.stop();
    expect(sent[sent.length - 1].params.message).toBe('query running on the database (12m 30s)');
  });

  test('notification failures never throw', async () => {
    vi.useFakeTimers();
    const reporter = ProgressReporter.fromExtra({ _meta: { progressToken: 1 }, sendNotification: async () => { throw new Error('closed'); } } as never, 1_000) as ProgressReporter;
    reporter.phase('x');
    reporter.start();
    await vi.advanceTimersByTimeAsync(3_000);
    reporter.stop();
  });
});
