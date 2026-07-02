# Changelog

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
