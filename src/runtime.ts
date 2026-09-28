/**
 * Process-wide runtime: configuration, file store, result store and export manager. Created on
 * first use, so importing the server's modules has no side effects.
 */
import { getConfig, ServerConfig } from './config';
import { FileStore, resolveBaseDir, cleanupStaleProcessFolders, StatFs } from './files/store';
import { ResultStore } from './results/store';
import { ExportManager, ExportManagerOptions } from './export/manager';

export interface Runtime {
  config: ServerConfig;
  files: FileStore;
  results: ResultStore;
  exports: ExportManager;
}

export interface RuntimeOptions {
  /** Base folder for exports and spools (defaults to SQL_EXPORT_DIR or the OS cache folder). */
  baseDir?: string;
  statfs?: StatFs | null;
  /** Test seam: how often (in bytes written) the free-space reserve is checked (default 64 MB). */
  freeSpaceCheckEveryBytes?: number;
  exportOptions?: ExportManagerOptions;
}

let current: Runtime | null = null;

export function createRuntime(config: ServerConfig, opts: RuntimeOptions = {}): Runtime {
  const files = new FileStore(opts.baseDir ?? resolveBaseDir(process.env));
  const results = new ResultStore(
    files,
    {
      spoolMaxTotalBytes: config.spoolMaxTotalBytes,
      maxOpenCursors: config.maxOpenCursors,
      cursorIdleTtlMs: config.cursorIdleTtlMs,
      fetchBatchRows: config.fetchBatchRows,
      minFreeBytes: config.exportMinFreeBytes,
    },
    { statfs: opts.statfs, freeSpaceCheckEveryBytes: opts.freeSpaceCheckEveryBytes },
  );
  const exports = new ExportManager(files, config, {
    statfs: opts.statfs,
    freeSpaceCheckEveryBytes: opts.freeSpaceCheckEveryBytes,
    ...(opts.exportOptions ?? {}),
  });
  return { config, files, results, exports };
}

export function getRuntime(): Runtime {
  if (!current) current = createRuntime(getConfig());
  return current;
}

/** The runtime if it was created, without creating it. */
export function peekRuntime(): Runtime | null {
  return current;
}

/** Test seam: installs (or clears) the process runtime. */
export function setRuntime(runtime: Runtime | null): void {
  current = runtime;
}

/** Startup: deletes folders left by server processes that are no longer running. */
export async function cleanupStaleFolders(runtime: Runtime): Promise<void> {
  try {
    const deleted = await cleanupStaleProcessFolders(runtime.files.baseDir, { keep: runtime.files.processFolderName });
    if (deleted.length) console.error(`[files] removed ${deleted.length} folder(s) left by stopped server processes`);
  } catch (err) {
    console.error(`[files] startup cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Shutdown: closes result sessions and cancels exports, within `timeoutMs`. */
export async function closeRuntime(timeoutMs = 5_000): Promise<void> {
  const runtime = current;
  if (!runtime) return;
  await Promise.race([Promise.allSettled([runtime.results.closeAll(), runtime.exports.closeAll()]), sleep(timeoutMs)]);
}
