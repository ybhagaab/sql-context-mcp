/**
 * Streaming executor (design Component 5b).
 *
 * Runs SQL text (one statement or a script) with pg's `Query` in row-event mode: submitted with a
 * `row` listener and no callback, pg does not collect rows, so memory stays bounded whatever the
 * result size. Rows are delivered as raw wire text in arrays. Consumers apply backpressure by
 * pausing the database socket (TCP flow control then slows the server) and resuming it later.
 *
 * No cursor is used, so the database's cursor size limits don't apply (this is why exports use
 * this executor).
 */
import { Query } from 'pg';
import type { Lease, GuardOptions } from './lease';
import { RAW_TYPES } from '../results/values';

export interface StreamField { name: string; dataTypeID: number }

export interface StreamControl {
  pause(): void;
  resume(): void;
}

export interface StreamHandlers {
  /** Called when the first row of a new result set arrives. */
  onResultSet?(fields: StreamField[], index: number): void;
  /** Called for every row; `index` identifies the result set (0-based, among sets with rows). */
  onRow(row: unknown[], index: number, control: StreamControl): void;
}

export interface StreamStatementResult {
  command: string;
  rowCount: number | null;
  fields: StreamField[];
  /** Index passed to onRow for this statement's rows, or null if it produced no rows. */
  streamedIndex: number | null;
}

export interface StreamOutcome {
  results: StreamStatementResult[];
}

/**
 * Processes streamed rows in order, with bounded memory.
 *
 * Processing may return a promise (for example while a file drains or a spool write completes).
 * Rows that arrive meanwhile are queued; once `highWater` rows are queued the database socket is
 * paused, and it resumes when the queue has been worked down. TCP flow control then slows the
 * database side, so rows never pile up in memory.
 *
 * A processing error stops the pump: later rows are dropped, `onError` is called once (callers use
 * it to cancel the query), and `flush()` rejects with that error.
 */
export class RowPump {
  private queue: Array<{ row: unknown[]; index: number }> = [];
  private head = 0;
  private running = false;
  private paused = false;
  private control: StreamControl | null = null;
  private failed = false;
  private failure: unknown = null;
  private waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private readonly highWater: number;
  /** Largest number of rows queued at once (used by memory-bound tests). */
  peakQueued = 0;

  constructor(
    private readonly processRow: (row: unknown[], index: number) => void | Promise<void>,
    private readonly opts: { highWater?: number; onError?: (err: unknown) => void } = {},
  ) {
    this.highWater = Math.max(1, opts.highWater ?? 1_000);
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  get error(): unknown {
    return this.failed ? this.failure : null;
  }

  push(row: unknown[], index: number, control: StreamControl): void {
    if (this.failed) return;
    this.control = control;
    this.queue.push({ row, index });
    const queued = this.queue.length - this.head;
    if (queued > this.peakQueued) this.peakQueued = queued;
    if (!this.paused && queued >= this.highWater) {
      this.paused = true;
      control.pause();
    }
    if (!this.running) this.run();
  }

  /** Resolves once every pushed row has been processed; rejects with the processing error. */
  flush(): Promise<void> {
    if (this.failed) return Promise.reject(this.failure);
    if (!this.running && this.head >= this.queue.length) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private run(): void {
    this.running = true;
    const step = (): void => {
      try {
        while (this.head < this.queue.length) {
          const item = this.queue[this.head++];
          if (this.head > 4096 && this.head * 2 > this.queue.length) {
            this.queue = this.queue.slice(this.head);
            this.head = 0;
          }
          const result = this.processRow(item.row, item.index);
          if (result && typeof (result as Promise<void>).then === 'function') {
            (result as Promise<void>).then(
              () => {
                this.maybeResume(false);
                step();
              },
              (err) => this.fail(err),
            );
            return;
          }
        }
      } catch (err) {
        this.fail(err);
        return;
      }
      this.queue = [];
      this.head = 0;
      this.running = false;
      this.maybeResume(true);
      this.settle();
    };
    step();
  }

  private maybeResume(idle: boolean): void {
    if (!this.paused || !this.control) return;
    if (idle || this.queue.length - this.head < this.highWater / 2) {
      this.paused = false;
      this.control.resume();
    }
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = err;
    this.queue = [];
    this.head = 0;
    this.running = false;
    // Let the stream reach its end or its cancellation error.
    this.maybeResume(true);
    try {
      this.opts.onError?.(err);
    } catch {
      // ignore
    }
    this.settle();
  }

  private settle(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (this.failed) w.reject(this.failure);
      else w.resolve();
    }
  }
}

function fieldsOf(result: unknown): StreamField[] {
  const fields = (result as { fields?: Array<{ name: string; dataTypeID: number }> } | null)?.fields ?? [];
  return fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
}

export function streamQuery(lease: Lease, text: string, handlers: StreamHandlers, opts: GuardOptions = {}): Promise<StreamOutcome> {
  const control: StreamControl = {
    pause: () => lease.pauseSocket(),
    resume: () => lease.resumeSocket(),
  };
  return lease.guard(
    () =>
      new Promise<StreamOutcome>((resolve, reject) => {
        const query = new Query({ text, rowMode: 'array', types: RAW_TYPES } as never) as unknown as NodeJS.EventEmitter;
        const indexOf = new Map<unknown, number>();
        let current: unknown = null;
        let nextIndex = 0;
        query.on('row', (row: unknown[], result: unknown) => {
          if (result !== current) {
            current = result;
            const index = nextIndex++;
            indexOf.set(result, index);
            handlers.onResultSet?.(fieldsOf(result), index);
          }
          handlers.onRow(row, indexOf.get(result) as number, control);
        });
        query.on('end', (res: unknown) => {
          const list = Array.isArray(res) ? res : [res];
          resolve({
            results: list.map((r) => ({
              command: String((r as { command?: unknown } | null)?.command ?? ''),
              rowCount: typeof (r as { rowCount?: unknown } | null)?.rowCount === 'number' ? ((r as { rowCount: number }).rowCount) : null,
              fields: fieldsOf(r),
              streamedIndex: indexOf.has(r) ? (indexOf.get(r) as number) : null,
            })),
          });
        });
        query.on('error', (err: unknown) => {
          lease.resumeSocket();
          reject(err);
        });
        (lease.client as unknown as { query: (q: unknown) => unknown }).query(query);
      }),
    opts,
  );
}
