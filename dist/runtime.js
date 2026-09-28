"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRuntime = createRuntime;
exports.getRuntime = getRuntime;
exports.peekRuntime = peekRuntime;
exports.setRuntime = setRuntime;
exports.cleanupStaleFolders = cleanupStaleFolders;
exports.closeRuntime = closeRuntime;
/**
 * Process-wide runtime: configuration, file store, result store and export manager. Created on
 * first use, so importing the server's modules has no side effects.
 */
const config_1 = require("./config");
const store_1 = require("./files/store");
const store_2 = require("./results/store");
const manager_1 = require("./export/manager");
let current = null;
function createRuntime(config, opts = {}) {
    const files = new store_1.FileStore(opts.baseDir ?? (0, store_1.resolveBaseDir)(process.env));
    const results = new store_2.ResultStore(files, {
        spoolMaxTotalBytes: config.spoolMaxTotalBytes,
        maxOpenCursors: config.maxOpenCursors,
        cursorIdleTtlMs: config.cursorIdleTtlMs,
        fetchBatchRows: config.fetchBatchRows,
        minFreeBytes: config.exportMinFreeBytes,
    }, { statfs: opts.statfs, freeSpaceCheckEveryBytes: opts.freeSpaceCheckEveryBytes });
    const exports = new manager_1.ExportManager(files, config, {
        statfs: opts.statfs,
        freeSpaceCheckEveryBytes: opts.freeSpaceCheckEveryBytes,
        ...(opts.exportOptions ?? {}),
    });
    return { config, files, results, exports };
}
function getRuntime() {
    if (!current)
        current = createRuntime((0, config_1.getConfig)());
    return current;
}
/** The runtime if it was created, without creating it. */
function peekRuntime() {
    return current;
}
/** Test seam: installs (or clears) the process runtime. */
function setRuntime(runtime) {
    current = runtime;
}
/** Startup: deletes folders left by server processes that are no longer running. */
async function cleanupStaleFolders(runtime) {
    try {
        const deleted = await (0, store_1.cleanupStaleProcessFolders)(runtime.files.baseDir, { keep: runtime.files.processFolderName });
        if (deleted.length)
            console.error(`[files] removed ${deleted.length} folder(s) left by stopped server processes`);
    }
    catch (err) {
        console.error(`[files] startup cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function sleep(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
    });
}
/** Shutdown: closes result sessions and cancels exports, within `timeoutMs`. */
async function closeRuntime(timeoutMs = 5000) {
    const runtime = current;
    if (!runtime)
        return;
    await Promise.race([Promise.allSettled([runtime.results.closeAll(), runtime.exports.closeAll()]), sleep(timeoutMs)]);
}
