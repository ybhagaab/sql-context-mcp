/**
 * Buffered executor used by the catalog tools (list_schemas, list_tables, describe_table).
 *
 * Runs one query on a pooled connection with the bounded reconnect-and-retry and returns its rows
 * in memory, as raw wire text in arrays. Array rows keep every column in order, even for duplicate
 * or number-like column names. Catalog results are small; query results use the cursor and
 * streaming paths instead, which never hold a whole result in memory.
 */
import { withConnectionRetry } from './pool';
import { RAW_TYPES } from '../results/values';

export interface BufferedResult {
  columns: string[];
  rows: unknown[][];
  /** Rows returned, or rows affected for statements without rows. */
  rowCount: number;
  executionTime: number;
  fields: Array<{ name: string; dataTypeID: number }>;
  command: string;
}

interface RawResult {
  command?: unknown;
  rowCount?: unknown;
  fields?: Array<{ name: unknown; dataTypeID?: unknown }>;
  rows?: unknown[];
}

export async function executeQuery(sql: string, params?: unknown[]): Promise<BufferedResult> {
  return withConnectionRetry(async (activePool) => {
    const startTime = Date.now();
    // Per-query checkout: `pool.query()` acquires a client from the pool, runs the query, and
    // releases it, so concurrent calls run in parallel on separate connections.
    const raw = (await activePool.query({ text: sql, values: params, rowMode: 'array', types: RAW_TYPES } as never)) as unknown;
    const executionTime = Date.now() - startTime;
    const list = (Array.isArray(raw) ? raw : [raw]) as Array<RawResult | null | undefined>;
    // A script returns one result per statement: show the last one that has columns.
    let shown = list[list.length - 1];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.fields?.length) {
        shown = list[i];
        break;
      }
    }
    const fields = (shown?.fields ?? []).map((f) => ({
      name: String(f.name),
      dataTypeID: typeof f.dataTypeID === 'number' ? f.dataTypeID : 0,
    }));
    const rows = (shown?.rows ?? []).map((row) => (Array.isArray(row) ? row : Object.values(row as object)));
    const rowCount = fields.length > 0 ? rows.length : typeof shown?.rowCount === 'number' ? shown.rowCount : 0;
    return {
      columns: fields.map((f) => f.name),
      rows,
      rowCount,
      executionTime,
      fields,
      command: typeof shown?.command === 'string' ? shown.command : '',
    };
  });
}
