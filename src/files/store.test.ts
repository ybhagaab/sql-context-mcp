/**
 * File store: base folders, private permissions, safe names, free-space reserve, and startup
 * cleanup (design Component 10).
 *
 * Property 11: Cleanup safety - only folders of processes that are no longer running are deleted,
 * and symlinks are never followed.
 *
 * Validates: Requirements 7.1, 7.2, 7.4, 7.5, 7.6
 */
import { describe, test, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveBaseDir,
  sanitizeFileName,
  FileStore,
  cleanupStaleProcessFolders,
  FreeSpaceGuard,
  DiskNearlyFullError,
  writePrivateFile,
} from './store';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-files-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const posixOnly = process.platform === 'win32' ? test.skip : test;

describe('base folder resolution', () => {
  test('SQL_EXPORT_DIR wins, then the OS cache folder', () => {
    expect(resolveBaseDir({ SQL_EXPORT_DIR: '/data/exports' }, 'darwin', '/Users/me')).toBe('/data/exports');
    expect(resolveBaseDir({}, 'darwin', '/Users/me')).toBe('/Users/me/Library/Caches/sql-context-presets');
    expect(resolveBaseDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/me')).toBe('/xdg/sql-context-presets');
    expect(resolveBaseDir({}, 'linux', '/home/me')).toBe('/home/me/.cache/sql-context-presets');
    expect(resolveBaseDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\Users\\me'))
      .toBe('C:\\Users\\me\\AppData\\Local\\sql-context-presets\\Cache');
  });
});

describe('file names', () => {
  test('caller-supplied names can never escape the folder', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (name) => {
        const safe = sanitizeFileName(name);
        expect(safe).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/);
        expect(safe.includes('/')).toBe(false);
        expect(safe.includes('\\')).toBe(false);
      }),
      { numRuns: 500 },
    );
    expect(sanitizeFileName(undefined)).toBe('export');
    expect(sanitizeFileName('')).toBe('export');
    expect(sanitizeFileName('campaigns-2026')).toBe('campaigns-2026');
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('/');
  });

  test('export paths are unique, inside the exports folder, and follow the naming pattern', async () => {
    const store = new FileStore(tempDir(), { pid: 4242, startMs: 1787830911000 });
    await store.ensureDirs();
    const a = store.newExportPaths('campaigns', 'csv');
    const b = store.newExportPaths('campaigns', 'csv');
    expect(a.finalPath).not.toBe(b.finalPath);
    expect(path.dirname(a.finalPath)).toBe(store.exportsDir);
    expect(path.basename(a.finalPath)).toMatch(/^campaigns-\d{8}-\d{6}-[a-z2-7]{4}\.csv$/);
    expect(a.partPath).toBe(`${a.finalPath}.part`);
    expect(a.schemaPath).toBe(`${a.finalPath}.schema.json`);
    expect(store.processDir.endsWith('4242-1787830911000')).toBe(true);
  });
});

describe('permissions', () => {
  posixOnly('folders are 0700 and files 0600', async () => {
    const store = new FileStore(tempDir(), { pid: 1, startMs: 2 });
    await store.ensureDirs();
    for (const dir of [store.processDir, store.exportsDir, store.spoolDir]) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    const file = path.join(store.exportsDir, 'x.json');
    await writePrivateFile(file, '{}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('Property 11: cleanup safety', () => {
  posixOnly('deletes only folders of processes that are not running, never following symlinks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 900_000, max: 999_990 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        async (pids, aliveFlags) => {
          const base = tempDir();
          const outside = tempDir();
          fs.writeFileSync(path.join(outside, 'keep.txt'), 'important');
          const alive = new Set<number>();
          const expectDeleted: string[] = [];
          pids.forEach((pid, i) => {
            const name = `${pid}-1700000000000`;
            fs.mkdirSync(path.join(base, name));
            fs.writeFileSync(path.join(base, name, 'data.csv'), 'x');
            if (aliveFlags[i]) alive.add(pid);
            else expectDeleted.push(name);
          });
          // A symlink whose name looks like a dead process folder must be left alone.
          fs.symlinkSync(outside, path.join(base, '999998-1700000000000'));
          // (Generated PIDs stay at or below 999,990, so they never collide with this name.)
          // The current process folder and unrelated entries are kept.
          const own = `${process.pid}-1`;
          fs.mkdirSync(path.join(base, own));
          fs.mkdirSync(path.join(base, 'notes'));
          fs.writeFileSync(path.join(base, '123-456'), 'a file, not a folder');

          const deleted = await cleanupStaleProcessFolders(base, { isAlive: (pid) => alive.has(pid), keep: own });

          expect(deleted.sort()).toEqual(expectDeleted.sort());
          for (const name of expectDeleted) expect(fs.existsSync(path.join(base, name))).toBe(false);
          for (const pid of alive) expect(fs.existsSync(path.join(base, `${pid}-1700000000000`))).toBe(true);
          expect(fs.lstatSync(path.join(base, '999998-1700000000000')).isSymbolicLink()).toBe(true);
          expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8')).toBe('important');
          expect(fs.existsSync(path.join(base, own))).toBe(true);
          expect(fs.existsSync(path.join(base, 'notes'))).toBe(true);
          expect(fs.existsSync(path.join(base, '123-456'))).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  test('a missing base folder is not an error', async () => {
    expect(await cleanupStaleProcessFolders(path.join(tempDir(), 'does-not-exist'))).toEqual([]);
  });
});

describe('free-space reserve', () => {
  test('stops when free space would drop below the reserve', async () => {
    const guard = new FreeSpaceGuard('/tmp', 1_000, { statfs: async () => ({ bavail: 999, bsize: 1 }) });
    await expect(guard.check()).rejects.toBeInstanceOf(DiskNearlyFullError);
    const ok = new FreeSpaceGuard('/tmp', 1_000, { statfs: async () => ({ bavail: 5_000, bsize: 1 }) });
    await expect(ok.check()).resolves.toBeUndefined();
  });

  test('a reserve of 0 disables the check', async () => {
    let calls = 0;
    const guard = new FreeSpaceGuard('/tmp', 0, { statfs: async () => { calls++; return { bavail: 0, bsize: 1 }; } });
    await guard.check();
    await guard.maybeCheck(10 * 1024 * 1024 * 1024);
    expect(calls).toBe(0);
  });

  test('checks again only after every 64 MB written', async () => {
    let calls = 0;
    const guard = new FreeSpaceGuard('/tmp', 1, { statfs: async () => { calls++; return { bavail: 10 ** 12, bsize: 1 }; } });
    await guard.check();
    await guard.maybeCheck(10 * 1024 * 1024);
    await guard.maybeCheck(60 * 1024 * 1024);
    expect(calls).toBe(1);
    await guard.maybeCheck(65 * 1024 * 1024);
    expect(calls).toBe(2);
    await guard.maybeCheck(100 * 1024 * 1024);
    expect(calls).toBe(2);
    await guard.maybeCheck(130 * 1024 * 1024);
    expect(calls).toBe(3);
  });

  test('without fs.statfs the check is skipped with a single warning', async () => {
    const warnings: string[] = [];
    const guard = new FreeSpaceGuard('/tmp', 1_000, { statfs: null, warn: (m) => warnings.push(m) });
    await guard.check();
    await guard.check();
    expect(warnings).toHaveLength(1);
  });
});
