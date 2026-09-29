"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newSqlProgress = newSqlProgress;
exports.markSending = markSending;
exports.statementRef = statementRef;
exports.wholeRef = wholeRef;
exports.annotateSqlError = annotateSqlError;
exports.summarizeStatement = summarizeStatement;
exports.estimateSpoolBytes = estimateSpoolBytes;
exports.runQuery = runQuery;
exports.renderBuffered = renderBuffered;
const classify_1 = require("./sql/classify");
const pool_1 = require("./db/pool");
const lease_1 = require("./db/lease");
const engine_1 = require("./db/engine");
const cursor_1 = require("./db/cursor");
const context_1 = require("./errors/context");
const stream_1 = require("./db/stream");
const page_1 = require("./results/page");
const values_1 = require("./results/values");
const store_1 = require("./results/store");
function newSqlProgress() {
    return { noRetry: false, sentCount: 0, sentThisAttempt: false, completed: [], current: null };
}
/** Records that `statement` is about to be sent. Data-changing SQL is never re-sent after a lost connection. */
function markSending(state, ref) {
    state.current = ref;
    if (!state.sentThisAttempt) {
        state.sentThisAttempt = true;
        state.sentCount++;
    }
    if ((0, classify_1.mayChangeData)(ref.text))
        state.noRetry = true;
}
function statementRef(statement, index, shift = 0) {
    return { text: statement.text, offset: statement.offset, shift, index };
}
/** The whole text, sent as one request. */
function wholeRef(sql) {
    return { text: sql, offset: 0, shift: 0, index: null };
}
/** Adds what the call had done to its final error, for the error description. */
function annotateSqlError(err, sql, plan, state, operation) {
    (0, context_1.annotate)(err, { phase: 'query' });
    return (0, context_1.setContext)(err, {
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
const SPOOL_BATCH_ROWS = 1000;
const COUNTED_COMMANDS = /^(INSERT|UPDATE|DELETE|MERGE|COPY|SELECT|MOVE|FETCH)$/;
function summarizeStatement(result, streamedRows) {
    const command = result.command || 'OK';
    if (result.fields.length > 0)
        return `${command} (${streamedRows} rows)`;
    if (typeof result.rowCount === 'number' && COUNTED_COMMANDS.test(command))
        return `${command} (${result.rowCount} rows)`;
    return command;
}
/** Expected spool size: the average JSON line size of `sample` times the total (or the engine's byte count, if larger). */
function estimateSpoolBytes(sample, totalRows, totalBytes) {
    if (totalRows === null)
        return null;
    const n = Math.min(sample.length, 5000);
    let sum = 0;
    for (let i = 0; i < n; i++)
        sum += JSON.stringify(sample[i]).length + 1;
    const perRow = n > 0 ? sum / n : 0;
    return Math.max(Math.ceil(perRow * totalRows), totalBytes ?? 0);
}
function guardOf(req, signal) {
    return { signal: signal ?? req.signal, timeoutMs: req.timeoutMs > 0 ? req.timeoutMs : undefined };
}
function effectiveMaxChars(maxChars, config) {
    return Math.max(1, Math.min(maxChars, config.maxInlineCharsCeiling));
}
async function runQuery(req, ctx) {
    const plan = (0, classify_1.planScript)(req.sql);
    if (plan.complete && plan.statements.length === 0)
        throw new classify_1.EmptySqlError();
    const started = Date.now();
    const state = newSqlProgress();
    try {
        return await (0, pool_1.withConnectionRetry)(async (pool) => {
            state.sentThisAttempt = false;
            state.completed = [];
            state.current = null;
            req.progress?.phase('waiting for a database connection');
            const lease = await lease_1.Lease.acquire(pool, { signal: req.signal });
            const hand = { off: false };
            try {
                if (plan.changesSession)
                    lease.markDiscard();
                const engine = await (0, engine_1.detectEngine)(pool, lease);
                req.progress?.phase('query running on the database');
                if (!plan.complete || plan.hasTransactionControl) {
                    // Run the text as written, in one request, then discard the connection if it changed state.
                    if (plan.isScript)
                        state.noRetry = true;
                    return await streamPath(lease, req.sql, wholeRef(req.sql), [], req, ctx, state, started);
                }
                const statements = await runPrefix(lease, plan, req, state);
                const last = plan.last;
                const lastIndex = plan.statements.length;
                if (last.kind === 'rows') {
                    try {
                        return await cursorPath(lease, engine, last, lastIndex, statements, req, ctx, state, started, hand);
                    }
                    catch (err) {
                        if (!(err instanceof cursor_1.DeclareRejectedError))
                            throw err;
                        // DECLARE doesn't execute the query, so running it without a cursor is safe.
                    }
                }
                return await streamPath(lease, last.text, statementRef(last, lastIndex), statements, req, ctx, state, started);
            }
            catch (err) {
                if ((0, pool_1.isConnectionLevelError)(err))
                    lease.markDiscard();
                throw err;
            }
            finally {
                if (!hand.off)
                    lease.release();
            }
        }, { canRetry: () => !state.noRetry });
    }
    catch (err) {
        throw annotateSqlError(err, req.sql, plan, state, req.operation ?? 'run_query');
    }
}
async function runPrefix(lease, plan, req, state) {
    const summaries = [];
    const guard = guardOf(req);
    for (const [i, statement] of plan.prefix.entries()) {
        const counts = new Map();
        markSending(state, statementRef(statement, i + 1));
        const outcome = await (0, stream_1.streamQuery)(lease, statement.text, { onRow: (_row, index) => { counts.set(index, (counts.get(index) ?? 0) + 1); } }, guard);
        state.noRetry = true;
        for (const r of outcome.results)
            summaries.push(summarizeStatement(r, r.streamedIndex === null ? 0 : counts.get(r.streamedIndex) ?? 0));
        state.completed = [...summaries];
    }
    return summaries;
}
async function cursorPath(lease, engine, statement, index, statements, req, ctx, state, started, hand) {
    const guard = guardOf(req);
    markSending(state, statementRef(statement, index, (0, cursor_1.declarePrefix)(engine).length));
    const reader = await cursor_1.CursorReader.open(lease, statement.text, engine, guard);
    try {
        const batch = (0, engine_1.fetchBatchSize)(ctx.config.fetchBatchRows, engine);
        // The first FETCH waits for the query to finish.
        let carry = await reader.fetch(Math.min(batch, req.maxRows + 1), guard);
        state.noRetry = true;
        const columns = (0, values_1.columnsFromFields)(reader.fields ?? []);
        await (0, engine_1.resolveColumnTypes)((0, engine_1.typeLookupOn)(lease), columns);
        req.progress?.phase('reading rows');
        const builder = new page_1.PageBuilder({
            format: req.format,
            columns,
            maxRows: req.maxRows,
            maxChars: effectiveMaxChars(req.maxChars, ctx.config),
            ceiling: ctx.config.maxInlineCharsCeiling,
        });
        let used = 0;
        for (;;) {
            while (used < carry.length && builder.tryAdd(carry[used]))
                used++;
            if (used < carry.length || reader.exhausted)
                break;
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
        let totals = { totalRows: null, totalBytes: null };
        try {
            totals = await (0, engine_1.cursorTotals)(lease, engine, reader.fetchedRows, guard);
        }
        catch (err) {
            if (err instanceof lease_1.QueryCancelledError || err instanceof lease_1.QueryTimeoutError)
                throw err;
            if ((0, pool_1.isConnectionLevelError)(err))
                lease.markDiscard();
            console.error(`[run_query] could not get the result total: ${err instanceof Error ? err.message : String(err)}`);
            // The cursor's transaction may be unusable now: return the page without paging.
            return builder.render({
                mode: 'run', offset: 0, totalRows: null, hasMore: true, resultId: null, pagingUnavailable: 'unavailable',
                executionTimeMs: Date.now() - started, statements,
            });
        }
        const meta = {
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
        const pagingUnavailable = ctx.config.maxOpenCursors > 0 ? 'busy' : 'too-large';
        return builder.render({ ...meta, pagingUnavailable, executionTimeMs: Date.now() - started });
    }
    finally {
        if (!hand.off && reader.isOpen)
            await reader.abort();
    }
}
/** Background task: writes the rest of a cursor's rows to its spool, then releases the connection. */
async function spoolFromCursor(session, lease, reader, initial, batch, timeoutMs) {
    try {
        await session.append(initial);
        const guard = { signal: session.signal, timeoutMs: timeoutMs > 0 ? timeoutMs : undefined };
        while (!reader.exhausted) {
            const rows = await reader.fetch(batch, guard);
            if (rows.length)
                await session.append(rows);
        }
        await reader.close();
        session.finish();
    }
    catch (err) {
        session.fail(err);
        if ((0, pool_1.isConnectionLevelError)(err))
            lease.markDiscard();
        await reader.abort().catch(() => undefined);
    }
    finally {
        lease.release();
    }
}
async function streamPath(lease, text, ref, statements, req, ctx, state, started) {
    markSending(state, ref);
    const maxChars = effectiveMaxChars(req.maxChars, ctx.config);
    const ceiling = ctx.config.maxInlineCharsCeiling;
    const threshold = ctx.config.spoolThresholdBytes;
    const fieldsByIndex = new Map();
    const counts = new Map();
    const sets = { current: null };
    const makeSet = (index, fields) => {
        const columns = (0, values_1.columnsFromFields)(fields);
        return {
            index,
            columns,
            builder: new page_1.PageBuilder({ format: req.format, columns, maxRows: req.maxRows, maxChars, ceiling }),
            total: 0,
            pageClosed: false,
            spool: null,
            pending: [],
            abandoned: null,
        };
    };
    const retire = (s) => {
        s.pending = [];
        if (s.spool)
            ctx.results.discard(s.spool);
        s.spool = null;
    };
    const flushSpool = async (s) => {
        if (s.abandoned || s.pending.length === 0)
            return;
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
        }
        catch (err) {
            s.abandoned = err instanceof store_1.SpoolLimitError && err.reason === 'too-large' ? 'too-large' : 'unavailable';
            if (s.spool)
                ctx.results.discard(s.spool);
            s.spool = null;
        }
    };
    const pump = new stream_1.RowPump((row, index) => {
        let s = sets.current;
        if (!s || s.index !== index) {
            // Only the last result set that has columns is kept.
            if (s)
                retire(s);
            s = makeSet(index, fieldsByIndex.get(index) ?? []);
            sets.current = s;
        }
        s.total++;
        counts.set(index, s.total);
        if (!s.pageClosed) {
            if (s.builder.tryAdd(row))
                return;
            s.pageClosed = true;
        }
        if (s.abandoned)
            return;
        s.pending.push(row);
        if (s.pending.length >= SPOOL_BATCH_ROWS)
            return flushSpool(s);
    }, { highWater: SPOOL_BATCH_ROWS, onError: () => void lease.cancel() });
    let results;
    try {
        const outcome = await (0, stream_1.streamQuery)(lease, text, {
            onResultSet: (fields, index) => { fieldsByIndex.set(index, fields); },
            onRow: (row, index, control) => {
                state.noRetry = true;
                pump.push(row, index, control);
            },
        }, guardOf(req));
        await pump.flush();
        results = outcome.results;
    }
    catch (err) {
        await pump.flush().catch(() => undefined);
        if (sets.current)
            retire(sets.current);
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
        if (i !== displayed)
            others.push(summarizeStatement(r, r.streamedIndex === null ? 0 : counts.get(r.streamedIndex) ?? 0));
    });
    if (shown === -1) {
        if (sets.current)
            retire(sets.current);
        const last = results[results.length - 1];
        return new page_1.PageBuilder({ format: req.format, columns: [], maxRows: req.maxRows, maxChars, ceiling }).render({
            mode: 'run', offset: 0, totalRows: 0, hasMore: false, resultId: null,
            executionTimeMs: Date.now() - started, statements: others,
            command: last?.command || undefined, rowsAffected: last?.rowCount ?? 0,
        });
    }
    const result = results[shown];
    let set;
    if (sets.current && result.streamedIndex === sets.current.index) {
        set = sets.current;
    }
    else {
        if (sets.current)
            retire(sets.current);
        set = makeSet(-1, result.fields);
    }
    await flushSpool(set);
    await (0, engine_1.resolveColumnTypes)((0, engine_1.typeLookupOn)(lease), set.columns);
    const hasMore = set.total > set.builder.count;
    const meta = {
        mode: 'run', offset: 0, totalRows: set.total, hasMore, resultId: null,
        executionTimeMs: 0, statements: others,
    };
    if (hasMore && set.spool && !set.abandoned) {
        set.spool.finish();
        set.spool.position = set.builder.count;
        meta.resultId = set.spool.id;
    }
    else {
        if (set.spool)
            retire(set);
        if (hasMore)
            meta.pagingUnavailable = set.abandoned ?? 'unavailable';
    }
    meta.executionTimeMs = Date.now() - started;
    return set.builder.render(meta);
}
/**
 * Renders a buffered result (catalog tools) with the page budget. Rows beyond the page are
 * spooled from memory, so a large catalog pages like any other result.
 */
async function renderBuffered(result, req, ctx) {
    const columns = (0, values_1.columnsFromFields)(result.fields);
    const builder = new page_1.PageBuilder({
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
    while (used < result.rows.length && builder.tryAdd(result.rows[used]))
        used++;
    const total = result.rows.length;
    const meta = {
        mode: 'run', offset: 0, totalRows: total, hasMore: used < total, resultId: null,
        executionTimeMs: result.executionTime,
    };
    if (!meta.hasMore)
        return builder.render(meta);
    const session = await ctx.results.createSpool(columns, {
        totalRows: total,
        reserveBytes: estimateSpoolBytes(result.rows, total, null) ?? 0,
    });
    if (!session)
        return builder.render({ ...meta, pagingUnavailable: 'unavailable' });
    session.position = builder.count;
    void spoolRows(session, result.rows);
    return builder.render({ ...meta, resultId: session.id });
}
async function spoolRows(session, rows) {
    try {
        for (let i = 0; i < rows.length; i += 5000)
            await session.append(rows.slice(i, i + 5000));
        session.finish();
    }
    catch (err) {
        session.fail(err);
    }
}
