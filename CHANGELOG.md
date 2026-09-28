# Changelog

## 1.5.0

### Added: results of any size

- **Pages with exact totals.** `run_query` returns as many rows as fit in a page (100 rows and
  100,000 characters by default; `maxRows` and `maxChars` per call) and always reports the exact
  total row count: from `stv_active_cursors` on Redshift, from a scroll cursor on PostgreSQL, or
  by counting.
- **`fetch_rows`.** Continues a result by its `resultId` without running the query again. Results
  are spooled to a local file (any offset works), or keep their cursor open when very large
  (forward only, at most 3 at once, closed after 15 idle minutes).
- **`export_query` and `export_status`.** Stream a complete result to a CSV or JSONL file, with a
  schema sidecar and a 10-row preview. No row or size limit by default, with optional caps. A
  background mode (`wait: false`) with status and cancel, a queue of 2 concurrent exports, and a
  free-space reserve. Exports don't use a cursor, so Redshift's cursor size limits don't apply, and
  memory stays flat (checked with 5 million rows).
- **Formats.** `format: "table" | "csv" | "json"`. JSON and JSONL hold exact values: numbers only
  where lossless, and `int8`, `numeric`, dates and intervals as the database's text. CSV follows
  RFC 4180, with NULL as an empty field.
- **Scripts.** Several statements in one call run in order on one connection. The last result is
  shown, with a summary of the others.
- **Long-running queries.** A per-call `timeoutMs` and a default `SQL_STATEMENT_TIMEOUT_MS`.
  Cancelling a tool call cancels its query on the database (protocol-level cancel, with
  `pg_cancel_backend` as a fallback), even when every pooled connection is busy. Progress
  notifications every 30 seconds.
- **Server instructions** tell assistants when to aggregate in SQL, page, or export.
- New environment variables for all of the above. Each has a default, so upgrading needs no
  configuration change.

### Fixed

- The row count in the footer was wrong on Redshift, which sends no count for SELECT. It now shows
  the exact total.
- Duplicate or number-like column names (for example `a, a` or `"2025"`) no longer misalign rows.
- INTERVAL and other values the driver parses into objects no longer fail the whole query. They
  show as the database's text.
- Multi-statement SQL no longer fails with `Cannot read properties of undefined (reading 'map')`.
- `get_sample_data` honors its `limit` (up to 1,000) instead of showing at most 100 rows.
- Column widths come from the rows on the page, so one wide row later in a result no longer widens
  the table.
- Session settings can't leak into later calls through a reused connection: a connection that ran
  a script, changed a setting, or was left in a transaction is closed instead of reused.

### Changed

- A plain `{ "sql": "..." }` call keeps the same table layout. The visible differences are the
  correct total in the footer and a `More rows: fetch_rows {...}` line when more rows exist.
- The catalog tools (`list_schemas`, `list_tables`, `describe_table`) use the same page budget, and
  a very large catalog pages with `fetch_rows`.
- Session settings don't persist between calls (true in practice since 1.4.0's pool). Put `SET`
  and the query in the same call.
- For loading complete data into other programs, prefer `export_query` with `format: "jsonl"`.
- Cancellation no longer uses pg's deprecated `Client.activeQuery`, so pg 8.20 prints no
  deprecation warning.

## 1.4.0

### Changed — Concurrent query execution

Previously every query was funneled through one shared cached database connection. node-postgres
serializes queries issued on a single connection through an internal queue, so N concurrent MCP
tool calls executed one-by-one — concurrent callers silently waited in line, and long queries
could push later ones past client-side timeouts.

- **Per-query connection checkout.** `run_query` and the other database tools now check a
  connection out of a pool per query (`pool.query()`), so concurrent tool calls genuinely run in
  parallel on separate connections.
- **New `SQL_POOL_MAX` environment variable.** Controls the pool size — the maximum number of
  simultaneously executing queries. Defaults to 10; invalid values fall back to 10.
- **Reliability behavior preserved.** The 1.3.1 fixes carry over: bounded reconnect-and-retry on
  connection-level errors (now discarding and rebuilding the whole pool, with the drain running
  in the background so retries never wait on other in-flight queries), IAM credential-expiry
  recycling, TCP keepalive, process-level crash guards, and no retries for SQL/validation errors.
- **Fixed pool-discard connection leak.** Error-recovery paths previously dropped the pool
  reference without closing it; discarded pools are now always drained.
- **Cleaner published artifacts.** Test files are no longer compiled into `dist/`.

## 1.3.1

### Fixed — Connection reliability

The server could crash or become unresponsive on transient database connectivity issues
(network blips, idle-connection timeouts, dropped sockets), requiring a manual restart. The MCP
client would continue to show the server as "connected" while every tool call failed or hung.
This release fixes the root causes so the server recovers automatically:

- **No more crashes on pool errors.** The underlying connection pool now has an error handler
  attached, so an idle-connection fault (e.g. the database closing an idle socket) is logged and
  the connection state is reset instead of crashing the process.
- **Automatic reconnect-and-retry.** If a query fails because the connection was dropped mid-query,
  the server now discards the dead connection, reconnects, and retries the query automatically (up
  to 3 attempts with a short backoff) — no manual restart needed. Errors from invalid SQL or failed
  validation are never retried, only genuine connection failures.
- **Stale connections are detected before reuse.** Previously, a cached connection was reused
  without checking whether it was still alive (this only happened for IAM auth on credential
  expiry). Now every authentication method (`direct`, `iam`, `secrets_manager`) checks connection
  liveness before reuse and transparently reconnects if it's dead.
- **Proactive dead-socket detection.** TCP keepalive is now enabled on the connection pool, so dead
  connections are detected sooner rather than only failing on the next query.
- **Crash guards at the process level.** Unhandled exceptions or promise rejections are now caught
  and logged; connection-related faults reset the connection state and keep the server running,
  while genuinely unrecoverable errors still exit cleanly (with a clear log) rather than hanging
  silently.
- **Clearer SSL configuration errors.** A missing or unreadable `SQL_SSL_CA`/`SQL_SSL_CERT`/
  `SQL_SSL_KEY` file now produces an error naming the specific environment variable and file path,
  instead of a raw filesystem error.

No changes to tool behavior, inputs, or outputs — existing queries, formatting, and error messages
for invalid SQL/input are unaffected.

## 1.3.0

Initial tracked release.
