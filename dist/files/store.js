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
exports.FreeSpaceGuard = exports.DiskNearlyFullError = exports.FileStore = void 0;
exports.randomBase32 = randomBase32;
exports.resolveBaseDir = resolveBaseDir;
exports.sanitizeFileName = sanitizeFileName;
exports.isProcessAlive = isProcessAlive;
exports.cleanupStaleProcessFolders = cleanupStaleProcessFolders;
exports.writePrivateFile = writePrivateFile;
exports.openPrivateWriteStream = openPrivateWriteStream;
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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const APP = 'sql-context-presets';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function randomBase32(length) {
    const bytes = (0, crypto_1.randomBytes)(length);
    let out = '';
    for (let i = 0; i < length; i++)
        out += BASE32[bytes[i] % 32];
    return out;
}
function resolveBaseDir(env = process.env, platform = process.platform, home = os.homedir()) {
    const custom = env.SQL_EXPORT_DIR?.trim();
    const p = platform === 'win32' ? path.win32 : path.posix;
    if (custom)
        return p.resolve(custom);
    if (platform === 'darwin')
        return p.join(home, 'Library', 'Caches', APP);
    if (platform === 'win32')
        return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), APP, 'Cache');
    return p.join(env.XDG_CACHE_HOME || p.join(home, '.cache'), APP);
}
/** Reduces a caller-supplied name to [A-Za-z0-9._-], at most 64 characters, no leading dot. */
function sanitizeFileName(name) {
    const cleaned = (name ?? '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 64);
    return cleaned.length ? cleaned : 'export';
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
const PROCESS_FOLDER = /^(\d+)-(\d+)$/;
/**
 * Deletes process folders under `baseDir` whose process is no longer running. Returns the names of
 * deleted folders. Symlinks, files, unrelated names and `keep` are left alone.
 */
async function cleanupStaleProcessFolders(baseDir, opts = {}) {
    const isAlive = opts.isAlive ?? isProcessAlive;
    let entries;
    try {
        entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const deleted = [];
    for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory())
            continue;
        if (entry.name === opts.keep)
            continue;
        const match = PROCESS_FOLDER.exec(entry.name);
        if (!match)
            continue;
        const pid = Number(match[1]);
        if (pid === process.pid || isAlive(pid))
            continue;
        const target = path.join(baseDir, entry.name);
        // Re-check with lstat right before deleting, in case the entry was swapped for a symlink.
        const stat = await fs.promises.lstat(target).catch(() => null);
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory())
            continue;
        await fs.promises.rm(target, { recursive: true, force: true });
        deleted.push(entry.name);
    }
    return deleted;
}
async function mkdirPrivate(dir) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32')
        await fs.promises.chmod(dir, 0o700);
}
async function writePrivateFile(file, contents) {
    await fs.promises.writeFile(file, contents, { mode: 0o600 });
    if (process.platform !== 'win32')
        await fs.promises.chmod(file, 0o600);
}
/**
 * Opens a new file for writing with mode 0600 (truncating any existing content).
 *
 * Uses a plain numeric descriptor owned by the stream: a FileHandle's descriptor would be closed
 * when the FileHandle is garbage-collected, underneath the stream.
 */
async function openPrivateWriteStream(file) {
    const fd = await new Promise((resolve, reject) => {
        fs.open(file, 'w', 0o600, (err, opened) => (err ? reject(err) : resolve(opened)));
    });
    if (process.platform !== 'win32') {
        try {
            await new Promise((resolve, reject) => fs.fchmod(fd, 0o600, (err) => (err ? reject(err) : resolve())));
        }
        catch (err) {
            fs.close(fd, () => undefined);
            throw err;
        }
    }
    return fs.createWriteStream(file, { fd, autoClose: true });
}
function timestamp(now) {
    const p = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
class FileStore {
    constructor(baseDir, opts = {}) {
        this.baseDir = baseDir;
        this.ready = null;
        this.processDir = path.join(baseDir, `${opts.pid ?? process.pid}-${opts.startMs ?? Date.now()}`);
        this.exportsDir = path.join(this.processDir, 'exports');
        this.spoolDir = path.join(this.processDir, 'spool');
    }
    get processFolderName() {
        return path.basename(this.processDir);
    }
    /** Creates the process folders (0700). Safe to call repeatedly. */
    ensureDirs() {
        if (!this.ready) {
            this.ready = (async () => {
                await mkdirPrivate(this.baseDir);
                await mkdirPrivate(this.processDir);
                await mkdirPrivate(this.exportsDir);
                await mkdirPrivate(this.spoolDir);
            })().catch((err) => {
                this.ready = null;
                throw err;
            });
        }
        return this.ready;
    }
    newExportPaths(fileName, ext, now = new Date()) {
        const base = `${sanitizeFileName(fileName)}-${timestamp(now)}-${randomBase32(4)}.${ext}`;
        const finalPath = path.join(this.exportsDir, base);
        return { finalPath, partPath: `${finalPath}.part`, schemaPath: `${finalPath}.schema.json` };
    }
    spoolPath(resultId) {
        return path.join(this.spoolDir, `${resultId}.jsonl`);
    }
}
exports.FileStore = FileStore;
class DiskNearlyFullError extends Error {
    constructor(freeBytes, minFreeBytes) {
        super(`Disk nearly full: ${freeBytes} bytes free, below the ${minFreeBytes}-byte reserve (SQL_EXPORT_MIN_FREE_BYTES). ` +
            'Free up space or lower the reserve, then try again.');
        this.freeBytes = freeBytes;
        this.minFreeBytes = minFreeBytes;
        this.name = 'DiskNearlyFullError';
    }
}
exports.DiskNearlyFullError = DiskNearlyFullError;
const CHECK_EVERY_BYTES = 64 * 1024 * 1024;
let statfsWarned = false;
/**
 * Checks free space when a writer opens its file and again after every 64 MB written. Throws
 * DiskNearlyFullError when free space is below the reserve. A reserve of 0 disables the check.
 */
class FreeSpaceGuard {
    constructor(dir, minFreeBytes, opts = {}) {
        this.dir = dir;
        this.minFreeBytes = minFreeBytes;
        this.warnedHere = false;
        this.checkEvery = opts.checkEveryBytes && opts.checkEveryBytes > 0 ? opts.checkEveryBytes : CHECK_EVERY_BYTES;
        this.nextCheckAt = this.checkEvery;
        const native = fs.promises.statfs;
        this.statfs = opts.statfs === undefined ? (native ? native.bind(fs.promises) : null) : opts.statfs;
        this.warn = opts.warn ?? ((m) => {
            if (!statfsWarned) {
                statfsWarned = true;
                console.error(`[files] ${m}`);
            }
        });
    }
    async check() {
        if (this.minFreeBytes <= 0)
            return;
        if (!this.statfs) {
            if (!this.warnedHere) {
                this.warnedHere = true;
                this.warn('fs.statfs is not available on this Node version; the free-space reserve is not enforced.');
            }
            return;
        }
        const stats = await this.statfs(this.dir);
        const free = Number(stats.bavail) * Number(stats.bsize);
        if (free < this.minFreeBytes)
            throw new DiskNearlyFullError(free, this.minFreeBytes);
    }
    /** True when `maybeCheck(bytesWritten)` would check (lets hot loops skip the async call). */
    isDue(bytesWritten) {
        return this.minFreeBytes > 0 && bytesWritten >= this.nextCheckAt;
    }
    /** Checks only after every 64 MB written since the last check. */
    async maybeCheck(bytesWritten) {
        if (this.minFreeBytes <= 0 || bytesWritten < this.nextCheckAt)
            return;
        while (this.nextCheckAt <= bytesWritten)
            this.nextCheckAt += this.checkEvery;
        await this.check();
    }
}
exports.FreeSpaceGuard = FreeSpaceGuard;
