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
 * after an earlier script statement has completed, a multi-statement script was sent, or SQL that
 * may change data was sent (a lost connection can't tell whether it ran). The final error records
 * what had been sent and completed, for the error description.
 */
import type { ServerConfig } from './config';
import { planScript, ScriptPlan, EmptySqlError, StatementInfo, mayChangeData } from './sql/classify';
import { withConnectionRetry, isConnectionLevelError } from './db/pool';
import { Lease, GuardOptions, QueryCancelledError, QueryTimeoutError } from './db/lease';
import { detectEngine, fetchBatchSize, cursorTotals, resolveColumnTypes, typeLookupOn, EngineInfo } from './db/engine';
import { CursorReader, DeclareRejectedError, declarePrefix } from './db/cursor';
import { annotate, setContext, StatementRef } from './errors/context';
import { streamQuery, RowPump, StreamField, StreamStatementResult } from './db/stream';
import { PageBuilder, Format, RenderedPage, PagingUnavailable, PageMeta } from './results/page';
import { columnsFromFields, ColumnInfo } from './results/values';
import { ResultStore, SpoolSession, SpoolLimitError } from './results/store';
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
  /** The tool, for error wording (default run_query). */
  operation?: string;
}

/** Per-call execution state, shared by every attempt; error descriptions report it. */
export interface SqlProgress {
  /** Set once a retry would be unsafe: a row arrived, a script statement ran, or data-changing SQL was sent. */
  noRetry: boolean;
  /** Attempts on which the caller's SQL was sent. */
  sentCount: number;
  sentThisAttempt: boolean;
  /** Summaries of the script statements that completed. */
  completed: string[];
  /** The statement being run. */
  current: StatementRef | null;
}

type RunState = SqlProgress;

export function newSqlProgress(): SqlProgress {
  return { noRetry: false, sentCount: 0, sentThisAttempt: false, completed: [], current: null };
}

/** Records that `statement` is about to be sent. Data-changing SQL is never re-sent after a lost connection. */
export function markSending(state: SqlProgress, ref: StatementRef): void {
  state.current = ref;
  if (!state.sentThisAttempt) {
    state.sentThisAttempt = true;
    state.sentCount++;
  }
  if (mayChangeData(ref.text)) state.noRetry = true;
}

export function statementRef(statement: StatementInfo, index: number | null, shift = 0): StatementRef {
  return { text: statement.text, offset: statement.offset, shift, index };
}

/** The whole text, sent as one request. */
export function wholeRef(sql: string): StatementRef {
  return { text: sql, offset: 0, shift: 0, index: null };
}

/** Adds what the call had done to its final error, for the error description. */
export function annotateSqlError(err: unknown, sql: string, plan: ScriptPlan, state: SqlProgress, operation: string): unknown {
  annotate(err, { phase: 'query' });
  return setContext(err, {
    operation,
    sql,
    sentCount: state.sentCount,
    completed: [...state.completed],
    statement: state.current ?? undefined,
    isScript: plan.isScript,
    statementCount: plan.statements.length,
  });
}

/** Rows written to a spool file per append on the streaming path. */
const SPOOL_BATCH_ROWS = 1_000;
const COUNTED_COMMANDS = /^(INSERT|UPDATE|DELETE|MERGE|COPY|SELECT|MOVE|FETCH)$/;

export function summarizeStatement(result: StreamStatementResult, streamedRows: number): string {
  const command = result.command || 'OK';
  if (result.fields.length > 0) return `${command} (${streamedRows} rows)`;
  if (typeof result.rowCount === 'number' && COUNTED_COMMANDS.test(command)) return `${command} (${result.rowCount} rows)`;
  return command;
}

/** Expected spool size: the average JSON line size of `sample` times the total (or the engine's byte count, if larger). */
export function estimateSpoolBytes(sample: unknown[][], totalRows: number | null, totalBytes: number | null): number | null {
  if (totalRows === null) return null;
  const n = Math.min(sample.length, 5_000);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += JSON.stringify(sample[i]).length + 1;
  const perRow = n > 0 ? sum / n : 0;
  return Math.max(Math.ceil(perRow * totalRows), totalBytes ?? 0);
}

function guardOf(req: { signal?: AbortSignal; timeoutMs: number }, signal?: AbortSignal): GuardOptions {
  return { signal: signal ?? req.signal, timeoutMs: req.timeoutMs > 0 ? req.timeoutMs : undefined };
}

function effectiveMaxChars(maxChars: number, config: ServerConfig): number {
  return Math.max(1, Math.min(maxChars, config.maxInlineCharsCeiling));
}

export async function runQuery(req: RunRequest, ctx: RunContext): Promise<RenderedPage> {
  const plan = planScript(req.sql);
  if (plan.complete && plan.statements.length === 0) throw new EmptySqlError();
  const started = Date.now();
  const state: RunState = newSqlProgress();
  try {
    return await withConnectionRetry(
      async (pool) => {
        state.sentThisAttempt = false;
        state.completed = [];
        state.current = null;
        req.progress?.phase('waiting for a database connection');
        const lease = await Lease.acquire(pool, { signal: req.signal });
        const hand = { off: false };
        try {
          if (plan.changesSession) lease.markDiscard();
          const engine = await detectEngine(pool, lease);
          req.progress?.phase('query running on the database');
          if (!plan.complete || plan.hasTransactionControl) {
            // Run the text as written, in one request, then discard the connection if it changed state.
            if (plan.isScript) state.noRetry = true;
            return await streamPath(lease, req.sql, wholeRef(req.sql), [], req, ctx, state, started);
          }
          const statements = await runPrefix(lease, plan, req, state);
          const last = plan.last as NonNullable<ScriptPlan['last']>;
          const lastIndex = plan.statements.length;
          if (last.kind === 'rows') {
            try {
              return await cursorPath(lease, engine, last, lastIndex, statements, req, ctx, state, started, hand);
            } catch (err) {
              if (!(err instanceof DeclareRejectedError)) throw err;
              // DECLARE doesn't execute the query, so running it without a cursor is safe.
            }
          }
          return await streamPath(lease, last.text, statementRef(last, lastIndex), statements, req, ctx, state, started);
        } catch (err) {
          if (isConnectionLevelError(err)) lease.markDiscard();
          throw err;
        } finally {
          if (!hand.off) lease.release();
        }
      },
      { canRetry: () => !state.noRetry },
    );
  } catch (err) {
    throw annotateSqlError(err, req.sql, plan, state, req.operation ?? 'run_query');
  }
}

async function runPrefix(lease: Lease, plan: ScriptPlan, req: RunRequest, state: RunState): Promise<string[]> {
  const summaries: string[] = [];
  const guard = guardOf(req);
  for (const [i, statement] of plan.prefix.entries()) {
    const counts = new Map<number, number>();
    markSending(state, statementRef(statement, i + 1));
    const outcome = await streamQuery(
      lease,
      statement.text,
      { onRow: (_row, index) => { counts.set(index, (counts.get(index) ?? 0) + 1); } },
      guard,
    );
    state.noRetry = true;
    for (const r of outcome.results) summaries.push(summarizeStatement(r, r.streamedIndex === null ? 0 : counts.get(r.streamedIndex) ?? 0));
    state.completed = [...summaries];
  }
  return summaries;
}

async function cursorPath(
  lease: Lease,
  engine: EngineInfo,
  statement: StatementInfo,
  index: number,
  statements: string[],
  req: RunRequest,
  ctx: RunContext,
  state: RunState,
  started: number,
  hand: { off: boolean },
): Promise<RenderedPage> {
  const guard = guardOf(req);
  markSending(state, statementRef(statement, index, declarePrefix(engine).length));
  const reader = await CursorReader.open(lease, statement.text, engine, guard);
  try {
    const batch = fetchBatchSize(ctx.config.fetchBatchRows, engine);
    // The first FETCH waits for the query to finish.
    let carry = await reader.fetch(Math.min(batch, req.maxRows + 1), guard);
    state.noRetry = true;
    const columns = columnsFromFields(reader.fields ?? []);
    await resolveColumnTypes(typeLookupOn(lease), columns);
    req.progress?.phase('reading rows');
    const builder = new PageBuilder({
      format: req.format,
      columns,
      maxRows: req.maxRows,
      maxChars: effectiveMaxChars(req.maxChars, ctx.config),
      ceiling: ctx.config.maxInlineCharsCeiling,
    });
    let used = 0;
    for (;;) {
      while (used < carry.length && builder.tryAdd(carry[used])) used++;
      if (used < carry.length || reader.exhausted) break;
      carry = await reader.fetch(Math.min(batch, req.maxRows - builder.count + 1), guard);
      used = 0;
    }
    const leftover = carry.slice(used);
    if (leftover.length === 0 && reader.exhausted) {
      await reader.close();
      return builder.render({
        mode: 'run', offset: 0, totalRows: builder.count, hasMore: false, resultId: null,
        executionTimeMs: Date.now() - started, statements,
      });
    }

    // Rows remain: get the exact total without transferring them, then choose a paging mode.
    let totals: { totalRows: number | null; totalBytes: number | null } = { totalRows: null, totalBytes: null };
    try {
      totals = await cursorTotals(lease, engine, reader.fetchedRows, guard);
    } catch (err) {
      if (err instanceof QueryCancelledError || err instanceof QueryTimeoutError) throw err;
      if (isConnectionLevelError(err)) lease.markDiscard();
      console.error(`[run_query] could not get the result total: ${err instanceof Error ? err.message : String(err)}`);
      // The cursor's transaction may be unusable now: return the page without paging.
      return builder.render({
        mode: 'run', offset: 0, totalRows: null, hasMore: true, resultId: null, pagingUnavailable: 'unavailable',
        executionTimeMs: Date.now() - started, statements,
      });
    }
    const meta: PageMeta = {
      mode: 'run', offset: 0, totalRows: totals.totalRows, hasMore: true, resultId: null,
      executionTimeMs: 0, statements,
    };

    const inHand = builder.rows.concat(leftover);
    const estimate = estimateSpoolBytes(inHand, totals.totalRows, totals.totalBytes);
    const threshold = ctx.config.spoolThresholdBytes;
    if (estimate === null || estimate <= threshold) {
      const session = await ctx.results.createSpool(columns, {
        totalRows: totals.totalRows,
        reserveBytes: estimate ?? 0,
        // An unknown total is spooled up to the threshold; beyond it, paging fails with a clear error.
        capBytes: estimate === null ? threshold : null,
      });
      if (session) {
        session.position = builder.count;
        hand.off = true;
        void spoolFromCursor(session, lease, reader, inHand, batch, req.timeoutMs);
        return builder.render({ ...meta, resultId: session.id, executionTimeMs: Date.now() - started });
      }
    }
    const cursor = ctx.results.createCursor(columns, {
      lease, reader, carry: leftover, position: builder.count, totalRows: totals.totalRows,
      fetchBatch: batch, timeoutMs: req.timeoutMs,
    });
    if (cursor) {
      hand.off = true;
      return builder.render({ ...meta, resultId: cursor.id, executionTimeMs: Date.now() - started });
    }
    await reader.close();
    const pagingUnavailable: PagingUnavailable = ctx.config.maxOpenCursors > 0 ? 'busy' : 'too-large';
    return builder.render({ ...meta, pagingUnavailable, executionTimeMs: Date.now() - started });
  } finally {
    if (!hand.off && reader.isOpen) await reader.abort();
  }
}

/** Background task: writes the rest of a cursor's rows to its spool, then releases the connection. */
async function spoolFromCursor(
  session: SpoolSession,
  lease: Lease,
  reader: CursorReader,
  initial: unknown[][],
  batch: number,
  timeoutMs: number,
): Promise<void> {
  try {
    await session.append(initial);
    const guard: GuardOptions = { signal: session.signal, timeoutMs: timeoutMs > 0 ? timeoutMs : undefined };
    while (!reader.exhausted) {
      const rows = await reader.fetch(batch, guard);
      if (rows.length) await session.append(rows);
    }
    await reader.close();
    session.finish();
  } catch (err) {
    session.fail(err);
    if (isConnectionLevelError(err)) lease.markDiscard();
    await reader.abort().catch(() => undefined);
  } finally {
    lease.release();
  }
}

interface ResultSetState {
  index: number;
  columns: ColumnInfo[];
  builder: PageBuilder;
  total: number;
  /** The page is full; later rows go to the spool. */
  pageClosed: boolean;
  spool: SpoolSession | null;
  pending: unknown[][];
  abandoned: PagingUnavailable | null;
}

async function streamPath(
  lease: Lease,
  text: string,
  ref: StatementRef,
  statements: string[],
  req: RunRequest,
  ctx: RunContext,
  state: RunState,
  started: number,
): Promise<RenderedPage> {
  markSending(state, ref);
  const maxChars = effectiveMaxChars(req.maxChars, ctx.config);
  const ceiling = ctx.config.maxInlineCharsCeiling;
  const threshold = ctx.config.spoolThresholdBytes;
  const fieldsByIndex = new Map<number, StreamField[]>();
  const counts = new Map<number, number>();
  const sets: { current: ResultSetState | null } = { current: null };

  const makeSet = (index: number, fields: StreamField[]): ResultSetState => {
    const columns = columnsFromFields(fields);
    return {
      index,
      columns,
      builder: new PageBuilder({ format: req.format, columns, maxRows: req.maxRows, maxChars, ceiling }),
      total: 0,
      pageClosed: false,
      spool: null,
      pending: [],
      abandoned: null,
    };
  };

  const retire = (s: ResultSetState): void => {
    s.pending = [];
    if (s.spool) ctx.results.discard(s.spool);
    s.spool = null;
  };

  const flushSpool = async (s: ResultSetState): Promise<void> => {
    if (s.abandoned || s.pending.length === 0) return;
    const rows = s.pending;
    s.pending = [];
    try {
      if (!s.spool) {
        s.spool = await ctx.results.createSpool(s.columns, { totalRows: null, capBytes: threshold });
        if (!s.spool) {
          s.abandoned = 'unavailable';
          return;
        }
        await s.spool.append(s.builder.rows);
      }
      await s.spool.append(rows);
    } catch (err) {
      s.abandoned = err instanceof SpoolLimitError && err.reason === 'too-large' ? 'too-large' : 'unavailable';
      if (s.spool) ctx.results.discard(s.spool);
      s.spool = null;
    }
  };

  const pump = new RowPump(
    (row, index) => {
      let s = sets.current;
      if (!s || s.index !== index) {
        // Only the last result set that has columns is kept.
        if (s) retire(s);
        s = makeSet(index, fieldsByIndex.get(index) ?? []);
        sets.current = s;
      }
      s.total++;
      counts.set(index, s.total);
      if (!s.pageClosed) {
        if (s.builder.tryAdd(row)) return;
        s.pageClosed = true;
      }
      if (s.abandoned) return;
      s.pending.push(row);
      if (s.pending.length >= SPOOL_BATCH_ROWS) return flushSpool(s);
    },
    { highWater: SPOOL_BATCH_ROWS, onError: () => void lease.cancel() },
  );

  let results: StreamStatementResult[];
  try {
    const outcome = await streamQuery(
      lease,
      text,
      {
        onResultSet: (fields, index) => { fieldsByIndex.set(index, fields); },
        onRow: (row, index, control) => {
          state.noRetry = true;
          pump.push(row, index, control);
        },
      },
      guardOf(req),
    );
    await pump.flush();
    results = outcome.results;
  } catch (err) {
    await pump.flush().catch(() => undefined);
    if (sets.current) retire(sets.current);
    throw pump.hasFailed ? pump.error : err;
  }

  let shown = -1;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].fields.length > 0) {
      shown = i;
      break;
    }
  }
  // The statement whose result is shown: the last one with columns, else the last statement.
  const displayed = shown !== -1 ? shown : results.length - 1;
  const others = [...statements];
  results.forEach((r, i) => {
    if (i !== displayed) others.push(summarizeStatement(r, r.streamedIndex === null ? 0 : counts.get(r.streamedIndex) ?? 0));
  });

  if (shown === -1) {
    if (sets.current) retire(sets.current);
    const last = results[results.length - 1];
    return new PageBuilder({ format: req.format, columns: [], maxRows: req.maxRows, maxChars, ceiling }).render({
      mode: 'run', offset: 0, totalRows: 0, hasMore: false, resultId: null,
      executionTimeMs: Date.now() - started, statements: others,
      command: last?.command || undefined, rowsAffected: last?.rowCount ?? 0,
    });
  }

  const result = results[shown];
  let set: ResultSetState;
  if (sets.current && result.streamedIndex === sets.current.index) {
    set = sets.current;
  } else {
    if (sets.current) retire(sets.current);
    set = makeSet(-1, result.fields);
  }
  await flushSpool(set);
  await resolveColumnTypes(typeLookupOn(lease), set.columns);

  const hasMore = set.total > set.builder.count;
  const meta: PageMeta = {
    mode: 'run', offset: 0, totalRows: set.total, hasMore, resultId: null,
    executionTimeMs: 0, statements: others,
  };
  if (hasMore && set.spool && !set.abandoned) {
    set.spool.finish();
    set.spool.position = set.builder.count;
    meta.resultId = set.spool.id;
  } else {
    if (set.spool) retire(set);
    if (hasMore) meta.pagingUnavailable = set.abandoned ?? 'unavailable';
  }
  meta.executionTimeMs = Date.now() - started;
  return set.builder.render(meta);
}

/**
 * Renders a buffered result (catalog tools) with the page budget. Rows beyond the page are
 * spooled from memory, so a large catalog pages like any other result.
 */
export async function renderBuffered(
  result: BufferedResult,
  req: { format: Format; maxRows: number; maxChars: number },
  ctx: RunContext,
): Promise<RenderedPage> {
  const columns = columnsFromFields(result.fields);
  const builder = new PageBuilder({
    format: req.format,
    columns,
    maxRows: req.maxRows,
    maxChars: effectiveMaxChars(req.maxChars, ctx.config),
    ceiling: ctx.config.maxInlineCharsCeiling,
  });
  if (columns.length === 0) {
    return builder.render({
      mode: 'run', offset: 0, totalRows: 0, hasMore: false, resultId: null,
      executionTimeMs: result.executionTime, command: result.command || undefined, rowsAffected: result.rowCount,
    });
  }
  let used = 0;
  while (used < result.rows.length && builder.tryAdd(result.rows[used])) used++;
  const total = result.rows.length;
  const meta: PageMeta = {
    mode: 'run', offset: 0, totalRows: total, hasMore: used < total, resultId: null,
    executionTimeMs: result.executionTime,
  };
  if (!meta.hasMore) return builder.render(meta);
  const session = await ctx.results.createSpool(columns, {
    totalRows: total,
    reserveBytes: estimateSpoolBytes(result.rows, total, null) ?? 0,
  });
  if (!session) return builder.render({ ...meta, pagingUnavailable: 'unavailable' });
  session.position = builder.count;
  void spoolRows(session, result.rows);
  return builder.render({ ...meta, resultId: session.id });
}

async function spoolRows(session: SpoolSession, rows: unknown[][]): Promise<void> {
  try {
    for (let i = 0; i < rows.length; i += 5_000) await session.append(rows.slice(i, i + 5_000));
    session.finish();
  } catch (err) {
    session.fail(err);
  }
}
