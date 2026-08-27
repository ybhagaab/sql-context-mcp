/**
 * Fixture script spawned as a child process by index.pool-error.exploration.test.ts.
 *
 * Mirrors the `pg.Pool` construction used by `ensureConnection()` in `src/index.ts` (same
 * config shape: host/port/database/user/password/ssl) WITHOUT ever calling `.connect()`, so no
 * real database is required or contacted.
 *
 * It then emits an `'error'` event on the pool with a generated error, exactly as `pg.Pool` does
 * internally when an idle pooled client errors out. On the current (unfixed) `index.ts`, no
 * `pool.on('error', ...)` listener is ever attached, so Node treats this as an uncaught exception
 * and the process crashes (non-zero exit code). This fixture lets the parent test observe that
 * crash safely via `child_process.spawnSync` instead of crashing the test runner itself.
 */
const { Pool } = require('pg');

const payload = JSON.parse(process.env.INJECTED_ERROR || '{}');

// Same shape as the config object built by getConnectionConfig() / passed to `new Pool(...)` in
// ensureConnection(). No network I/O happens until .connect() is called, which we deliberately
// never do.
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'test',
  user: 'test',
  password: 'test',
  ssl: false,
});

const err = new Error(payload.message || 'Connection terminated unexpectedly');
if (payload.code) err.code = payload.code;

// Documents isBugCondition('pool_error_event') === NOT hasPoolErrorListener(pool).
console.log('LISTENER_COUNT_BEFORE_EMIT=' + pool.listenerCount('error'));

pool.emit('error', err);

// Only reached if the process survived the emitted error.
console.log('SURVIVED');
process.exit(0);
