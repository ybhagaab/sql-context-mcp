/**
 * Bug condition exploration test — SSL file-load errors lack env var/path context.
 *
 * Property 7: Bug Condition - SSL Load Failures Produce Raw, Context-Free Errors
 *
 * This test MUST be written and run BEFORE any fix is implemented (Phase 1 of the bugfix
 * methodology). It encodes the EXPECTED (post-fix) behavior of `buildSSLConfig()` per design.md's
 * Correctness Property 7:
 *
 *   "For any input where SQL_SSL_CA, SQL_SSL_CERT, or SQL_SSL_KEY names a file that cannot be
 *    read, the fixed buildSSLConfig() SHALL raise an error whose message includes both the
 *    specific environment variable name and the file path that failed to load, without crashing
 *    the process."
 *
 * Concretely, for a randomly generated nonexistent file path assigned to `SQL_SSL_CA`,
 * `SQL_SSL_CERT`, or `SQL_SSL_KEY` (with `SQL_SSL_MODE` set as applicable), this test asserts the
 * thrown error message CONTAINS the env var name and the file path.
 *
 * On the CURRENT (unfixed) `src/index.ts`, `buildSSLConfig()` calls
 * `fs.readFileSync(process.env.SQL_SSL_CA)` / `SQL_SSL_CERT` / `SQL_SSL_KEY` directly with no
 * try/catch, so any ENOENT/EACCES bubbles up as a raw Node filesystem error with no indication of
 * which SSL environment variable or path was responsible (design.md
 * `isBugCondition('ssl_file_load_failure')`). Because this test asserts the FIXED behavior, it is
 * EXPECTED TO FAIL on unfixed code: the raw `ENOENT: no such file or directory, open '<path>'`
 * message never mentions the env var name — that failure is the counterexample proving the bug
 * exists.
 *
 * `buildSSLConfig()` is imported directly from `./index` as a minimal, additive test seam (see the
 * NOTE comment next to its declaration in `src/index.ts`). No pg/AWS SDK mocking is needed since
 * this function only touches `process.env` and the filesystem.
 *
 * Validates: Requirements 1.4
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { buildSSLConfig } from './index';

const ENV_KEYS = ['SQL_SSL_MODE', 'SQL_SSL_CA', 'SQL_SSL_CERT', 'SQL_SSL_KEY'] as const;
let savedEnv: Record<string, string | undefined> = {};
const tempFilesToClean: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempFilesToClean.length > 0) {
    const filePath = tempFilesToClean.pop();
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
});

/** Builds a path that is guaranteed not to exist on disk: a random UUID-based filename inside the
 * OS temp dir. This never actually creates the file. */
function makeNonexistentPath(): string {
  return path.join(os.tmpdir(), `sql-context-presets-ssl-test-${crypto.randomUUID()}.pem`);
}

/** Creates a real, readable temp file (valid placeholder content) so it can be used as the
 * "other" env var in a pair (SQL_SSL_CERT/SQL_SSL_KEY) that must both be set, without itself
 * being the source of the failure under test. */
function makeValidTempFile(): string {
  const filePath = path.join(os.tmpdir(), `sql-context-presets-ssl-test-valid-${crypto.randomUUID()}.pem`);
  fs.writeFileSync(filePath, 'placeholder-content');
  tempFilesToClean.push(filePath);
  return filePath;
}

const nonexistentPathArb = fc.constant(null).map(() => makeNonexistentPath());
const sslModeArb = fc.constantFrom('verify-ca', 'verify-full');
const certKeyEnvVarArb = fc.constantFrom('SQL_SSL_CERT' as const, 'SQL_SSL_KEY' as const);

describe('Bug condition exploration: SSL file-load errors lack env var/path context (Property 7)', () => {
  test(
    'SQL_SSL_CA pointing at a nonexistent file: buildSSLConfig() error message mentions the env var name (counterexample surfaced on unfixed code)',
    () => {
      fc.assert(
        fc.property(sslModeArb, nonexistentPathArb, (sslMode, badPath) => {
          process.env.SQL_SSL_MODE = sslMode;
          process.env.SQL_SSL_CA = badPath;
          delete process.env.SQL_SSL_CERT;
          delete process.env.SQL_SSL_KEY;

          let thrownMessage: string | undefined;
          try {
            buildSSLConfig();
          } catch (error) {
            thrownMessage = error instanceof Error ? error.message : String(error);
          }

          // Expected (fixed) behavior, Property 7: the error message must contain both the env
          // var name and the failing path.
          expect(thrownMessage).toBeDefined();
          expect(thrownMessage).toContain('SQL_SSL_CA');
          expect(thrownMessage).toContain(badPath);
        }),
        { numRuns: 15 }
      );
    }
  );

  test(
    'SQL_SSL_CERT/SQL_SSL_KEY pointing at a nonexistent file: buildSSLConfig() error message mentions the env var name (counterexample surfaced on unfixed code)',
    () => {
      fc.assert(
        fc.property(certKeyEnvVarArb, nonexistentPathArb, (envVar, badPath) => {
          delete process.env.SQL_SSL_MODE;
          delete process.env.SQL_SSL_CA;
          // SQL_SSL_CERT and SQL_SSL_KEY are only read together (both must be set), per current
          // code, regardless of SQL_SSL_MODE. Set the targeted env var to the generated
          // nonexistent path, and its pair to a real, readable file so the failure is isolated to
          // the env var under test (SQL_SSL_CERT is read before SQL_SSL_KEY in the current code,
          // so a valid cert path is required to isolate a SQL_SSL_KEY failure).
          const validPairPath = makeValidTempFile();
          if (envVar === 'SQL_SSL_CERT') {
            process.env.SQL_SSL_CERT = badPath;
            process.env.SQL_SSL_KEY = validPairPath;
          } else {
            process.env.SQL_SSL_CERT = validPairPath;
            process.env.SQL_SSL_KEY = badPath;
          }

          let thrownMessage: string | undefined;
          try {
            buildSSLConfig();
          } catch (error) {
            thrownMessage = error instanceof Error ? error.message : String(error);
          }

          // Expected (fixed) behavior, Property 7: the error message must contain both the env
          // var name and the failing path.
          expect(thrownMessage).toBeDefined();
          expect(thrownMessage).toContain(envVar);
          expect(thrownMessage).toContain(badPath);
        }),
        { numRuns: 15 }
      );
    }
  );

  test('documented counterexample (fixed): SQL_SSL_CA=/tmp/typo-ca.pem now produces an error mentioning SQL_SSL_CA and the path', () => {
    const badPath = makeNonexistentPath();
    process.env.SQL_SSL_MODE = 'verify-full';
    process.env.SQL_SSL_CA = badPath;

    let thrown: unknown;
    try {
      buildSSLConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Post-fix behavior (Task 15.1): buildSSLConfig() wraps the raw fs.readFileSync() failure with
    // context identifying which env var and path failed to load, while still preserving the
    // original ENOENT text as context.
    expect(message).toContain('SQL_SSL_CA');
    expect(message).toContain(badPath);
    expect(message).toContain('ENOENT');
  });
});
