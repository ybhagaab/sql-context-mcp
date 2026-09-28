import type { Lease, GuardOptions } from './lease';
export interface StreamField {
    name: string;
    dataTypeID: number;
}
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
export declare class RowPump {
    private readonly processRow;
    private readonly opts;
    private queue;
    private head;
    private running;
    private paused;
    private control;
    private failed;
    private failure;
    private waiters;
    private readonly highWater;
    /** Largest number of rows queued at once (used by memory-bound tests). */
    peakQueued: number;
    constructor(processRow: (row: unknown[], index: number) => void | Promise<void>, opts?: {
        highWater?: number;
        onError?: (err: unknown) => void;
    });
    get hasFailed(): boolean;
    get error(): unknown;
    push(row: unknown[], index: number, control: StreamControl): void;
    /** Resolves once every pushed row has been processed; rejects with the processing error. */
    flush(): Promise<void>;
    private run;
    private maybeResume;
    private fail;
    private settle;
}
export declare function streamQuery(lease: Lease, text: string, handlers: StreamHandlers, opts?: GuardOptions): Promise<StreamOutcome>;
//# sourceMappingURL=stream.d.ts.map