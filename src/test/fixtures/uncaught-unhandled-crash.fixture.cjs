/**
 * Fixture script spawned as a child process by index.pool-error.exploration.test.ts.
 *
 * Loads the actual server module (`dist/index.js`, built from `src/index.ts`) to observe its
 * real module-scope side effects (including whatever process-level listeners it registers at
 * import time), then triggers either a raw `throw` (uncaught exception) or a rejected promise
 * with no `.catch` (unhandled rejection), selected via the `CRASH_MODE` env var.
 *
 * Post-fix (Task 14.1) behavior: `src/index.ts` registers `process.on('uncaughtException', ...)`
 * and `process.on('unhandledRejection', ...)` guards. Connection-level errors (per
 * `isConnectionLevelError()`) reset `client`/`pool` state and let the process SURVIVE; genuinely
 * unrecoverable (non-connection-level) errors still log and call `process.exit(1)`.
 *
 * To reliably distinguish "survived" from "exited", this fixture prints a "SURVIVED" marker to
 * stdout a short delay AFTER the throw/rejection is triggered. If the guard called
 * `process.exit(1)`, this marker is never reached. If the guard reset state instead, the event
 * loop keeps running and the marker prints, after which the fixture exits cleanly with code 0.
 */
require('../../../dist/index.js');

const payload = JSON.parse(process.env.INJECTED_ERROR || '{}');
const mode = process.env.CRASH_MODE; // 'uncaughtException' | 'unhandledRejection'

console.log(
  'LISTENER_COUNTS_BEFORE_CRASH=' +
    JSON.stringify({
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    })
);

function makeInjectedError() {
  const err = new Error(payload.message || 'Connection terminated unexpectedly');
  if (payload.code) err.code = payload.code;
  return err;
}

setTimeout(() => {
  if (mode === 'unhandledRejection') {
    // Intentionally no .catch(): this must produce an unhandled rejection.
    Promise.reject(makeInjectedError());
  } else {
    throw makeInjectedError();
  }
}, 50);

// Scheduled independently of the throw/rejection above (not nested after it, since `throw`
// unwinds synchronously and any code following it in the same tick would be unreachable). If the
// process survived the throw/rejection (guard reset state instead of exiting), this later timer
// still fires and prints the marker. If the guard called process.exit(1), the process is already
// gone by the time this would fire.
setTimeout(() => {
  console.log('SURVIVED');
  process.exit(0);
}, 200);
