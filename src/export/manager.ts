/**
 * Export manager (design Component 9): runs export_query jobs.
 *
 * - A first-in, first-out queue with SQL_EXPORT_CONCURRENCY jobs running at once.
 * - Each job streams its query without a cursor (so the database's cursor size limits don't
 *   apply), converts every row exactly and writes it to `<name>.part`. When the file stream needs
 *   to drain, the database socket is paused until it does, so memory stays bounded however slow
 *   the disk is.
 * - There is no row or size limit by default. Optional caps (per call, or SQL_EXPORT_MAX_ROWS and
 *   SQL_EXPORT_MAX_BYTES) stop the export and mark it truncated. The free-space reserve stops it
 *   before the disk fills.
 * - On success the file is renamed to its final name, next to a `<file>.schema.json` sidecar. On
 *   failure or cancellation the query is cancelled, the connection is discarded and the `.part`
 *   file is deleted.
 */
import * as fs from 'fs';
import { createHash } from 'crypto';
import type { ServerConfig } from '../config';
import { FileStore, FreeSpaceGuard, randomBase32, writePrivateFile, StatFs } from '../files/store';
import { planScript, EmptySqlError } from '../sql/classify';
import { withConnectionRetry, isConnectionLevelError } from '../db/pool';
import { Lease, QueryCancelledError, GuardOptions } from '../db/lease';
import { streamQuery, RowPump, StreamField, StreamStatementResult } from '../db/stream';
import { resolveColumnTypes, typeLookupOn } from '../db/engine';
import { ColumnInfo, columnsFromFields, toExact, ExactValue } from '../results/values';
import { ExportFormat, FileRowWriter, RowWriter } from './writers';
import { newSqlProgress, markSending, statementRef, wholeRef, annotateSqlError, summarizeStatement } from '../runner';
import { describeError, errorText } from '../errors/describe';

export type ExportState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ExportRequest {
  sql: string;
  format: ExportFormat;
  fileName?: string;
  /** Per-call caps; the operator's caps (if any) still apply when lower. */
  maxRows?: number;
  maxBytes?: number;
  /** Per-statement timeout; 0 disables it. Defaults to SQL_STATEMENT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ExportPaths {
  finalPath: string;
  partPath: string;
  schemaPath: string;
}

export interface ExportManagerOptions {
  statfs?: StatFs | null;
  /** Test seam: how often (in bytes written) the free-space reserve is checked (default 64 MB). */
  freeSpaceCheckEveryBytes?: number;
  /** Test seam: replaces the file writer. */
  openWriter?: (file: string, format: ExportFormat) => Promise<RowWriter>;
  /** Rows queued before the database socket is paused (default 1,000). */
  highWater?: number;
}

const PREVIEW_ROWS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

function minCap(a: number | undefined | null, b: number | null): number | null {
  if (a === undefined || a === null) return b;
  return b === null ? a : Math.min(a, b);
}

export class ExportJob {
  state: ExportState = 'queued';
  rowsWritten = 0;
  bytesWritten = 0;
  truncated = false;
  columns: ColumnInfo[] = [];
  /** First rows, raw (converted when shown). */
  preview: unknown[][] = [];
  readonly queuedAt = Date.now();
  startedAt: number | null = null;
  finishedAt: number | null = null;
  /** Why the job failed or was cancelled (the tool error text without its "Error: " prefix). */
  error: string | null = null;
  /** The error type of a failed job (see the README's error types), when known. */
  errorType: string | null = null;
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private settleDone: () => void = () => undefined;

  constructor(readonly id: string, readonly request: ExportRequest, readonly paths: ExportPaths) {
    this.done = new Promise((resolve) => {
      this.settleDone = resolve;
    });
  }

  get format(): ExportFormat {
    return this.request.format;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isFinished(): boolean {
    return this.state === 'done' || this.state === 'failed' || this.state === 'cancelled';
  }

  _abort(): void {
    this.controller.abort();
  }

  _settle(): void {
    this.settleDone();
  }

  /** Exact values of the preview rows. */
  previewValues(): ExactValue[][] {
    return this.preview.map((row) => this.columns.map((c, i) => toExact(row[i], c.oid)));
  }
}

export class ExportManager {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly queue: ExportJob[] = [];
  private running = 0;
  private closing = false;
  /** Largest number of rows any export queued in memory at once (memory-bound tests). */
  peakQueuedRows = 0;

  constructor(
    private readonly files: FileStore,
    private readonly config: ServerConfig,
    private readonly opts: ExportManagerOptions = {},
  ) {}

  get runningCount(): number {
    return this.running;
  }

  get(id: string): ExportJob | undefined {
    return this.jobs.get(id);
  }

  list(): ExportJob[] {
    return [...this.jobs.values()];
  }

  /** 1-based position in the queue, or null when the job isn't queued. */
  queuePosition(job: ExportJob): number | null {
    const index = this.queue.indexOf(job);
    return index === -1 ? null : index + 1;
  }

  async submit(request: ExportRequest): Promise<ExportJob> {
    if (this.closing) throw new Error('The server is shutting down; the export was not started.');
    const plan = planScript(request.sql);
    if (plan.complete && plan.statements.length === 0) throw new EmptySqlError();
    await this.files.ensureDirs();
    const paths = this.files.newExportPaths(request.fileName, request.format);
    let id: string;
    do id = `e_${randomBase32(16)}`;
    while (this.jobs.has(id));
    const job = new ExportJob(id, request, paths);
    this.jobs.set(id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  /** Cancels a queued or running job and waits (briefly) for it to finish. */
  async cancel(job: ExportJob): Promise<void> {
    if (job.isFinished) return;
    const index = this.queue.indexOf(job);
    if (index !== -1) {
      this.queue.splice(index, 1);
      job.state = 'cancelled';
      job.error = 'The export was cancelled before it started.';
      job.finishedAt = Date.now();
      job._settle();
      return;
    }
    job._abort();
    await Promise.race([job.done, sleep(10_000)]);
  }

  /** Waits for `job` to finish. Aborting `signal` cancels the job. */
  async wait(job: ExportJob, signal?: AbortSignal): Promise<void> {
    if (!signal) return job.done;
    if (signal.aborted) {
      await this.cancel(job);
      return;
    }
    const onAbort = (): void => {
      void this.cancel(job);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await job.done;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Server shutdown: cancels every queued and running job. */
  async closeAll(): Promise<void> {
    this.closing = true;
    const open = [...this.jobs.values()].filter((j) => !j.isFinished);
    await Promise.allSettled(open.map((j) => this.cancel(j)));
  }

  private pump(): void {
    while (!this.closing && this.running < this.config.exportConcurrency && this.queue.length > 0) {
      const job = this.queue.shift() as ExportJob;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: ExportJob): Promise<void> {
    job.state = 'running';
    job.startedAt = Date.now();
    const holder: { writer: RowWriter | null } = { writer: null };
    try {
      if (job.signal.aborted) throw new QueryCancelledError();
      const guard = new FreeSpaceGuard(this.files.exportsDir, this.config.exportMinFreeBytes, {
        statfs: this.opts.statfs,
        checkEveryBytes: this.opts.freeSpaceCheckEveryBytes,
      });
      await guard.check();
      await this.execute(job, guard, holder);
      const writer = holder.writer as RowWriter | null;
      if (!writer) throw new Error('The export produced no file.');
      await writer.finish();
      holder.writer = null;
      job.bytesWritten = writer.bytes;
      await writePrivateFile(job.paths.schemaPath, `${JSON.stringify(this.sidecar(job), null, 2)}\n`);
      await fs.promises.rename(job.paths.partPath, job.paths.finalPath);
      job.state = 'done';
    } catch (err) {
      if (holder.writer) await holder.writer.destroy().catch(() => undefined);
      await fs.promises.rm(job.paths.partPath, { force: true }).catch(() => undefined);
      await fs.promises.rm(job.paths.schemaPath, { force: true }).catch(() => undefined);
      const cancelled = job.signal.aborted || err instanceof QueryCancelledError;
      if (cancelled) {
        job.error = 'The export was cancelled.';
      } else {
        const rendered = await describeError(err).catch(() => ({ type: null, text: `Error: ${errorText(err)}` }));
        job.error = rendered.text.replace(/^Error: /, '');
        job.errorType = rendered.type;
      }
      job.state = cancelled ? 'cancelled' : 'failed';
    } finally {
      job.finishedAt = Date.now();
      job._settle();
    }
  }

  private sidecar(job: ExportJob): Record<string, unknown> {
    return {
      columns: job.columns.map((c) => ({ name: c.name, type: c.type, oid: c.oid })),
      rowCount: job.rowsWritten,
      bytes: job.bytesWritten,
      format: job.format,
      truncated: job.truncated,
      createdAt: new Date().toISOString(),
      sqlSha256: createHash('sha256').update(job.request.sql).digest('hex'),
    };
  }

  private async execute(job: ExportJob, guard: FreeSpaceGuard, holder: { writer: RowWriter | null }): Promise<void> {
    const plan = planScript(job.request.sql);
    const whole = !plan.complete || plan.hasTransactionControl;
    const state = newSqlProgress();
    const maxRows = minCap(job.request.maxRows, this.config.exportMaxRows);
    const maxBytes = minCap(job.request.maxBytes, this.config.exportMaxBytes);
    const timeoutMs = job.request.timeoutMs ?? this.config.statementTimeoutMs;
    const guardOpts: GuardOptions = { signal: job.signal, timeoutMs: timeoutMs > 0 ? timeoutMs : undefined };
    const openWriter = this.opts.openWriter ?? ((file: string, format: ExportFormat) => FileRowWriter.open(file, format));

    try {
      await this.executeAttempts(job, guard, holder, plan, whole, state, { maxRows, maxBytes, guardOpts, openWriter });
    } catch (err) {
      throw annotateSqlError(err, job.request.sql, plan, state, 'export_query');
    }
  }

  private async executeAttempts(
    job: ExportJob,
    guard: FreeSpaceGuard,
    holder: { writer: RowWriter | null },
    plan: ReturnType<typeof planScript>,
    whole: boolean,
    state: ReturnType<typeof newSqlProgress>,
    limits: {
      maxRows: number | null;
      maxBytes: number | null;
      guardOpts: GuardOptions;
      openWriter: (file: string, format: ExportFormat) => Promise<RowWriter>;
    },
  ): Promise<void> {
    const { maxRows, maxBytes, guardOpts, openWriter } = limits;
    await withConnectionRetry(
      async (pool) => {
        // A retry starts the file again.
        if (holder.writer) {
          await holder.writer.destroy();
          holder.writer = null;
        }
        job.rowsWritten = 0;
        job.bytesWritten = 0;
        job.preview = [];
        job.truncated = false;
        job.columns = [];
        state.sentThisAttempt = false;
        state.completed = [];
        state.current = null;
        const lease = await Lease.acquire(pool, { signal: job.signal });
        try {
          if (plan.changesSession) lease.markDiscard();
          let text = job.request.sql;
          if (!whole) {
            for (const [i, statement] of plan.prefix.entries()) {
              let rows = 0;
              markSending(state, statementRef(statement, i + 1));
              const outcome = await streamQuery(lease, statement.text, { onRow: () => { rows++; } }, guardOpts);
              state.noRetry = true;
              for (const r of outcome.results) state.completed.push(summarizeStatement(r, r.streamedIndex === null ? 0 : rows));
            }
            text = (plan.last as NonNullable<typeof plan.last>).text;
          } else if (plan.isScript) {
            state.noRetry = true;
          }
          const ref = whole ? wholeRef(job.request.sql) : statementRef(plan.last as NonNullable<typeof plan.last>, plan.statements.length);

          holder.writer = await openWriter(job.paths.partPath, job.format);
          const fieldsByIndex = new Map<number, StreamField[]>();
          let currentIndex = -1;
          let stopped = false;

          const start = (columns: ColumnInfo[]): void => {
            job.columns = columns;
            (holder.writer as RowWriter).begin(columns);
            job.bytesWritten = (holder.writer as RowWriter).bytes;
          };
          // A later result set replaces an earlier one (transaction-control scripts): start the file again.
          const restart = async (columns: ColumnInfo[]): Promise<void> => {
            if (holder.writer) await holder.writer.destroy();
            holder.writer = null;
            holder.writer = await openWriter(job.paths.partPath, job.format);
            job.rowsWritten = 0;
            job.preview = [];
            job.truncated = false;
            start(columns);
          };
          const stop = (): void => {
            if (stopped) return;
            stopped = true;
            job.truncated = true;
            lease.markDiscard();
            void lease.cancel();
          };
          const write = (row: unknown[]): void | Promise<void> => {
            const writer = holder.writer as RowWriter;
            if (maxRows !== null && job.rowsWritten >= maxRows) return stop();
            const line = writer.encode(row);
            if (maxBytes !== null && writer.bytes + Buffer.byteLength(line) > maxBytes) return stop();
            const ok = writer.writeLine(line);
            job.rowsWritten++;
            job.bytesWritten = writer.bytes;
            if (job.preview.length < PREVIEW_ROWS) job.preview.push(row);
            if (!ok) {
              return writer.drain().then(() => (guard.isDue(writer.bytes) ? guard.maybeCheck(writer.bytes) : undefined));
            }
            if (guard.isDue(writer.bytes)) return guard.maybeCheck(writer.bytes);
            return undefined;
          };

          const pump = new RowPump(
            (row, index) => {
              if (stopped) return undefined;
              if (index !== currentIndex) {
                const first = currentIndex === -1;
                currentIndex = index;
                const columns = columnsFromFields(fieldsByIndex.get(index) ?? []);
                if (first) {
                  start(columns);
                  return write(row);
                }
                return restart(columns).then(() => write(row));
              }
              return write(row);
            },
            { highWater: this.opts.highWater ?? 1_000, onError: () => void lease.cancel() },
          );

          let results: StreamStatementResult[] | null = null;
          markSending(state, ref);
          try {
            const outcome = await streamQuery(
              lease,
              text,
              {
                onResultSet: (fields, index) => { fieldsByIndex.set(index, fields); },
                onRow: (row, index, control) => {
                  state.noRetry = true;
                  pump.push(row, index, control);
                },
              },
              guardOpts,
            );
            results = outcome.results;
            await pump.flush();
          } catch (err) {
            await pump.flush().catch(() => undefined);
            if (pump.hasFailed) throw pump.error;
            // Stopped at a cap: the cancellation that follows is expected.
            if (!stopped || job.signal.aborted) throw err;
          } finally {
            this.peakQueuedRows = Math.max(this.peakQueuedRows, pump.peakQueued);
          }

          if (!stopped && results) {
            // The export is the last result set that has columns.
            let shown: StreamStatementResult | null = null;
            for (let i = results.length - 1; i >= 0; i--) {
              if (results[i].fields.length > 0) {
                shown = results[i];
                break;
              }
            }
            if (!shown) {
              throw new Error('The SQL returned no rows to export: export_query writes the result of the last statement that returns rows.');
            }
            if (currentIndex === -1) start(columnsFromFields(shown.fields));
            else if (shown.streamedIndex !== currentIndex) await restart(columnsFromFields(shown.fields));
          }
          await resolveColumnTypes(typeLookupOn(lease), job.columns).catch(() => undefined);
        } catch (err) {
          if (isConnectionLevelError(err)) lease.markDiscard();
          throw err;
        } finally {
          lease.release();
        }
      },
      { canRetry: () => !state.noRetry && job.rowsWritten === 0 },
    );
  }
}

/** The result of a finished export, as shown to callers. `clean` sanitizes inline strings. */
export function exportResult(job: ExportJob, clean: (text: string) => string): Record<string, unknown> {
  return {
    exportId: job.id,
    state: job.state,
    path: job.paths.finalPath,
    schemaPath: job.paths.schemaPath,
    format: job.format,
    rowCount: job.rowsWritten,
    bytes: job.bytesWritten,
    truncated: job.truncated,
    durationMs: (job.finishedAt ?? Date.now()) - (job.startedAt ?? job.queuedAt),
    columns: job.columns.map((c) => ({ name: clean(c.name), type: clean(c.type) })),
    preview: job.previewValues().map((row) => row.map((v) => (typeof v === 'string' ? clean(v) : v))),
  };
}

/** Status of any job, as shown by export_status. */
export function exportStatus(job: ExportJob, manager: ExportManager, clean: (text: string) => string): Record<string, unknown> {
  const status: Record<string, unknown> = {
    exportId: job.id,
    state: job.state,
    rowsWritten: job.rowsWritten,
    bytesWritten: job.bytesWritten,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.queuedAt,
  };
  if (job.state === 'queued') status.queuePosition = manager.queuePosition(job);
  if (job.state === 'done') Object.assign(status, exportResult(job, clean));
  if (job.state === 'failed' || job.state === 'cancelled') status.error = job.error;
  if (job.state === 'failed' && job.errorType) status.errorType = job.errorType;
  return status;
}

/** Progress for a job, for MCP progress notifications. */
export function exportProgress(job: ExportJob, manager: ExportManager): { message: string; rows?: number; bytes?: number } {
  if (job.state === 'queued') return { message: `waiting in the export queue (position ${manager.queuePosition(job) ?? 1})` };
  if (job.rowsWritten === 0) return { message: 'query running on the database' };
  return { message: 'exporting', rows: job.rowsWritten, bytes: job.bytesWritten };
}
