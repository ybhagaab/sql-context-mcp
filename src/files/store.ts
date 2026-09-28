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
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

const APP = 'sql-context-presets';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE32[bytes[i] % 32];
  return out;
}

export function resolveBaseDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const custom = env.SQL_EXPORT_DIR?.trim();
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (custom) return p.resolve(custom);
  if (platform === 'darwin') return p.join(home, 'Library', 'Caches', APP);
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), APP, 'Cache');
  return p.join(env.XDG_CACHE_HOME || p.join(home, '.cache'), APP);
}

/** Reduces a caller-supplied name to [A-Za-z0-9._-], at most 64 characters, no leading dot. */
export function sanitizeFileName(name?: string | null): string {
  const cleaned = (name ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 64);
  return cleaned.length ? cleaned : 'export';
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const PROCESS_FOLDER = /^(\d+)-(\d+)$/;

/**
 * Deletes process folders under `baseDir` whose process is no longer running. Returns the names of
 * deleted folders. Symlinks, files, unrelated names and `keep` are left alone.
 */
export async function cleanupStaleProcessFolders(
  baseDir: string,
  opts: { isAlive?: (pid: number) => boolean; keep?: string } = {},
): Promise<string[]> {
  const isAlive = opts.isAlive ?? isProcessAlive;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const deleted: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name === opts.keep) continue;
    const match = PROCESS_FOLDER.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const target = path.join(baseDir, entry.name);
    // Re-check with lstat right before deleting, in case the entry was swapped for a symlink.
    const stat = await fs.promises.lstat(target).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    await fs.promises.rm(target, { recursive: true, force: true });
    deleted.push(entry.name);
  }
  return deleted;
}

async function mkdirPrivate(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.promises.chmod(dir, 0o700);
}

export async function writePrivateFile(file: string, contents: string): Promise<void> {
  await fs.promises.writeFile(file, contents, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.promises.chmod(file, 0o600);
}

/**
 * Opens a new file for writing with mode 0600 (truncating any existing content).
 *
 * Uses a plain numeric descriptor owned by the stream: a FileHandle's descriptor would be closed
 * when the FileHandle is garbage-collected, underneath the stream.
 */
export async function openPrivateWriteStream(file: string): Promise<fs.WriteStream> {
  const fd = await new Promise<number>((resolve, reject) => {
    fs.open(file, 'w', 0o600, (err, opened) => (err ? reject(err) : resolve(opened)));
  });
  if (process.platform !== 'win32') {
    try {
      await new Promise<void>((resolve, reject) => fs.fchmod(fd, 0o600, (err) => (err ? reject(err) : resolve())));
    } catch (err) {
      fs.close(fd, () => undefined);
      throw err;
    }
  }
  return fs.createWriteStream(file, { fd, autoClose: true });
}

function timestamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export class FileStore {
  readonly processDir: string;
  readonly exportsDir: string;
  readonly spoolDir: string;
  private ready: Promise<void> | null = null;

  constructor(readonly baseDir: string, opts: { pid?: number; startMs?: number } = {}) {
    this.processDir = path.join(baseDir, `${opts.pid ?? process.pid}-${opts.startMs ?? Date.now()}`);
    this.exportsDir = path.join(this.processDir, 'exports');
    this.spoolDir = path.join(this.processDir, 'spool');
  }

  get processFolderName(): string {
    return path.basename(this.processDir);
  }

  /** Creates the process folders (0700). Safe to call repeatedly. */
  ensureDirs(): Promise<void> {
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

  newExportPaths(fileName: string | undefined, ext: 'csv' | 'jsonl', now: Date = new Date()): {
    finalPath: string; partPath: string; schemaPath: string;
  } {
    const base = `${sanitizeFileName(fileName)}-${timestamp(now)}-${randomBase32(4)}.${ext}`;
    const finalPath = path.join(this.exportsDir, base);
    return { finalPath, partPath: `${finalPath}.part`, schemaPath: `${finalPath}.schema.json` };
  }

  spoolPath(resultId: string): string {
    return path.join(this.spoolDir, `${resultId}.jsonl`);
  }
}

export class DiskNearlyFullError extends Error {
  constructor(public readonly freeBytes: number, public readonly minFreeBytes: number) {
    super(
      `Disk nearly full: ${freeBytes} bytes free, below the ${minFreeBytes}-byte reserve (SQL_EXPORT_MIN_FREE_BYTES). ` +
      'Free up space or lower the reserve, then try again.',
    );
    this.name = 'DiskNearlyFullError';
  }
}

export type StatFs = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

const CHECK_EVERY_BYTES = 64 * 1024 * 1024;
let statfsWarned = false;

/**
 * Checks free space when a writer opens its file and again after every 64 MB written. Throws
 * DiskNearlyFullError when free space is below the reserve. A reserve of 0 disables the check.
 */
export class FreeSpaceGuard {
  private nextCheckAt: number;
  private readonly checkEvery: number;
  private readonly statfs: StatFs | null;
  private readonly warn: (message: string) => void;
  private warnedHere = false;

  constructor(
    private readonly dir: string,
    private readonly minFreeBytes: number,
    opts: { statfs?: StatFs | null; warn?: (message: string) => void; checkEveryBytes?: number } = {},
  ) {
    this.checkEvery = opts.checkEveryBytes && opts.checkEveryBytes > 0 ? opts.checkEveryBytes : CHECK_EVERY_BYTES;
    this.nextCheckAt = this.checkEvery;
    const native = (fs.promises as unknown as { statfs?: StatFs }).statfs;
    this.statfs = opts.statfs === undefined ? (native ? native.bind(fs.promises) : null) : opts.statfs;
    this.warn = opts.warn ?? ((m) => {
      if (!statfsWarned) {
        statfsWarned = true;
        console.error(`[files] ${m}`);
      }
    });
  }

  async check(): Promise<void> {
    if (this.minFreeBytes <= 0) return;
    if (!this.statfs) {
      if (!this.warnedHere) {
        this.warnedHere = true;
        this.warn('fs.statfs is not available on this Node version; the free-space reserve is not enforced.');
      }
      return;
    }
    const stats = await this.statfs(this.dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < this.minFreeBytes) throw new DiskNearlyFullError(free, this.minFreeBytes);
  }

  /** True when `maybeCheck(bytesWritten)` would check (lets hot loops skip the async call). */
  isDue(bytesWritten: number): boolean {
    return this.minFreeBytes > 0 && bytesWritten >= this.nextCheckAt;
  }

  /** Checks only after every 64 MB written since the last check. */
  async maybeCheck(bytesWritten: number): Promise<void> {
    if (this.minFreeBytes <= 0 || bytesWritten < this.nextCheckAt) return;
    while (this.nextCheckAt <= bytesWritten) this.nextCheckAt += this.checkEvery;
    await this.check();
  }
}
