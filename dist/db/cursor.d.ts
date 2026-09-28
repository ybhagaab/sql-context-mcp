/**
 * Cursor reader (design Component 5): DECLARE/FETCH with raw wire text in array rows.
 *
 * Redshift allows one cursor per session, and each lease is its own session. The first FETCH
 * blocks until the database finishes the query (on Redshift the result is built on the leader
 * node); later FETCHes are fast. DECLARE doesn't execute the query, so falling back to the
 * streaming executor after a rejected DECLARE is safe.
 */
import type { Lease, GuardOptions } from './lease';
import type { EngineInfo } from './engine';
export declare const CURSOR_NAME = "mcp_c";
export declare class DeclareRejectedError extends Error {
    readonly cause: unknown;
    constructor(cause: unknown);
}
export declare function stripTrailingSemicolons(sql: string): string;
export declare class CursorReader {
    private readonly lease;
    fields: Array<{
        name: string;
        dataTypeID: number;
    }> | null;
    exhausted: boolean;
    fetchedRows: number;
    private open;
    private constructor();
    static open(lease: Lease, sql: string, engine: EngineInfo, opts?: GuardOptions): Promise<CursorReader>;
    get isOpen(): boolean;
    fetch(count: number, opts?: GuardOptions): Promise<unknown[][]>;
    /** CLOSE + END. On failure the connection is marked for discard. */
    close(): Promise<void>;
    /** ROLLBACK the cursor's transaction. On failure the connection is marked for discard. */
    abort(): Promise<void>;
}
//# sourceMappingURL=cursor.d.ts.map