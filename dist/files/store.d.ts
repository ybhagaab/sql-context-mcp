/**
 * File store for exports and page spools (design Component 10).
 *
 * - Base folder: SQL_EXPORT_DIR, or the OS cache folder.
 * - Each server process writes into its own `<pid>-<startEpochMs>` folder with `exports/` and
 *   `spool/`. Folders are 0700 and files 0600, set explicitly whatever the umask.
 * - Startup cleanup deletes only process folders whose process is no longer running, and never
 *   follows symlinks. PID reuse can only make a stale folder survive (the safe direction).
 * - A free-space reserve stops writing before the disk fills. It is not a size limit.
 */
import * as fs from 'fs';
export declare function randomBase32(length: number): string;
export declare function resolveBaseDir(env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string): string;
/** Reduces a caller-supplied name to [A-Za-z0-9._-], at most 64 characters, no leading dot. */
export declare function sanitizeFileName(name?: string | null): string;
export declare function isProcessAlive(pid: number): boolean;
/**
 * Deletes process folders under `baseDir` whose process is no longer running. Returns the names of
 * deleted folders. Symlinks, files, unrelated names and `keep` are left alone.
 */
export declare function cleanupStaleProcessFolders(baseDir: string, opts?: {
    isAlive?: (pid: number) => boolean;
    keep?: string;
}): Promise<string[]>;
export declare function writePrivateFile(file: string, contents: string): Promise<void>;
/**
 * Opens a new file for writing with mode 0600 (truncating any existing content).
 *
 * Uses a plain numeric descriptor owned by the stream: a FileHandle's descriptor would be closed
 * when the FileHandle is garbage-collected, underneath the stream.
 */
export declare function openPrivateWriteStream(file: string): Promise<fs.WriteStream>;
export declare class FileStore {
    readonly baseDir: string;
    readonly processDir: string;
    readonly exportsDir: string;
    readonly spoolDir: string;
    private ready;
    constructor(baseDir: string, opts?: {
        pid?: number;
        startMs?: number;
    });
    get processFolderName(): string;
    /** Creates the process folders (0700). Safe to call repeatedly. */
    ensureDirs(): Promise<void>;
    newExportPaths(fileName: string | undefined, ext: 'csv' | 'jsonl', now?: Date): {
        finalPath: string;
        partPath: string;
        schemaPath: string;
    };
    spoolPath(resultId: string): string;
}
export declare class DiskNearlyFullError extends Error {
    readonly freeBytes: number;
    readonly minFreeBytes: number;
    constructor(freeBytes: number, minFreeBytes: number);
}
export type StatFs = (dir: string) => Promise<{
    bavail: number | bigint;
    bsize: number | bigint;
}>;
/**
 * Checks free space when a writer opens its file and again after every 64 MB written. Throws
 * DiskNearlyFullError when free space is below the reserve. A reserve of 0 disables the check.
 */
export declare class FreeSpaceGuard {
    private readonly dir;
    private readonly minFreeBytes;
    private nextCheckAt;
    private readonly checkEvery;
    private readonly statfs;
    private readonly warn;
    private warnedHere;
    constructor(dir: string, minFreeBytes: number, opts?: {
        statfs?: StatFs | null;
        warn?: (message: string) => void;
        checkEveryBytes?: number;
    });
    check(): Promise<void>;
    /** True when `maybeCheck(bytesWritten)` would check (lets hot loops skip the async call). */
    isDue(bytesWritten: number): boolean;
    /** Checks only after every 64 MB written since the last check. */
    maybeCheck(bytesWritten: number): Promise<void>;
}
//# sourceMappingURL=store.d.ts.map