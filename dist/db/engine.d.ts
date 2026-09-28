/**
 * Engine adapter (design Component 2): Redshift/PostgreSQL detection, exact totals, FETCH caps.
 *
 * Detection runs once per pool, on a lease, outside any transaction, so permission errors from
 * the probes can't abort a cursor's transaction later.
 */
import type { Pool } from 'pg';
import type { Lease, GuardOptions } from './lease';
import { ColumnInfo } from '../results/values';
/**
 * Resolves the names of types that aren't built in (for example Redshift's `super`) with one
 * pg_type lookup, using integer literals only. Names are cached per OID. If the lookup fails,
 * the OID is used as the name. Updates `columns` in place.
 */
export declare function resolveColumnTypes(run: (text: string) => Promise<{
    rows?: unknown[][];
}>, columns: ColumnInfo[]): Promise<void>;
/** A pg_type lookup function that runs on `lease`. */
export declare function typeLookupOn(lease: Lease): (text: string) => Promise<{
    rows?: unknown[][];
}>;
export interface EngineInfo {
    kind: 'redshift' | 'postgres';
    singleNode: boolean;
    /** stv_active_cursors is readable, so cursor totals come for free. */
    totalsFromStv: boolean;
}
/** Test-only: forget cached detections. */
export declare function __resetEngineCache(): void;
export declare function detectEngine(pool: Pool, lease: Lease): Promise<EngineInfo>;
/** FETCH batch size: single-node Redshift clusters cap FETCH at 1,000 rows. */
export declare function fetchBatchSize(configured: number, engine: EngineInfo): number;
/**
 * Exact totals for the open cursor, without transferring rows.
 * - Redshift: the result is fully built on the leader node after the first FETCH, and
 *   stv_active_cursors reports its row count and size.
 * - PostgreSQL: MOVE FORWARD ALL counts the remaining rows of the SCROLL cursor, then MOVE
 *   ABSOLUTE returns to the current position.
 */
export declare function cursorTotals(lease: Lease, engine: EngineInfo, fetchedSoFar: number, opts?: GuardOptions): Promise<{
    totalRows: number | null;
    totalBytes: number | null;
}>;
//# sourceMappingURL=engine.d.ts.map