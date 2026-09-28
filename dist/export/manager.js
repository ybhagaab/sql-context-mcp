"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportManager = exports.ExportJob = void 0;
exports.exportResult = exportResult;
exports.exportStatus = exportStatus;
exports.exportProgress = exportProgress;
/**
 * Export manager (design Component 9): runs export_query jobs.
 *
 * - A first-in, first-out queue with SQL_EXPORT_CONCURRENCY jobs running at once.
 * - Each job streams its query without a cursor (so the database's cursor size limits don't
 *   apply), converts every row exactly and writes it to `<name>.part`. When the file stream needs
 *   to drain, the database socket is paused until it does, so memory stays bounded however slow
 *   the disk is.
 * - There is no row or size limit by default. Optional caps (per call, or SQL_EXPORT_MAX_ROWS and
 *   SQL_EXPORT_MAX_BYTES) stop the export and mark it truncated. The free-space reserve stops it
 *   before the disk fills.
 * - On success the file is renamed to its final name, next to a `<file>.schema.json` sidecar. On
 *   failure or cancellation the query is cancelled, the connection is discarded and the `.part`
 *   file is deleted.
 */
const fs = __importStar(require("fs"));
const crypto_1 = require("crypto");
const store_1 = require("../files/store");
const classify_1 = require("../sql/classify");
const pool_1 = require("../db/pool");
const lease_1 = require("../db/lease");
const stream_1 = require("../db/stream");
const engine_1 = require("../db/engine");
const values_1 = require("../results/values");
const writers_1 = require("./writers");
const PREVIEW_ROWS = 10;
function describe(err) {
    return err instanceof Error ? err.message : String(err);
}
function sleep(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
    });
}
function minCap(a, b) {
    if (a === undefined || a === null)
        return b;
    return b === null ? a : Math.min(a, b);
}
class ExportJob {
    constructor(id, request, paths) {
        this.id = id;
        this.request = request;
        this.paths = paths;
        this.state = 'queued';
        this.rowsWritten = 0;
        this.bytesWritten = 0;
        this.truncated = false;
        this.columns = [];
        /** First rows, raw (converted when shown). */
        this.preview = [];
        this.queuedAt = Date.now();
        this.startedAt = null;
        this.finishedAt = null;
        this.error = null;
        this.controller = new AbortController();
        this.settleDone = () => undefined;
        this.done = new Promise((resolve) => {
            this.settleDone = resolve;
        });
    }
    get format() {
        return this.request.format;
    }
    get signal() {
        return this.controller.signal;
    }
    get isFinished() {
        return this.state === 'done' || this.state === 'failed' || this.state === 'cancelled';
    }
    _abort() {
        this.controller.abort();
    }
    _settle() {
        this.settleDone();
    }
    /** Exact values of the preview rows. */
    previewValues() {
        return this.preview.map((row) => this.columns.map((c, i) => (0, values_1.toExact)(row[i], c.oid)));
    }
}
exports.ExportJob = ExportJob;
class ExportManager {
    constructor(files, config, opts = {}) {
        this.files = files;
        this.config = config;
        this.opts = opts;
        this.jobs = new Map();
        this.queue = [];
        this.running = 0;
        this.closing = false;
        /** Largest number of rows any export queued in memory at once (memory-bound tests). */
        this.peakQueuedRows = 0;
    }
    get runningCount() {
        return this.running;
    }
    get(id) {
        return this.jobs.get(id);
    }
    list() {
        return [...this.jobs.values()];
    }
    /** 1-based position in the queue, or null when the job isn't queued. */
    queuePosition(job) {
        const index = this.queue.indexOf(job);
        return index === -1 ? null : index + 1;
    }
    async submit(request) {
        if (this.closing)
            throw new Error('The server is shutting down; the export was not started.');
        const plan = (0, classify_1.planScript)(request.sql);
        if (plan.complete && plan.statements.length === 0)
            throw new classify_1.EmptySqlError();
        await this.files.ensureDirs();
        const paths = this.files.newExportPaths(request.fileName, request.format);
        let id;
        do
            id = `e_${(0, store_1.randomBase32)(16)}`;
        while (this.jobs.has(id));
        const job = new ExportJob(id, request, paths);
        this.jobs.set(id, job);
        this.queue.push(job);
        this.pump();
        return job;
    }
    /** Cancels a queued or running job and waits (briefly) for it to finish. */
    async cancel(job) {
        if (job.isFinished)
            return;
        const index = this.queue.indexOf(job);
        if (index !== -1) {
            this.queue.splice(index, 1);
            job.state = 'cancelled';
            job.error = 'The export was cancelled before it started.';
            job.finishedAt = Date.now();
            job._settle();
            return;
        }
        job._abort();
        await Promise.race([job.done, sleep(10000)]);
    }
    /** Waits for `job` to finish. Aborting `signal` cancels the job. */
    async wait(job, signal) {
        if (!signal)
            return job.done;
        if (signal.aborted) {
            await this.cancel(job);
            return;
        }
        const onAbort = () => {
            void this.cancel(job);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            await job.done;
        }
        finally {
            signal.removeEventListener('abort', onAbort);
        }
    }
    /** Server shutdown: cancels every queued and running job. */
    async closeAll() {
        this.closing = true;
        const open = [...this.jobs.values()].filter((j) => !j.isFinished);
        await Promise.allSettled(open.map((j) => this.cancel(j)));
    }
    pump() {
        while (!this.closing && this.running < this.config.exportConcurrency && this.queue.length > 0) {
            const job = this.queue.shift();
            this.running++;
            void this.run(job).finally(() => {
                this.running--;
                this.pump();
            });
        }
    }
    async run(job) {
        job.state = 'running';
        job.startedAt = Date.now();
        const holder = { writer: null };
        try {
            if (job.signal.aborted)
                throw new lease_1.QueryCancelledError();
            const guard = new store_1.FreeSpaceGuard(this.files.exportsDir, this.config.exportMinFreeBytes, {
                statfs: this.opts.statfs,
                checkEveryBytes: this.opts.freeSpaceCheckEveryBytes,
            });
            await guard.check();
            await this.execute(job, guard, holder);
            const writer = holder.writer;
            if (!writer)
                throw new Error('The export produced no file.');
            await writer.finish();
            holder.writer = null;
            job.bytesWritten = writer.bytes;
            await (0, store_1.writePrivateFile)(job.paths.schemaPath, `${JSON.stringify(this.sidecar(job), null, 2)}\n`);
            await fs.promises.rename(job.paths.partPath, job.paths.finalPath);
            job.state = 'done';
        }
        catch (err) {
            if (holder.writer)
                await holder.writer.destroy().catch(() => undefined);
            await fs.promises.rm(job.paths.partPath, { force: true }).catch(() => undefined);
            await fs.promises.rm(job.paths.schemaPath, { force: true }).catch(() => undefined);
            const cancelled = job.signal.aborted || err instanceof lease_1.QueryCancelledError;
            job.state = cancelled ? 'cancelled' : 'failed';
            job.error = cancelled ? 'The export was cancelled.' : describe(err);
        }
        finally {
            job.finishedAt = Date.now();
            job._settle();
        }
    }
    sidecar(job) {
        return {
            columns: job.columns.map((c) => ({ name: c.name, type: c.type, oid: c.oid })),
            rowCount: job.rowsWritten,
            bytes: job.bytesWritten,
            format: job.format,
            truncated: job.truncated,
            createdAt: new Date().toISOString(),
            sqlSha256: (0, crypto_1.createHash)('sha256').update(job.request.sql).digest('hex'),
        };
    }
    async execute(job, guard, holder) {
        const plan = (0, classify_1.planScript)(job.request.sql);
        const whole = !plan.complete || plan.hasTransactionControl;
        const state = { noRetry: false };
        const maxRows = minCap(job.request.maxRows, this.config.exportMaxRows);
        const maxBytes = minCap(job.request.maxBytes, this.config.exportMaxBytes);
        const timeoutMs = job.request.timeoutMs ?? this.config.statementTimeoutMs;
        const guardOpts = { signal: job.signal, timeoutMs: timeoutMs > 0 ? timeoutMs : undefined };
        const openWriter = this.opts.openWriter ?? ((file, format) => writers_1.FileRowWriter.open(file, format));
        await (0, pool_1.withConnectionRetry)(async (pool) => {
            // A retry starts the file again.
            if (holder.writer) {
                await holder.writer.destroy();
                holder.writer = null;
            }
            job.rowsWritten = 0;
            job.bytesWritten = 0;
            job.preview = [];
            job.truncated = false;
            job.columns = [];
            const lease = await lease_1.Lease.acquire(pool, { signal: job.signal });
            try {
                if (plan.changesSession)
                    lease.markDiscard();
                let text = job.request.sql;
                if (!whole) {
                    for (const statement of plan.prefix) {
                        await (0, stream_1.streamQuery)(lease, statement.text, { onRow: () => undefined }, guardOpts);
                        state.noRetry = true;
                    }
                    text = plan.last.text;
                }
                else if (plan.isScript) {
                    state.noRetry = true;
                }
                holder.writer = await openWriter(job.paths.partPath, job.format);
                const fieldsByIndex = new Map();
                let currentIndex = -1;
                let stopped = false;
                const start = (columns) => {
                    job.columns = columns;
                    holder.writer.begin(columns);
                    job.bytesWritten = holder.writer.bytes;
                };
                // A later result set replaces an earlier one (transaction-control scripts): start the file again.
                const restart = async (columns) => {
                    if (holder.writer)
                        await holder.writer.destroy();
                    holder.writer = null;
                    holder.writer = await openWriter(job.paths.partPath, job.format);
                    job.rowsWritten = 0;
                    job.preview = [];
                    job.truncated = false;
                    start(columns);
                };
                const stop = () => {
                    if (stopped)
                        return;
                    stopped = true;
                    job.truncated = true;
                    lease.markDiscard();
                    void lease.cancel();
                };
                const write = (row) => {
                    const writer = holder.writer;
                    if (maxRows !== null && job.rowsWritten >= maxRows)
                        return stop();
                    const line = writer.encode(row);
                    if (maxBytes !== null && writer.bytes + Buffer.byteLength(line) > maxBytes)
                        return stop();
                    const ok = writer.writeLine(line);
                    job.rowsWritten++;
                    job.bytesWritten = writer.bytes;
                    if (job.preview.length < PREVIEW_ROWS)
                        job.preview.push(row);
                    if (!ok) {
                        return writer.drain().then(() => (guard.isDue(writer.bytes) ? guard.maybeCheck(writer.bytes) : undefined));
                    }
                    if (guard.isDue(writer.bytes))
                        return guard.maybeCheck(writer.bytes);
                    return undefined;
                };
                const pump = new stream_1.RowPump((row, index) => {
                    if (stopped)
                        return undefined;
                    if (index !== currentIndex) {
                        const first = currentIndex === -1;
                        currentIndex = index;
                        const columns = (0, values_1.columnsFromFields)(fieldsByIndex.get(index) ?? []);
                        if (first) {
                            start(columns);
                            return write(row);
                        }
                        return restart(columns).then(() => write(row));
                    }
                    return write(row);
                }, { highWater: this.opts.highWater ?? 1000, onError: () => void lease.cancel() });
                let results = null;
                try {
                    const outcome = await (0, stream_1.streamQuery)(lease, text, {
                        onResultSet: (fields, index) => { fieldsByIndex.set(index, fields); },
                        onRow: (row, index, control) => {
                            state.noRetry = true;
                            pump.push(row, index, control);
                        },
                    }, guardOpts);
                    results = outcome.results;
                    await pump.flush();
                }
                catch (err) {
                    await pump.flush().catch(() => undefined);
                    if (pump.hasFailed)
                        throw pump.error;
                    // Stopped at a cap: the cancellation that follows is expected.
                    if (!stopped || job.signal.aborted)
                        throw err;
                }
                finally {
                    this.peakQueuedRows = Math.max(this.peakQueuedRows, pump.peakQueued);
                }
                if (!stopped && results) {
                    // The export is the last result set that has columns.
                    let shown = null;
                    for (let i = results.length - 1; i >= 0; i--) {
                        if (results[i].fields.length > 0) {
                            shown = results[i];
                            break;
                        }
                    }
                    if (!shown) {
                        throw new Error('The SQL returned no rows to export: export_query writes the result of the last statement that returns rows.');
                    }
                    if (currentIndex === -1)
                        start((0, values_1.columnsFromFields)(shown.fields));
                    else if (shown.streamedIndex !== currentIndex)
                        await restart((0, values_1.columnsFromFields)(shown.fields));
                }
                await (0, engine_1.resolveColumnTypes)((0, engine_1.typeLookupOn)(lease), job.columns).catch(() => undefined);
            }
            catch (err) {
                if ((0, pool_1.isConnectionLevelError)(err))
                    lease.markDiscard();
                throw err;
            }
            finally {
                lease.release();
            }
        }, { canRetry: () => !state.noRetry && job.rowsWritten === 0 });
    }
}
exports.ExportManager = ExportManager;
/** The result of a finished export, as shown to callers. `clean` sanitizes inline strings. */
function exportResult(job, clean) {
    return {
        exportId: job.id,
        state: job.state,
        path: job.paths.finalPath,
        schemaPath: job.paths.schemaPath,
        format: job.format,
        rowCount: job.rowsWritten,
        bytes: job.bytesWritten,
        truncated: job.truncated,
        durationMs: (job.finishedAt ?? Date.now()) - (job.startedAt ?? job.queuedAt),
        columns: job.columns.map((c) => ({ name: clean(c.name), type: clean(c.type) })),
        preview: job.previewValues().map((row) => row.map((v) => (typeof v === 'string' ? clean(v) : v))),
    };
}
/** Status of any job, as shown by export_status. */
function exportStatus(job, manager, clean) {
    const status = {
        exportId: job.id,
        state: job.state,
        rowsWritten: job.rowsWritten,
        bytesWritten: job.bytesWritten,
        elapsedMs: (job.finishedAt ?? Date.now()) - job.queuedAt,
    };
    if (job.state === 'queued')
        status.queuePosition = manager.queuePosition(job);
    if (job.state === 'done')
        Object.assign(status, exportResult(job, clean));
    if (job.state === 'failed' || job.state === 'cancelled')
        status.error = job.error;
    return status;
}
/** Progress for a job, for MCP progress notifications. */
function exportProgress(job, manager) {
    if (job.state === 'queued')
        return { message: `waiting in the export queue (position ${manager.queuePosition(job) ?? 1})` };
    if (job.rowsWritten === 0)
        return { message: 'query running on the database' };
    return { message: 'exporting', rows: job.rowsWritten, bytes: job.bytesWritten };
}
