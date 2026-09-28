/**
 * Engine adapter (design Component 2): Redshift/PostgreSQL detection, exact totals, FETCH caps.
 *
 * Detection runs once per pool, on a lease, outside any transaction, so permission errors from
 * the probes can't abort a cursor's transaction later.
 */
import type { Pool } from 'pg';
import type { Lease, GuardOptions } from './lease';
import { RAW_TYPES, ColumnInfo, unknownOids, registerTypeNames, typeName } from '../results/values';
import { isConnectionLevelError } from './pool';
import { CURSOR_NAME } from './cursor';

/**
 * Resolves the names of types that aren't built in (for example Redshift's `super`) with one
 * pg_type lookup, using integer literals only. Names are cached per OID. If the lookup fails,
 * the OID is used as the name. Updates `columns` in place.
 */
export async function resolveColumnTypes(
  run: (text: string) => Promise<{ rows?: unknown[][] }>,
  columns: ColumnInfo[],
): Promise<void> {
  const missing = unknownOids(columns.map((c) => c.oid)).filter((oid) => Number.isSafeInteger(oid) && oid > 0);
  if (missing.length) {
    try {
      const result = await run(`select oid, typname from pg_type where oid in (${missing.join(', ')})`);
      const names: Record<number, string> = {};
      for (const row of result.rows ?? []) {
        if (Array.isArray(row) && row[0] !== null && row[1] !== null) names[Number(row[0])] = String(row[1]);
      }
      registerTypeNames(names);
    } catch (err) {
      if (isConnectionLevelError(err)) throw err;
    }
  }
  for (const column of columns) column.type = typeName(column.oid);
}

/** A pg_type lookup function that runs on `lease`. */
export function typeLookupOn(lease: Lease): (text: string) => Promise<{ rows?: unknown[][] }> {
  return (text) => lease.query({ text, rowMode: 'array', types: RAW_TYPES });
}

export interface EngineInfo {
  kind: 'redshift' | 'postgres';
  singleNode: boolean;
  /** stv_active_cursors is readable, so cursor totals come for free. */
  totalsFromStv: boolean;
}

let cache = new WeakMap<object, Promise<EngineInfo>>();

/** Test-only: forget cached detections. */
export function __resetEngineCache(): void {
  cache = new WeakMap();
}

async function probe(lease: Lease, text: string): Promise<{ rows: unknown[][] } | null> {
  try {
    return await lease.query({ text, rowMode: 'array', types: RAW_TYPES });
  } catch (err) {
    if (isConnectionLevelError(err)) throw err;
    return null;
  }
}

export function detectEngine(pool: Pool, lease: Lease): Promise<EngineInfo> {
  const cached = cache.get(pool);
  if (cached) return cached;
  const detection = (async (): Promise<EngineInfo> => {
    const version = await lease.query({ text: 'select version()', rowMode: 'array', types: RAW_TYPES });
    const text = String(version.rows?.[0]?.[0] ?? '');
    if (!/redshift/i.test(text)) return { kind: 'postgres', singleNode: false, totalsFromStv: false };
    const nodes = await probe(lease, 'select count(distinct node) as nodes from stv_slices');
    const singleNode = nodes ? Number(nodes.rows[0]?.[0]) === 1 : false;
    const stv = await probe(lease, 'select 1 from stv_active_cursors limit 0');
    return { kind: 'redshift', singleNode, totalsFromStv: stv !== null };
  })();
  cache.set(pool, detection);
  detection.catch(() => cache.delete(pool));
  return detection;
}

/** FETCH batch size: single-node Redshift clusters cap FETCH at 1,000 rows. */
export function fetchBatchSize(configured: number, engine: EngineInfo): number {
  return engine.kind === 'redshift' && engine.singleNode ? Math.min(configured, 1_000) : configured;
}

/**
 * Exact totals for the open cursor, without transferring rows.
 * - Redshift: the result is fully built on the leader node after the first FETCH, and
 *   stv_active_cursors reports its row count and size.
 * - PostgreSQL: MOVE FORWARD ALL counts the remaining rows of the SCROLL cursor, then MOVE
 *   ABSOLUTE returns to the current position.
 */
export async function cursorTotals(
  lease: Lease,
  engine: EngineInfo,
  fetchedSoFar: number,
  opts: GuardOptions = {},
): Promise<{ totalRows: number | null; totalBytes: number | null }> {
  if (engine.kind === 'redshift') {
    if (!engine.totalsFromStv) return { totalRows: null, totalBytes: null };
    const r = await lease.query({
      text: 'select row_count, byte_count from stv_active_cursors where pid = pg_backend_pid()',
      rowMode: 'array',
      types: RAW_TYPES,
    }, opts);
    const row = r.rows?.[0];
    if (!row) return { totalRows: null, totalBytes: null };
    const totalRows = Number(row[0]);
    const totalBytes = Number(row[1]);
    return {
      totalRows: Number.isFinite(totalRows) ? totalRows : null,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
    };
  }
  const moved = await lease.query(`MOVE FORWARD ALL IN ${CURSOR_NAME}`, opts);
  const remaining = typeof moved.rowCount === 'number' ? moved.rowCount : 0;
  await lease.query(`MOVE ABSOLUTE ${fetchedSoFar} IN ${CURSOR_NAME}`, opts);
  return { totalRows: fetchedSoFar + remaining, totalBytes: null };
}
