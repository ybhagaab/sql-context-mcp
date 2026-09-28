/**
 * Budgeted page builder and renderers (design Component 7).
 *
 * Rows are added one at a time. The builder tracks the exact rendered size incrementally and
 * rejects the row that would exceed `maxChars` (or `maxRows`); that row becomes carry-over for the
 * next page. A room reserve (FOOTER_RESERVE) is kept for the status/footer lines or the JSON
 * envelope, whose final values are only known after the page is built.
 *
 * Formats:
 * - table: today's padded layout (legacy value display), widths from the page's rows;
 * - csv:   RFC 4180, exact wire text, NULL as an empty unquoted field, '' as "";
 * - json:  one object with typed exact values and paging metadata.
 */
import { ColumnInfo } from './values';
export type Format = 'table' | 'csv' | 'json';
export type PagingUnavailable = 'busy' | 'too-large' | 'unavailable';
export interface PageMeta {
    /** 'run' for run_query/get_sample_data/metadata tools, 'fetch' for fetch_rows. */
    mode: 'run' | 'fetch';
    /** 0-based index of the first row in this page. */
    offset: number;
    /** Exact total rows in the result, or null when unknown. */
    totalRows: number | null;
    /** More rows exist after this page. */
    hasMore: boolean;
    /** Result session to continue with fetch_rows, when paging is available. */
    resultId: string | null;
    /** Why paging isn't available although more rows exist. */
    pagingUnavailable?: PagingUnavailable | null;
    executionTimeMs: number;
    /** Summaries of earlier script statements, e.g. "SET" or "INSERT (5 rows)". */
    statements?: string[];
    /** For statements without rows. */
    command?: string;
    rowsAffected?: number | null;
}
export interface RenderedPage {
    blocks: string[];
}
export declare class RowTooLargeError extends Error {
    readonly size: number;
    readonly ceiling: number;
    constructor(size: number, ceiling: number);
}
/** Room reserved for footer/status lines or the JSON envelope suffix. */
export declare const FOOTER_RESERVE = 800;
export interface PageBuilderOptions {
    format: Format;
    columns: ColumnInfo[];
    maxRows: number;
    maxChars: number;
    /** Hard limit for a single oversized row returned on its own. */
    ceiling: number;
    /** Apply hidden-character sanitization to strings and column names (default true). */
    sanitize?: boolean;
}
/** RFC 4180 field quoting: quoted when it contains a comma, quote, CR or LF; '' becomes "". */
export declare function quoteCsv(text: string): string;
export declare class PageBuilder {
    private readonly opts;
    readonly rows: unknown[][];
    private full;
    private readonly sanitize;
    private readonly names;
    private widths;
    private readonly displays;
    private readonly csvHeader;
    private readonly csvLines;
    private csvSize;
    private readonly jsonRows;
    private jsonSize;
    constructor(opts: PageBuilderOptions);
    private jsonPrefix;
    get count(): number;
    get isFull(): boolean;
    get columns(): ColumnInfo[];
    private clean;
    private cleanExact;
    /**
     * Adds a row if it fits. Returns false (row not added) when the page is full. Throws
     * RowTooLargeError when a single row alone exceeds the ceiling.
     */
    tryAdd(raw: unknown[]): boolean;
    private measure;
    private commit;
    render(meta: PageMeta): RenderedPage;
}
//# sourceMappingURL=page.d.ts.map