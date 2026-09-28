"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveColumnTypes = resolveColumnTypes;
exports.typeLookupOn = typeLookupOn;
exports.__resetEngineCache = __resetEngineCache;
exports.detectEngine = detectEngine;
exports.fetchBatchSize = fetchBatchSize;
exports.cursorTotals = cursorTotals;
const values_1 = require("../results/values");
const pool_1 = require("./pool");
const cursor_1 = require("./cursor");
/**
 * Resolves the names of types that aren't built in (for example Redshift's `super`) with one
 * pg_type lookup, using integer literals only. Names are cached per OID. If the lookup fails,
 * the OID is used as the name. Updates `columns` in place.
 */
async function resolveColumnTypes(run, columns) {
    const missing = (0, values_1.unknownOids)(columns.map((c) => c.oid)).filter((oid) => Number.isSafeInteger(oid) && oid > 0);
    if (missing.length) {
        try {
            const result = await run(`select oid, typname from pg_type where oid in (${missing.join(', ')})`);
            const names = {};
            for (const row of result.rows ?? []) {
                if (Array.isArray(row) && row[0] !== null && row[1] !== null)
                    names[Number(row[0])] = String(row[1]);
            }
            (0, values_1.registerTypeNames)(names);
        }
        catch (err) {
            if ((0, pool_1.isConnectionLevelError)(err))
                throw err;
        }
    }
    for (const column of columns)
        column.type = (0, values_1.typeName)(column.oid);
}
/** A pg_type lookup function that runs on `lease`. */
function typeLookupOn(lease) {
    return (text) => lease.query({ text, rowMode: 'array', types: values_1.RAW_TYPES });
}
let cache = new WeakMap();
/** Test-only: forget cached detections. */
function __resetEngineCache() {
    cache = new WeakMap();
}
async function probe(lease, text) {
    try {
        return await lease.query({ text, rowMode: 'array', types: values_1.RAW_TYPES });
    }
    catch (err) {
        if ((0, pool_1.isConnectionLevelError)(err))
            throw err;
        return null;
    }
}
function detectEngine(pool, lease) {
    const cached = cache.get(pool);
    if (cached)
        return cached;
    const detection = (async () => {
        const version = await lease.query({ text: 'select version()', rowMode: 'array', types: values_1.RAW_TYPES });
        const text = String(version.rows?.[0]?.[0] ?? '');
        if (!/redshift/i.test(text))
            return { kind: 'postgres', singleNode: false, totalsFromStv: false };
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
function fetchBatchSize(configured, engine) {
    return engine.kind === 'redshift' && engine.singleNode ? Math.min(configured, 1000) : configured;
}
/**
 * Exact totals for the open cursor, without transferring rows.
 * - Redshift: the result is fully built on the leader node after the first FETCH, and
 *   stv_active_cursors reports its row count and size.
 * - PostgreSQL: MOVE FORWARD ALL counts the remaining rows of the SCROLL cursor, then MOVE
 *   ABSOLUTE returns to the current position.
 */
async function cursorTotals(lease, engine, fetchedSoFar, opts = {}) {
    if (engine.kind === 'redshift') {
        if (!engine.totalsFromStv)
            return { totalRows: null, totalBytes: null };
        const r = await lease.query({
            text: 'select row_count, byte_count from stv_active_cursors where pid = pg_backend_pid()',
            rowMode: 'array',
            types: values_1.RAW_TYPES,
        }, opts);
        const row = r.rows?.[0];
        if (!row)
            return { totalRows: null, totalBytes: null };
        const totalRows = Number(row[0]);
        const totalBytes = Number(row[1]);
        return {
            totalRows: Number.isFinite(totalRows) ? totalRows : null,
            totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
        };
    }
    const moved = await lease.query(`MOVE FORWARD ALL IN ${cursor_1.CURSOR_NAME}`, opts);
    const remaining = typeof moved.rowCount === 'number' ? moved.rowCount : 0;
    await lease.query(`MOVE ABSOLUTE ${fetchedSoFar} IN ${cursor_1.CURSOR_NAME}`, opts);
    return { totalRows: fetchedSoFar + remaining, totalBytes: null };
}
