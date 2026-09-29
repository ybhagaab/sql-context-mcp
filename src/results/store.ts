/**
 * Result store (design Component 8): result sessions that let fetch_rows continue a result
 * without re-running its query.
 *
 * Two modes:
 * - Spooled. The rows are written to `spool/<resultId>.jsonl`, one JSON array of raw wire text per
 *   line, with a sparse index of the byte offset of every 1,000th row, so a page can start at any
 *   offset. The connection is released as soon as spooling finishes. Spools share a per-process
 *   budget (SQL_SPOOL_MAX_TOTAL_BYTES); the least recently used spooled results are evicted to
 *   make room.
 * - Open cursor. A result too large to spool keeps its cursor (and connection) open, at most
 *   SQL_MAX_OPEN_CURSORS at once. Pages are read forward only, one call at a time. The cursor
 *   closes when every row has been read, or after SQL_CURSOR_IDLE_TTL_MS without a call. The idle
 *   timer never runs while a page is being read. An open result is never closed to make room for
 *   another.
 */
import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import { FileStore, FreeSpaceGuard, randomBase32, StatFs } from '../files/store';
import type { ColumnInfo } from './values';
import { PageBuilder, Format, RenderedPage, RowTooLargeError } from './page';
import { Lease, QueryCancelledError, GuardOptions } from '../db/lease';
import type { CursorReader } from '../db/cursor';
import type { ProgressReporter } from '../mcp/progress';
import { formatElapsed } from '../mcp/progress';
import { errorText } from '../errors/describe';
import { annotate } from '../errors/context';

export type SessionMode = 'spooling' | 'spooled' | 'cursor' | 'closed' | 'expired' | 'evicted' | 'failed';

export interface StoreLimits {
  spoolMaxTotalBytes: number;
  maxOpenCursors: number;
  cursorIdleTtlMs: number;
  fetchBatchRows: number;
  /** Free-space reserve for spool files (SQL_EXPORT_MIN_FREE_BYTES); 0 disables the check. */
  minFreeBytes: number;
}

export interface PageRequest {
  format: Format;
  maxRows: number;
  maxChars: number;
  ceiling: number;
  /** Row offset to start from; defaults to the current position. */
  offset?: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
  progress?: ProgressReporter | null;
}

export class ResultUnavailableError extends Error {
  constructor(readonly resultId: string, readonly reason: string) {
    super(`result ${resultId} is no longer available (${reason}). Re-run the query, or use export_query.`);
    this.name = 'ResultUnavailableError';
  }
}

export class ForwardOnlyError extends Error {
  constructor(readonly position: number) {
    super(`this result can only move forward; current position is ${position}`);
    this.name = 'ForwardOnlyError';
  }
}

export class OffsetOutOfRangeError extends Error {
  constructor(readonly offset: number, readonly totalRows: number) {
    super(`offset ${offset} is past the end of the result (${totalRows} rows)`);
    this.name = 'OffsetOutOfRangeError';
  }
}

export class SpoolLimitError extends Error {
  constructor(readonly reason: 'too-large' | 'budget') {
    super(
      reason === 'too-large'
        ? 'the result is too large to page (SQL_SPOOL_THRESHOLD_BYTES)'
        : 'the spool budget (SQL_SPOOL_MAX_TOTAL_BYTES) is full',
    );
    this.name = 'SpoolLimitError';
  }
}

/** A one-line description of an error, never blank. */
const describe = errorText;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Runs async sections one at a time, in call order. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ---------------------------------------------------------------------------------------------
// Spool files
// ---------------------------------------------------------------------------------------------

const INDEX_EVERY = 1_000;
const READ_CHUNK = 256 * 1024;
const NEWLINE = 0x0a;

interface EncodedRows {
  buffer: Buffer;
  rows: number;
  /** Byte offsets, relative to the buffer, of rows whose absolute index is a multiple of 1,000. */
  marks: number[];
}

/**
 * An append-only JSONL file of raw rows with a sparse row index. Appends must not overlap (the
 * owning session serializes them). Reads use positional I/O and see only completed appends.
 */
export class SpoolFile {
  rowsWritten = 0;
  bytes = 0;
  private readonly index: number[] = [0];
  private closed = false;

  private constructor(readonly path: string, private readonly handle: FileHandle) {}

  static async create(file: string): Promise<SpoolFile> {
    const handle = await fs.promises.open(file, 'w+', 0o600);
    try {
      if (process.platform !== 'win32') await handle.chmod(0o600);
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    return new SpoolFile(file, handle);
  }

  encode(rows: unknown[][]): EncodedRows {
    const lines: string[] = new Array(rows.length);
    const marks: number[] = [];
    let offset = 0;
    for (let i = 0; i < rows.length; i++) {
      const line = `${JSON.stringify(rows[i])}\n`;
      const absolute = this.rowsWritten + i;
      if (absolute > 0 && absolute % INDEX_EVERY === 0) marks.push(offset);
      lines[i] = line;
      offset += Buffer.byteLength(line);
    }
    return { buffer: Buffer.from(lines.join(''), 'utf8'), rows: rows.length, marks };
  }

  async write(encoded: EncodedRows): Promise<void> {
    if (this.closed) throw new Error('the spool file is closed');
    let done = 0;
    while (done < encoded.buffer.length) {
      const { bytesWritten } = await this.handle.write(encoded.buffer, done, encoded.buffer.length - done, this.bytes + done);
      if (bytesWritten <= 0) throw new Error('could not write to the spool file');
      done += bytesWritten;
    }
    for (const mark of encoded.marks) this.index.push(this.bytes + mark);
    this.bytes += encoded.buffer.length;
    this.rowsWritten += encoded.rows;
  }

  /** Yields rows from `from` up to the end of the data written so far (including data written while reading). */
  async *read(from: number): AsyncGenerator<unknown[]> {
    if (from >= this.rowsWritten) return;
    const block = Math.floor(from / INDEX_EVERY);
    let rowIndex = block * INDEX_EVERY;
    let position = this.index[block];
    let rest: Buffer | null = null;
    while (position < this.bytes) {
      const length = Math.min(READ_CHUNK, this.bytes - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await this.handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const data: Buffer = rest ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(NEWLINE, start);
        if (newline === -1) break;
        if (rowIndex >= from) yield JSON.parse(data.toString('utf8', start, newline)) as unknown[];
        rowIndex++;
        start = newline + 1;
      }
      rest = start < data.length ? data.subarray(start) : null;
    }
  }

  /** Closes and deletes the file. Idempotent. */
  async destroy(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close().catch(() => undefined);
    }
    await fs.promises.rm(this.path, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/** A result whose rows are (being) written to a spool file. */
export class SpoolSession {
  readonly kind = 'spool' as const;
  mode: SessionMode = 'spooling';
  /** Next row index to serve when fetch_rows has no offset. */
  position = 0;
  lastAccess = Date.now();
  failure: string | null = null;
  totalRows: number | null;
  private readers = 0;
  private accounted: number;
  private fileClosed = false;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly appendLock = new Mutex();

  constructor(
    private readonly store: ResultStore,
    readonly id: string,
    readonly columns: ColumnInfo[],
    totalRows: number | null,
    private readonly spool: SpoolFile,
    private readonly guard: FreeSpaceGuard,
    reserved: number,
    private readonly capBytes: number | null,
  ) {
    this.totalRows = totalRows;
    this.accounted = reserved;
  }

  /** Aborted when the session ends early; producers pass it to their queries. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get rowsWritten(): number {
    return this.spool.rowsWritten;
  }

  get bytes(): number {
    return this.spool.bytes;
  }

  get activeReaders(): number {
    return this.readers;
  }

  /** Bytes this session counts against the spool budget. */
  get accountedBytes(): number {
    return this.accounted;
  }

  /** Appends rows. Enforces the size cap, the spool budget and the free-space reserve. */
  append(rows: unknown[][]): Promise<void> {
    return this.appendLock.run(async () => {
      if (this.mode !== 'spooling') throw new Error(`result ${this.id} is ${this.mode}`);
      if (rows.length === 0) return;
      const encoded = this.spool.encode(rows);
      const after = this.spool.bytes + encoded.buffer.length;
      if (this.capBytes !== null && after > this.capBytes) throw new SpoolLimitError('too-large');
      if (after > this.accounted) {
        const extra = after - this.accounted;
        if (!this.store._reserve(extra, this)) throw new SpoolLimitError('budget');
        this.accounted += extra;
      }
      await this.spool.write(encoded);
      if (this.guard.isDue(this.spool.bytes)) await this.guard.maybeCheck(this.spool.bytes);
      this.notify();
    });
  }

  /** Spooling is complete; the total is now exact. */
  finish(): void {
    if (this.mode !== 'spooling') return;
    this.mode = 'spooled';
    this.totalRows = this.spool.rowsWritten;
    const unused = this.accounted - this.spool.bytes;
    if (unused > 0) {
      this.store._release(unused);
      this.accounted = this.spool.bytes;
    }
    this.notify();
  }

  /** Spooling failed. Pages already returned stay valid; fetch_rows reports the failure. */
  fail(err: unknown): void {
    if (this.mode !== 'spooling' && this.mode !== 'spooled') return;
    this.mode = 'failed';
    this.failure = describe(err);
    this.shutdownFile();
  }

  /** Evicted to make room for newer results. */
  _evict(): void {
    if (this.mode !== 'spooled') return;
    this.mode = 'evicted';
    this.shutdownFile();
  }

  /** Closed by the server (shutdown, or a result the caller never saw). */
  _close(reason: string): void {
    if (this.mode !== 'spooling' && this.mode !== 'spooled') return;
    this.mode = 'closed';
    this.failure = reason;
    this.shutdownFile();
  }

  assertReadable(): void {
    switch (this.mode) {
      case 'failed':
        throw new ResultUnavailableError(this.id, `spooling it failed: ${this.failure}`);
      case 'evicted':
        throw new ResultUnavailableError(this.id, 'it was evicted to make room for newer results (SQL_SPOOL_MAX_TOTAL_BYTES)');
      case 'closed':
        throw new ResultUnavailableError(this.id, this.failure ?? 'it was closed');
      default:
    }
  }

  /** Rows from `from` onwards, waiting for rows that are still being spooled. */
  async *rows(from: number, signal?: AbortSignal): AsyncGenerator<unknown[]> {
    let next = from;
    for (;;) {
      this.assertReadable();
      if (next < this.spool.rowsWritten) {
        for await (const row of this.spool.read(next)) {
          yield row;
          next++;
        }
        continue;
      }
      if (this.mode === 'spooled') return;
      await this.waitForChange(signal);
    }
  }

  beginRead(): void {
    this.readers++;
  }

  endRead(): void {
    this.readers = Math.max(0, this.readers - 1);
    this.maybeCloseFile();
  }

  private waitForChange(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new QueryCancelledError());
        return;
      }
      const onChange = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(new QueryCancelledError());
      };
      const cleanup = (): void => {
        this.listeners.delete(onChange);
        signal?.removeEventListener('abort', onAbort);
      };
      this.listeners.add(onChange);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private shutdownFile(): void {
    this.controller.abort();
    this.store._release(this.accounted);
    this.accounted = 0;
    this.notify();
    this.maybeCloseFile();
  }

  private maybeCloseFile(): void {
    if (this.fileClosed || this.readers > 0) return;
    if (this.mode === 'spooling' || this.mode === 'spooled') return;
    this.fileClosed = true;
    void this.spool.destroy();
  }
}

export interface CursorParts {
  lease: Lease;
  reader: CursorReader;
  /** Rows already fetched but not yet served. */
  carry: unknown[][];
  /** Rows already served (the next row index). */
  position: number;
  totalRows: number | null;
  fetchBatch: number;
  timeoutMs: number;
}

/** A result that keeps its database cursor open. */
export class CursorSession {
  readonly kind = 'cursor' as const;
  mode: SessionMode = 'cursor';
  position: number;
  lastAccess = Date.now();
  failure: string | null = null;
  readonly totalRows: number | null;
  readonly fetchBatch: number;
  readonly timeoutMs: number;
  readonly lease: Lease;
  private readonly reader: CursorReader;
  private carry: unknown[][];
  private carryIndex = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleGeneration = 0;
  readonly lock = new Mutex();

  constructor(private readonly store: ResultStore, readonly id: string, readonly columns: ColumnInfo[], parts: CursorParts) {
    this.lease = parts.lease;
    this.reader = parts.reader;
    this.carry = parts.carry;
    this.position = parts.position;
    this.totalRows = parts.totalRows;
    this.fetchBatch = parts.fetchBatch;
    this.timeoutMs = parts.timeoutMs;
  }

  get hasMore(): boolean {
    return this.carryIndex < this.carry.length || !this.reader.exhausted;
  }

  /** The next row without consuming it, fetching up to `want` rows when none are buffered. */
  async peek(want: number, guard: GuardOptions): Promise<unknown[] | null> {
    while (this.carryIndex >= this.carry.length) {
      if (this.reader.exhausted) return null;
      this.carry = await this.reader.fetch(Math.max(1, Math.min(this.fetchBatch, want)), guard);
      this.carryIndex = 0;
    }
    return this.carry[this.carryIndex];
  }

  consume(): void {
    this.carryIndex++;
    this.position++;
  }

  armIdle(): void {
    this.clearIdle();
    if (this.mode !== 'cursor') return;
    const generation = this.idleGeneration;
    this.idleTimer = setTimeout(() => {
      void this.store._expire(this, generation);
    }, this.store.limits.cursorIdleTtlMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleGeneration++;
  }

  isIdleGeneration(generation: number): boolean {
    return generation === this.idleGeneration;
  }

  /** Ends the session: CLOSE and END when fully read, otherwise ROLLBACK. Releases the connection. */
  async close(mode: 'closed' | 'expired' | 'failed', reason?: string): Promise<void> {
    if (this.mode !== 'cursor') return;
    this.mode = mode;
    if (reason !== undefined) this.failure = reason;
    this.clearIdle();
    this.carry = [];
    this.carryIndex = 0;
    try {
      if (mode === 'closed' && !reason) await this.reader.close();
      else await this.reader.abort();
    } catch {
      this.lease.markDiscard();
    } finally {
      this.lease.release();
      this.store._cursorClosed();
    }
  }

  /** Closes the session for server shutdown, cancelling a page that is being read. */
  async shutdown(reason: string): Promise<void> {
    this.clearIdle();
    if (this.mode !== 'cursor') return;
    void this.lease.cancel();
    await Promise.race([this.lock.run(() => this.close('closed', reason)), sleep(3_000)]);
    if (this.mode === 'cursor') {
      this.mode = 'closed';
      this.failure = reason;
      this.lease.markDiscard();
      this.lease.release();
      this.store._cursorClosed();
    }
  }
}

export type ResultSession = SpoolSession | CursorSession;

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export class ResultStore {
  private readonly sessions = new Map<string, ResultSession>();
  private spoolTotal = 0;
  private cursorsOpen = 0;
  private closing = false;

  constructor(
    readonly files: FileStore,
    readonly limits: StoreLimits,
    private readonly opts: { statfs?: StatFs | null; freeSpaceCheckEveryBytes?: number } = {},
  ) {}

  /** Spool bytes in use or reserved. */
  get spoolBytes(): number {
    return this.spoolTotal;
  }

  get openCursorCount(): number {
    return this.cursorsOpen;
  }

  canOpenCursor(): boolean {
    return !this.closing && this.cursorsOpen < this.limits.maxOpenCursors;
  }

  get(id: string): ResultSession | undefined {
    return this.sessions.get(id);
  }

  sessionsList(): ResultSession[] {
    return [...this.sessions.values()];
  }

  private newId(): string {
    let id: string;
    do id = `r_${randomBase32(16)}`;
    while (this.sessions.has(id));
    return id;
  }

  /**
   * Reserves `bytes` of the spool budget, evicting the least recently used spooled results (never
   * `keep`, results still being written, or results being read). Returns false if it can't fit.
   */
  _reserve(bytes: number, keep: SpoolSession | null): boolean {
    const max = this.limits.spoolMaxTotalBytes;
    if (this.spoolTotal + bytes > max) {
      const victims = [...this.sessions.values()]
        .filter((s): s is SpoolSession => s.kind === 'spool' && s !== keep && s.mode === 'spooled' && s.activeReaders === 0)
        .sort((a, b) => a.lastAccess - b.lastAccess);
      for (const victim of victims) {
        if (this.spoolTotal + bytes <= max) break;
        victim._evict();
      }
    }
    if (this.spoolTotal + bytes > max) return false;
    this.spoolTotal += bytes;
    return true;
  }

  _release(bytes: number): void {
    this.spoolTotal = Math.max(0, this.spoolTotal - bytes);
  }

  _cursorClosed(): void {
    this.cursorsOpen = Math.max(0, this.cursorsOpen - 1);
  }

  async _expire(session: CursorSession, generation: number): Promise<void> {
    await session.lock
      .run(async () => {
        if (session.mode !== 'cursor' || !session.isIdleGeneration(generation)) return;
        await session.close('expired');
      })
      .catch(() => undefined);
  }

  /**
   * Creates a spool session, or returns null when paging can't be offered (budget, disk space, or
   * shutdown). `reserveBytes` is the expected size, reserved up front; `capBytes` aborts spooling
   * when exceeded.
   */
  async createSpool(
    columns: ColumnInfo[],
    opts: { totalRows: number | null; reserveBytes?: number; capBytes?: number | null },
  ): Promise<SpoolSession | null> {
    if (this.closing) return null;
    const reserve = Math.max(0, Math.ceil(opts.reserveBytes ?? 0));
    if (reserve > this.limits.spoolMaxTotalBytes) return null;
    if (!this._reserve(reserve, null)) return null;
    let spool: SpoolFile | null = null;
    try {
      await this.files.ensureDirs();
      const guard = new FreeSpaceGuard(this.files.spoolDir, this.limits.minFreeBytes, {
        statfs: this.opts.statfs,
        checkEveryBytes: this.opts.freeSpaceCheckEveryBytes,
      });
      await guard.check();
      const id = this.newId();
      spool = await SpoolFile.create(this.files.spoolPath(id));
      if (this.closing) throw new Error('the server is shutting down');
      const session = new SpoolSession(this, id, columns, opts.totalRows, spool, guard, reserve, opts.capBytes ?? null);
      this.sessions.set(id, session);
      return session;
    } catch (err) {
      this._release(reserve);
      if (spool) await spool.destroy();
      console.error(`[results] paging unavailable for this result: ${describe(err)}`);
      return null;
    }
  }

  /** Creates an open-cursor session that owns `parts.lease`, or returns null when every slot is taken. */
  createCursor(columns: ColumnInfo[], parts: CursorParts): CursorSession | null {
    if (!this.canOpenCursor()) return null;
    this.cursorsOpen++;
    const session = new CursorSession(this, this.newId(), columns, parts);
    this.sessions.set(session.id, session);
    session.armIdle();
    return session;
  }

  /** Drops a spool session that was never shown to a caller. */
  discard(session: SpoolSession): void {
    session._close('it was discarded');
    this.sessions.delete(session.id);
  }

  async fetch(id: string, req: PageRequest, opts: FetchOptions = {}): Promise<RenderedPage> {
    const session = this.sessions.get(id);
    if (!session) throw new ResultUnavailableError(id, 'unknown result ID; results are kept only until the server restarts');
    session.lastAccess = Date.now();
    return session.kind === 'spool' ? this.fetchSpooled(session, req, opts) : this.fetchCursor(session, req, opts);
  }

  private async fetchSpooled(s: SpoolSession, req: PageRequest, opts: FetchOptions): Promise<RenderedPage> {
    const started = Date.now();
    s.assertReadable();
    const offset = req.offset ?? s.position;
    const knownTotal = s.mode === 'spooled' ? s.rowsWritten : s.totalRows;
    if (knownTotal !== null && offset > knownTotal) throw new OffsetOutOfRangeError(offset, knownTotal);
    const builder = new PageBuilder({ format: req.format, columns: s.columns, maxRows: req.maxRows, maxChars: req.maxChars, ceiling: req.ceiling });
    opts.progress?.setProvider(() => ({ message: 'spooling', rows: s.rowsWritten }));
    s.beginRead();
    try {
      for await (const row of s.rows(offset, opts.signal)) {
        if (!builder.tryAdd(row)) break;
      }
    } finally {
      s.endRead();
      opts.progress?.setProvider(null);
    }
    s.position = offset + builder.count;
    const total = s.mode === 'spooled' ? s.rowsWritten : s.totalRows;
    const hasMore = total !== null ? s.position < total : builder.isFull;
    return builder.render({
      mode: 'fetch',
      offset,
      totalRows: total,
      hasMore,
      resultId: hasMore ? s.id : null,
      executionTimeMs: Date.now() - started,
    });
  }

  private fetchCursor(s: CursorSession, req: PageRequest, opts: FetchOptions): Promise<RenderedPage> {
    return s.lock.run(async () => {
      const started = Date.now();
      if (s.mode === 'expired') {
        throw new ResultUnavailableError(
          s.id,
          `its open cursor was closed after ${formatElapsed(this.limits.cursorIdleTtlMs)} without a fetch_rows call (SQL_CURSOR_IDLE_TTL_MS)`,
        );
      }
      if (s.mode === 'failed') throw new ResultUnavailableError(s.id, `reading it failed: ${s.failure}`);
      if (s.mode === 'closed' && s.failure) throw new ResultUnavailableError(s.id, s.failure);
      const offset = req.offset ?? s.position;
      if (offset < s.position) throw new ForwardOnlyError(s.position);
      if (s.mode === 'closed') {
        // Every row was read and the cursor closed; only the end of the result remains.
        if (offset > s.position) throw new OffsetOutOfRangeError(offset, s.position);
        return new PageBuilder({ format: req.format, columns: s.columns, maxRows: req.maxRows, maxChars: req.maxChars, ceiling: req.ceiling })
          .render({ mode: 'fetch', offset, totalRows: s.position, hasMore: false, resultId: null, executionTimeMs: Date.now() - started });
      }
      s.clearIdle();
      const guard: GuardOptions = { signal: opts.signal, timeoutMs: s.timeoutMs > 0 ? s.timeoutMs : undefined };
      opts.progress?.phase('reading rows');
      try {
        while (s.position < offset) {
          if (!(await s.peek(s.fetchBatch, guard))) break;
          s.consume();
        }
        if (s.position < offset) {
          const total = s.position;
          await s.close('closed');
          throw new OffsetOutOfRangeError(offset, total);
        }
        const start = s.position;
        const builder = new PageBuilder({ format: req.format, columns: s.columns, maxRows: req.maxRows, maxChars: req.maxChars, ceiling: req.ceiling });
        for (;;) {
          const row = await s.peek(req.maxRows - builder.count + 1, guard);
          if (!row || !builder.tryAdd(row)) break;
          s.consume();
        }
        const hasMore = s.hasMore;
        const totalRows = s.totalRows ?? (hasMore ? null : s.position);
        if (!hasMore) await s.close('closed');
        return builder.render({
          mode: 'fetch',
          offset: start,
          totalRows,
          hasMore,
          resultId: hasMore ? s.id : null,
          executionTimeMs: Date.now() - started,
        });
      } catch (err) {
        if (!(err instanceof RowTooLargeError) && !(err instanceof OffsetOutOfRangeError)) {
          await s.close('failed', describe(err));
          annotate(err, { phase: 'query', operation: 'fetch_rows', resultClosed: true });
        }
        throw err;
      } finally {
        if (s.mode === 'cursor') s.armIdle();
      }
    });
  }

  /** Server shutdown: closes open cursors, stops spooling and deletes spool files. */
  async closeAll(): Promise<void> {
    this.closing = true;
    const reason = 'the server shut down';
    const tasks: Array<Promise<unknown>> = [];
    for (const session of this.sessions.values()) {
      if (session.kind === 'cursor') tasks.push(session.shutdown(reason));
      else session._close(reason);
    }
    await Promise.allSettled(tasks);
  }
}
