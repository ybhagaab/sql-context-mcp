import type { ServerConfig } from '../config';
import { FileStore, StatFs } from '../files/store';
import { ColumnInfo, ExactValue } from '../results/values';
import { ExportFormat, RowWriter } from './writers';
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
export declare class ExportJob {
    readonly id: string;
    readonly request: ExportRequest;
    readonly paths: ExportPaths;
    state: ExportState;
    rowsWritten: number;
    bytesWritten: number;
    truncated: boolean;
    columns: ColumnInfo[];
    /** First rows, raw (converted when shown). */
    preview: unknown[][];
    readonly queuedAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    readonly done: Promise<void>;
    private readonly controller;
    private settleDone;
    constructor(id: string, request: ExportRequest, paths: ExportPaths);
    get format(): ExportFormat;
    get signal(): AbortSignal;
    get isFinished(): boolean;
    _abort(): void;
    _settle(): void;
    /** Exact values of the preview rows. */
    previewValues(): ExactValue[][];
}
export declare class ExportManager {
    private readonly files;
    private readonly config;
    private readonly opts;
    private readonly jobs;
    private readonly queue;
    private running;
    private closing;
    /** Largest number of rows any export queued in memory at once (memory-bound tests). */
    peakQueuedRows: number;
    constructor(files: FileStore, config: ServerConfig, opts?: ExportManagerOptions);
    get runningCount(): number;
    get(id: string): ExportJob | undefined;
    list(): ExportJob[];
    /** 1-based position in the queue, or null when the job isn't queued. */
    queuePosition(job: ExportJob): number | null;
    submit(request: ExportRequest): Promise<ExportJob>;
    /** Cancels a queued or running job and waits (briefly) for it to finish. */
    cancel(job: ExportJob): Promise<void>;
    /** Waits for `job` to finish. Aborting `signal` cancels the job. */
    wait(job: ExportJob, signal?: AbortSignal): Promise<void>;
    /** Server shutdown: cancels every queued and running job. */
    closeAll(): Promise<void>;
    private pump;
    private run;
    private sidecar;
    private execute;
}
/** The result of a finished export, as shown to callers. `clean` sanitizes inline strings. */
export declare function exportResult(job: ExportJob, clean: (text: string) => string): Record<string, unknown>;
/** Status of any job, as shown by export_status. */
export declare function exportStatus(job: ExportJob, manager: ExportManager, clean: (text: string) => string): Record<string, unknown>;
/** Progress for a job, for MCP progress notifications. */
export declare function exportProgress(job: ExportJob, manager: ExportManager): {
    message: string;
    rows?: number;
    bytes?: number;
};
//# sourceMappingURL=manager.d.ts.map