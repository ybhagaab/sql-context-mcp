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
import { RAW_TYPES } from '../results/values';
import { isConnectionLevelError } from './pool';

export const CURSOR_NAME = 'mcp_c';

export class DeclareRejectedError extends Error {
  constructor(public readonly cause: unknown) {
    super(`DECLARE CURSOR was rejected: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'DeclareRejectedError';
  }
}

export function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').trim();
}

export class CursorReader {
  fields: Array<{ name: string; dataTypeID: number }> | null = null;
  exhausted = false;
  fetchedRows = 0;
  private open = true;

  private constructor(private readonly lease: Lease) {}

  static async open(lease: Lease, sql: string, engine: EngineInfo, opts: GuardOptions = {}): Promise<CursorReader> {
    const statement = stripTrailingSemicolons(sql);
    await lease.query('BEGIN', opts);
    try {
      await lease.query(`DECLARE ${CURSOR_NAME} ${engine.kind === 'postgres' ? 'SCROLL ' : ''}CURSOR FOR ${statement}`, opts);
    } catch (err) {
      if (isConnectionLevelError(err)) throw err;
      await lease.query('ROLLBACK').catch(() => lease.markDiscard());
      if ((err as { name?: string }).name === 'QueryCancelledError' || (err as { name?: string }).name === 'QueryTimeoutError') throw err;
      throw new DeclareRejectedError(err);
    }
    return new CursorReader(lease);
  }

  get isOpen(): boolean {
    return this.open;
  }

  async fetch(count: number, opts: GuardOptions = {}): Promise<unknown[][]> {
    const result = await this.lease.query(
      { text: `FETCH FORWARD ${count} FROM ${CURSOR_NAME}`, rowMode: 'array', types: RAW_TYPES },
      opts,
    );
    if (!this.fields) {
      this.fields = (result.fields ?? []).map((f: { name: string; dataTypeID: number }) => ({ name: f.name, dataTypeID: f.dataTypeID }));
    }
    const rows = (result.rows ?? []) as unknown[][];
    this.fetchedRows += rows.length;
    if (rows.length < count) this.exhausted = true;
    return rows;
  }

  /** CLOSE + END. On failure the connection is marked for discard. */
  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    try {
      await this.lease.query(`CLOSE ${CURSOR_NAME}`);
      await this.lease.query('END');
    } catch {
      this.lease.markDiscard();
      await this.lease.query('ROLLBACK').catch(() => undefined);
    }
  }

  /** ROLLBACK the cursor's transaction. On failure the connection is marked for discard. */
  async abort(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    await this.lease.query('ROLLBACK').catch(() => this.lease.markDiscard());
  }
}
