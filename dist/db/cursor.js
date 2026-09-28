"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CursorReader = exports.DeclareRejectedError = exports.CURSOR_NAME = void 0;
exports.stripTrailingSemicolons = stripTrailingSemicolons;
const values_1 = require("../results/values");
const pool_1 = require("./pool");
exports.CURSOR_NAME = 'mcp_c';
class DeclareRejectedError extends Error {
    constructor(cause) {
        super(`DECLARE CURSOR was rejected: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.cause = cause;
        this.name = 'DeclareRejectedError';
    }
}
exports.DeclareRejectedError = DeclareRejectedError;
function stripTrailingSemicolons(sql) {
    return sql.trim().replace(/;+\s*$/, '').trim();
}
class CursorReader {
    constructor(lease) {
        this.lease = lease;
        this.fields = null;
        this.exhausted = false;
        this.fetchedRows = 0;
        this.open = true;
    }
    static async open(lease, sql, engine, opts = {}) {
        const statement = stripTrailingSemicolons(sql);
        await lease.query('BEGIN', opts);
        try {
            await lease.query(`DECLARE ${exports.CURSOR_NAME} ${engine.kind === 'postgres' ? 'SCROLL ' : ''}CURSOR FOR ${statement}`, opts);
        }
        catch (err) {
            if ((0, pool_1.isConnectionLevelError)(err))
                throw err;
            await lease.query('ROLLBACK').catch(() => lease.markDiscard());
            if (err.name === 'QueryCancelledError' || err.name === 'QueryTimeoutError')
                throw err;
            throw new DeclareRejectedError(err);
        }
        return new CursorReader(lease);
    }
    get isOpen() {
        return this.open;
    }
    async fetch(count, opts = {}) {
        const result = await this.lease.query({ text: `FETCH FORWARD ${count} FROM ${exports.CURSOR_NAME}`, rowMode: 'array', types: values_1.RAW_TYPES }, opts);
        if (!this.fields) {
            this.fields = (result.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
        }
        const rows = (result.rows ?? []);
        this.fetchedRows += rows.length;
        if (rows.length < count)
            this.exhausted = true;
        return rows;
    }
    /** CLOSE + END. On failure the connection is marked for discard. */
    async close() {
        if (!this.open)
            return;
        this.open = false;
        try {
            await this.lease.query(`CLOSE ${exports.CURSOR_NAME}`);
            await this.lease.query('END');
        }
        catch {
            this.lease.markDiscard();
            await this.lease.query('ROLLBACK').catch(() => undefined);
        }
    }
    /** ROLLBACK the cursor's transaction. On failure the connection is marked for discard. */
    async abort() {
        if (!this.open)
            return;
        this.open = false;
        await this.lease.query('ROLLBACK').catch(() => this.lease.markDiscard());
    }
}
exports.CursorReader = CursorReader;
