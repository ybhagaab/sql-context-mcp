/**
 * Opt-in live tests against a real database. They run only when SQL_LIVE_TESTS=1 and the usual
 * SQL_* connection variables are set (see scripts/live-tests.cjs). Live tests must issue read-only
 * queries only.
 */
export const LIVE_ENABLED = process.env.SQL_LIVE_TESTS === '1';
