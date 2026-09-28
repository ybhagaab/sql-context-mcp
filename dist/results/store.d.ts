import { FileStore, FreeSpaceGuard, StatFs } from '../files/store';
import type { ColumnInfo } from './values';
import { Format, RenderedPage } from './page';
import { Lease, GuardOptions } from '../db/lease';
import type { CursorReader } from '../db/cursor';
import type { ProgressReporter } from '../mcp/progress';
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
export declare class ResultUnavailableError extends Error {
    readonly resultId: string;
    readonly reason: string;
    constructor(resultId: string, reason: string);
}
export declare class ForwardOnlyError extends Error {
    readonly position: number;
    constructor(position: number);
}
export declare class OffsetOutOfRangeError extends Error {
    readonly offset: number;
    readonly totalRows: number;
    constructor(offset: number, totalRows: number);
}
export declare class SpoolLimitError extends Error {
    readonly reason: 'too-large' | 'budget';
    constructor(reason: 'too-large' | 'budget');
}
/** Runs async sections one at a time, in call order. */
declare class Mutex {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
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
export declare class SpoolFile {
    readonly path: string;
    private readonly handle;
    rowsWritten: number;
    bytes: number;
    private readonly index;
    private closed;
    private constructor();
    static create(file: string): Promise<SpoolFile>;
    encode(rows: unknown[][]): EncodedRows;
    write(encoded: EncodedRows): Promise<void>;
    /** Yields rows from `from` up to the end of the data written so far (including data written while reading). */
    read(from: number): AsyncGenerator<unknown[]>;
    /** Closes and deletes the file. Idempotent. */
    destroy(): Promise<void>;
}
/** A result whose rows are (being) written to a spool file. */
export declare class SpoolSession {
    private readonly store;
    readonly id: string;
    readonly columns: ColumnInfo[];
    private readonly spool;
    private readonly guard;
    private readonly capBytes;
    readonly kind: "spool";
    mode: SessionMode;
    /** Next row index to serve when fetch_rows has no offset. */
    position: number;
    lastAccess: number;
    failure: string | null;
    totalRows: number | null;
    private readers;
    private accounted;
    private fileClosed;
    private readonly controller;
    private readonly listeners;
    private readonly appendLock;
    constructor(store: ResultStore, id: string, columns: ColumnInfo[], totalRows: number | null, spool: SpoolFile, guard: FreeSpaceGuard, reserved: number, capBytes: number | null);
    /** Aborted when the session ends early; producers pass it to their queries. */
    get signal(): AbortSignal;
    get rowsWritten(): number;
    get bytes(): number;
    get activeReaders(): number;
    /** Bytes this session counts against the spool budget. */
    get accountedBytes(): number;
    /** Appends rows. Enforces the size cap, the spool budget and the free-space reserve. */
    append(rows: unknown[][]): Promise<void>;
    /** Spooling is complete; the total is now exact. */
    finish(): void;
    /** Spooling failed. Pages already returned stay valid; fetch_rows reports the failure. */
    fail(err: unknown): void;
    /** Evicted to make room for newer results. */
    _evict(): void;
    /** Closed by the server (shutdown, or a result the caller never saw). */
    _close(reason: string): void;
    assertReadable(): void;
    /** Rows from `from` onwards, waiting for rows that are still being spooled. */
    rows(from: number, signal?: AbortSignal): AsyncGenerator<unknown[]>;
    beginRead(): void;
    endRead(): void;
    private waitForChange;
    private notify;
    private shutdownFile;
    private maybeCloseFile;
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
export declare class CursorSession {
    private readonly store;
    readonly id: string;
    readonly columns: ColumnInfo[];
    readonly kind: "cursor";
    mode: SessionMode;
    position: number;
    lastAccess: number;
    failure: string | null;
    readonly totalRows: number | null;
    readonly fetchBatch: number;
    readonly timeoutMs: number;
    readonly lease: Lease;
    private readonly reader;
    private carry;
    private carryIndex;
    private idleTimer;
    private idleGeneration;
    readonly lock: Mutex;
    constructor(store: ResultStore, id: string, columns: ColumnInfo[], parts: CursorParts);
    get hasMore(): boolean;
    /** The next row without consuming it, fetching up to `want` rows when none are buffered. */
    peek(want: number, guard: GuardOptions): Promise<unknown[] | null>;
    consume(): void;
    armIdle(): void;
    clearIdle(): void;
    isIdleGeneration(generation: number): boolean;
    /** Ends the session: CLOSE and END when fully read, otherwise ROLLBACK. Releases the connection. */
    close(mode: 'closed' | 'expired' | 'failed', reason?: string): Promise<void>;
    /** Closes the session for server shutdown, cancelling a page that is being read. */
    shutdown(reason: string): Promise<void>;
}
export type ResultSession = SpoolSession | CursorSession;
export declare class ResultStore {
    readonly files: FileStore;
    readonly limits: StoreLimits;
    private readonly opts;
    private readonly sessions;
    private spoolTotal;
    private cursorsOpen;
    private closing;
    constructor(files: FileStore, limits: StoreLimits, opts?: {
        statfs?: StatFs | null;
        freeSpaceCheckEveryBytes?: number;
    });
    /** Spool bytes in use or reserved. */
    get spoolBytes(): number;
    get openCursorCount(): number;
    canOpenCursor(): boolean;
    get(id: string): ResultSession | undefined;
    sessionsList(): ResultSession[];
    private newId;
    /**
     * Reserves `bytes` of the spool budget, evicting the least recently used spooled results (never
     * `keep`, results still being written, or results being read). Returns false if it can't fit.
     */
    _reserve(bytes: number, keep: SpoolSession | null): boolean;
    _release(bytes: number): void;
    _cursorClosed(): void;
    _expire(session: CursorSession, generation: number): Promise<void>;
    /**
     * Creates a spool session, or returns null when paging can't be offered (budget, disk space, or
     * shutdown). `reserveBytes` is the expected size, reserved up front; `capBytes` aborts spooling
     * when exceeded.
     */
    createSpool(columns: ColumnInfo[], opts: {
        totalRows: number | null;
        reserveBytes?: number;
        capBytes?: number | null;
    }): Promise<SpoolSession | null>;
    /** Creates an open-cursor session that owns `parts.lease`, or returns null when every slot is taken. */
    createCursor(columns: ColumnInfo[], parts: CursorParts): CursorSession | null;
    /** Drops a spool session that was never shown to a caller. */
    discard(session: SpoolSession): void;
    fetch(id: string, req: PageRequest, opts?: FetchOptions): Promise<RenderedPage>;
    private fetchSpooled;
    private fetchCursor;
    /** Server shutdown: closes open cursors, stops spooling and deletes spool files. */
    closeAll(): Promise<void>;
}
export {};
//# sourceMappingURL=store.d.ts.map