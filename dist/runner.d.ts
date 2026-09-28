/**
 * Query runner for run_query, get_sample_data and the catalog tools (design: run_query flow).
 *
 * - Row-returning last statement: cursor path. Earlier script statements run first, in order, on
 *   the same connection. Then BEGIN and DECLARE; the first FETCH waits for the query to finish.
 *   When rows remain after the page, the exact total comes from the engine, and the result is
 *   spooled (connection released soon) or keeps its cursor open (large results), or paging is
 *   reported as busy.
 * - Everything else (statements without rows, transaction-control scripts, text that ends inside
 *   a quote or comment, and SELECTs whose DECLARE is rejected): streaming path. Rows stream
 *   without being collected; the page keeps what fits, the rest is spooled for paging, and every
 *   row is counted so the total is exact.
 *
 * Retries (bounded, connection-level errors only) happen only before the first row, and never
 * after an earlier script statement has completed or a multi-statement script was sent.
 */
import type { ServerConfig } from './config';
import { StreamStatementResult } from './db/stream';
import { Format, RenderedPage } from './results/page';
import { ResultStore } from './results/store';
import type { ProgressReporter } from './mcp/progress';
import type { BufferedResult } from './db/buffered';
export interface RunContext {
    config: ServerConfig;
    results: ResultStore;
}
export interface RunRequest {
    sql: string;
    format: Format;
    maxRows: number;
    maxChars: number;
    /** Per-statement timeout; 0 disables it. */
    timeoutMs: number;
    signal?: AbortSignal;
    progress?: ProgressReporter | null;
}
export declare function summarizeStatement(result: StreamStatementResult, streamedRows: number): string;
/** Expected spool size: the average JSON line size of `sample` times the total (or the engine's byte count, if larger). */
export declare function estimateSpoolBytes(sample: unknown[][], totalRows: number | null, totalBytes: number | null): number | null;
export declare function runQuery(req: RunRequest, ctx: RunContext): Promise<RenderedPage>;
/**
 * Renders a buffered result (catalog tools) with the page budget. Rows beyond the page are
 * spooled from memory, so a large catalog pages like any other result.
 */
export declare function renderBuffered(result: BufferedResult, req: {
    format: Format;
    maxRows: number;
    maxChars: number;
}, ctx: RunContext): Promise<RenderedPage>;
//# sourceMappingURL=runner.d.ts.map