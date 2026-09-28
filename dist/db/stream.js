"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RowPump = void 0;
exports.streamQuery = streamQuery;
/**
 * Streaming executor (design Component 5b).
 *
 * Runs SQL text (one statement or a script) with pg's `Query` in row-event mode: submitted with a
 * `row` listener and no callback, pg does not collect rows, so memory stays bounded whatever the
 * result size. Rows are delivered as raw wire text in arrays. Consumers apply backpressure by
 * pausing the database socket (TCP flow control then slows the server) and resuming it later.
 *
 * No cursor is used, so the database's cursor size limits don't apply (this is why exports use
 * this executor).
 */
const pg_1 = require("pg");
const values_1 = require("../results/values");
/**
 * Processes streamed rows in order, with bounded memory.
 *
 * Processing may return a promise (for example while a file drains or a spool write completes).
 * Rows that arrive meanwhile are queued; once `highWater` rows are queued the database socket is
 * paused, and it resumes when the queue has been worked down. TCP flow control then slows the
 * database side, so rows never pile up in memory.
 *
 * A processing error stops the pump: later rows are dropped, `onError` is called once (callers use
 * it to cancel the query), and `flush()` rejects with that error.
 */
class RowPump {
    constructor(processRow, opts = {}) {
        this.processRow = processRow;
        this.opts = opts;
        this.queue = [];
        this.head = 0;
        this.running = false;
        this.paused = false;
        this.control = null;
        this.failed = false;
        this.failure = null;
        this.waiters = [];
        /** Largest number of rows queued at once (used by memory-bound tests). */
        this.peakQueued = 0;
        this.highWater = Math.max(1, opts.highWater ?? 1000);
    }
    get hasFailed() {
        return this.failed;
    }
    get error() {
        return this.failed ? this.failure : null;
    }
    push(row, index, control) {
        if (this.failed)
            return;
        this.control = control;
        this.queue.push({ row, index });
        const queued = this.queue.length - this.head;
        if (queued > this.peakQueued)
            this.peakQueued = queued;
        if (!this.paused && queued >= this.highWater) {
            this.paused = true;
            control.pause();
        }
        if (!this.running)
            this.run();
    }
    /** Resolves once every pushed row has been processed; rejects with the processing error. */
    flush() {
        if (this.failed)
            return Promise.reject(this.failure);
        if (!this.running && this.head >= this.queue.length)
            return Promise.resolve();
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    run() {
        this.running = true;
        const step = () => {
            try {
                while (this.head < this.queue.length) {
                    const item = this.queue[this.head++];
                    if (this.head > 4096 && this.head * 2 > this.queue.length) {
                        this.queue = this.queue.slice(this.head);
                        this.head = 0;
                    }
                    const result = this.processRow(item.row, item.index);
                    if (result && typeof result.then === 'function') {
                        result.then(() => {
                            this.maybeResume(false);
                            step();
                        }, (err) => this.fail(err));
                        return;
                    }
                }
            }
            catch (err) {
                this.fail(err);
                return;
            }
            this.queue = [];
            this.head = 0;
            this.running = false;
            this.maybeResume(true);
            this.settle();
        };
        step();
    }
    maybeResume(idle) {
        if (!this.paused || !this.control)
            return;
        if (idle || this.queue.length - this.head < this.highWater / 2) {
            this.paused = false;
            this.control.resume();
        }
    }
    fail(err) {
        if (this.failed)
            return;
        this.failed = true;
        this.failure = err;
        this.queue = [];
        this.head = 0;
        this.running = false;
        // Let the stream reach its end or its cancellation error.
        this.maybeResume(true);
        try {
            this.opts.onError?.(err);
        }
        catch {
            // ignore
        }
        this.settle();
    }
    settle() {
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) {
            if (this.failed)
                w.reject(this.failure);
            else
                w.resolve();
        }
    }
}
exports.RowPump = RowPump;
function fieldsOf(result) {
    const fields = result?.fields ?? [];
    return fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
}
function streamQuery(lease, text, handlers, opts = {}) {
    const control = {
        pause: () => lease.pauseSocket(),
        resume: () => lease.resumeSocket(),
    };
    return lease.guard(() => new Promise((resolve, reject) => {
        const query = new pg_1.Query({ text, rowMode: 'array', types: values_1.RAW_TYPES });
        const indexOf = new Map();
        let current = null;
        let nextIndex = 0;
        query.on('row', (row, result) => {
            if (result !== current) {
                current = result;
                const index = nextIndex++;
                indexOf.set(result, index);
                handlers.onResultSet?.(fieldsOf(result), index);
            }
            handlers.onRow(row, indexOf.get(result), control);
        });
        query.on('end', (res) => {
            const list = Array.isArray(res) ? res : [res];
            resolve({
                results: list.map((r) => ({
                    command: String(r?.command ?? ''),
                    rowCount: typeof r?.rowCount === 'number' ? (r.rowCount) : null,
                    fields: fieldsOf(r),
                    streamedIndex: indexOf.has(r) ? indexOf.get(r) : null,
                })),
            });
        });
        query.on('error', (err) => {
            lease.resumeSocket();
            reject(err);
        });
        lease.client.query(query);
    }), opts);
}
