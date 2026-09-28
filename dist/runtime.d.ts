/**
 * Process-wide runtime: configuration, file store, result store and export manager. Created on
 * first use, so importing the server's modules has no side effects.
 */
import { ServerConfig } from './config';
import { FileStore, StatFs } from './files/store';
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
export declare function createRuntime(config: ServerConfig, opts?: RuntimeOptions): Runtime;
export declare function getRuntime(): Runtime;
/** The runtime if it was created, without creating it. */
export declare function peekRuntime(): Runtime | null;
/** Test seam: installs (or clears) the process runtime. */
export declare function setRuntime(runtime: Runtime | null): void;
/** Startup: deletes folders left by server processes that are no longer running. */
export declare function cleanupStaleFolders(runtime: Runtime): Promise<void>;
/** Shutdown: closes result sessions and cancels exports, within `timeoutMs`. */
export declare function closeRuntime(timeoutMs?: number): Promise<void>;
//# sourceMappingURL=runtime.d.ts.map