/**
 * Preservation property test — valid SSL configuration shape.
 *
 * Property 8: Preservation - Valid SSL Configuration Continues to Connect Successfully
 *
 * Per design.md's Correctness Property 8:
 *
 *   "For any input where SQL_SSL_MODE, SQL_SSL_CA, SQL_SSL_CERT, and SQL_SSL_KEY are configured
 *    with valid, readable files, the fixed buildSSLConfig() SHALL produce the same SSL config
 *    shape as the original implementation for every SQL_SSL_MODE value (disable, require,
 *    verify-ca, verify-full)."
 *
 * This test follows the observation-first methodology: it is written and run against the
 * CURRENT (unfixed) `buildSSLConfig()` in `src/index.ts` first, to establish the baseline shape
 * that Task 15 (buildSSLConfig() try/catch fix) must preserve byte-for-byte for the
 * successful-load path. Observed baseline behavior (from direct inspection of `buildSSLConfig()`):
 *
 *   - 'disable'                 -> returns `false` (short-circuits before any file is read)
 *   - 'require'                 -> returns `{ rejectUnauthorized: false }`
 *   - 'verify-ca'/'verify-full' -> returns `{ rejectUnauthorized: true, ca: <Buffer> }` when
 *                                  SQL_SSL_CA is set, else `{ rejectUnauthorized: true }`
 *   - in every non-'disable' case, if SQL_SSL_CERT AND SQL_SSL_KEY are BOTH set, `cert`/`key`
 *     Buffers are merged into the result regardless of SQL_SSL_MODE
 *
 * Because this test only exercises VALID, readable temp files (never a missing/unreadable path),
 * it is EXPECTED TO PASS on unfixed code — it establishes the baseline that Task 15's fix must not
 * change for the successful-load path.
 *
 * `buildSSLConfig()` is imported directly from `./index`, mirroring the same minimal test seam
 * used by `index.ssl-config.exploration.test.ts`.
 *
 * Validates: Requirements 3.5
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

/** Creates a real, readable temp file with the given content and schedules it for cleanup. */
function makeValidTempFile(content: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `sql-context-presets-ssl-valid-config-test-${crypto.randomUUID()}.pem`
  );
  fs.writeFileSync(filePath, content);
  tempFilesToClean.push(filePath);
  return filePath;
}

const sslModeArb = fc.constantFrom('disable', 'require', 'verify-ca', 'verify-full');
const fileContentArb = fc.string({ minLength: 1, maxLength: 200 });

describe('Preservation: valid SSL configuration shape (Property 8)', () => {
  test('buildSSLConfig() returns the observed baseline shape for every SQL_SSL_MODE with valid, readable CA/cert/key files', () => {
    fc.assert(
      fc.property(
        sslModeArb,
        fc.boolean(), // whether SQL_SSL_CA is set (only consumed for verify-ca/verify-full)
        fc.boolean(), // whether SQL_SSL_CERT + SQL_SSL_KEY are both set
        fileContentArb,
        fileContentArb,
        fileContentArb,
        (sslMode, caPresent, certKeyPresent, caContent, certContent, keyContent) => {
          process.env.SQL_SSL_MODE = sslMode;

          let caPath: string | undefined;
          let certPath: string | undefined;
          let keyPath: string | undefined;

          if (caPresent) {
            caPath = makeValidTempFile(caContent);
            process.env.SQL_SSL_CA = caPath;
          } else {
            delete process.env.SQL_SSL_CA;
          }

          if (certKeyPresent) {
            certPath = makeValidTempFile(certContent);
            keyPath = makeValidTempFile(keyContent);
            process.env.SQL_SSL_CERT = certPath;
            process.env.SQL_SSL_KEY = keyPath;
          } else {
            delete process.env.SQL_SSL_CERT;
            delete process.env.SQL_SSL_KEY;
          }

          const result = buildSSLConfig();

          if (sslMode === 'disable') {
            // Observed baseline: 'disable' short-circuits before any CA/cert/key file is ever
            // read, regardless of what SQL_SSL_CA/CERT/KEY are set to.
            expect(result).toBe(false);
            return;
          }

          expect(typeof result).toBe('object');
          const config = result as Record<string, unknown>;
          const expectedKeys = new Set(['rejectUnauthorized']);

          if (sslMode === 'require') {
            expect(config.rejectUnauthorized).toBe(false);
            expect(config.ca).toBeUndefined();
          } else {
            // 'verify-ca' / 'verify-full'
            expect(config.rejectUnauthorized).toBe(true);
            if (caPresent && caPath) {
              expect(Buffer.isBuffer(config.ca)).toBe(true);
              expect((config.ca as Buffer).equals(Buffer.from(caContent))).toBe(true);
              expectedKeys.add('ca');
            } else {
              expect(config.ca).toBeUndefined();
            }
          }

          if (certKeyPresent && certPath && keyPath) {
            expect(Buffer.isBuffer(config.cert)).toBe(true);
            expect((config.cert as Buffer).equals(Buffer.from(certContent))).toBe(true);
            expect(Buffer.isBuffer(config.key)).toBe(true);
            expect((config.key as Buffer).equals(Buffer.from(keyContent))).toBe(true);
            expectedKeys.add('cert');
            expectedKeys.add('key');
          } else {
            expect(config.cert).toBeUndefined();
            expect(config.key).toBeUndefined();
          }

          // No extra/unexpected keys beyond what's expected for this combination.
          expect(new Set(Object.keys(config))).toEqual(expectedKeys);
        }
      ),
      { numRuns: 50 }
    );
  });

  test('documented baseline: verify-full with a valid SQL_SSL_CA produces { rejectUnauthorized: true, ca: <Buffer> }', () => {
    const caPath = makeValidTempFile('trusted-ca-cert-content');
    process.env.SQL_SSL_MODE = 'verify-full';
    process.env.SQL_SSL_CA = caPath;

    const result = buildSSLConfig() as Record<string, unknown>;
    expect(result.rejectUnauthorized).toBe(true);
    expect(Buffer.isBuffer(result.ca)).toBe(true);
    expect((result.ca as Buffer).toString()).toBe('trusted-ca-cert-content');
    expect(Object.keys(result).sort()).toEqual(['ca', 'rejectUnauthorized']);
  });

  test('documented baseline: disable mode returns false regardless of other SSL env vars being set', () => {
    process.env.SQL_SSL_MODE = 'disable';
    process.env.SQL_SSL_CA = makeValidTempFile('ignored-ca');
    process.env.SQL_SSL_CERT = makeValidTempFile('ignored-cert');
    process.env.SQL_SSL_KEY = makeValidTempFile('ignored-key');

    expect(buildSSLConfig()).toBe(false);
  });

  test('documented baseline: require mode with valid cert/key produces { rejectUnauthorized: false, cert: <Buffer>, key: <Buffer> }', () => {
    const certPath = makeValidTempFile('client-cert-content');
    const keyPath = makeValidTempFile('client-key-content');
    process.env.SQL_SSL_MODE = 'require';
    process.env.SQL_SSL_CERT = certPath;
    process.env.SQL_SSL_KEY = keyPath;

    const result = buildSSLConfig() as Record<string, unknown>;
    expect(result.rejectUnauthorized).toBe(false);
    expect((result.cert as Buffer).toString()).toBe('client-cert-content');
    expect((result.key as Buffer).toString()).toBe('client-key-content');
    expect(Object.keys(result).sort()).toEqual(['cert', 'key', 'rejectUnauthorized']);
  });
});
