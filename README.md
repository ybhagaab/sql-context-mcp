# SQL Context Presets MCP Server

[![npm version](https://img.shields.io/npm/v/sql-context-presets-mcp.svg)](https://www.npmjs.com/package/sql-context-presets-mcp)
[![npm downloads](https://img.shields.io/npm/dm/sql-context-presets-mcp.svg)](https://www.npmjs.com/package/sql-context-presets-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that lets any AI assistant query your database with zero prior knowledge. Schema context is loaded on-demand via presets — no steering files, no training, no wasted tokens. Point it at your database, drop in a context file, and your assistant understands your schema immediately.

## Install

```bash
npm install -g sql-context-presets-mcp
```

Or run directly with npx (no install needed):

```bash
npx -y sql-context-presets-mcp
```

## Quick Start

No installation needed — just add to your MCP client config:

```json
{
  "mcpServers": {
    "sql-context-presets": {
      "command": "npx",
      "args": ["-y", "sql-context-presets-mcp"],
      "env": {
        "SQL_HOST": "your-host.example.com",
        "SQL_PORT": "5432",
        "SQL_DATABASE": "your_database",
        "SQL_USER": "your_username",
        "SQL_PASSWORD": "your_password",
        "SQL_SSL_MODE": "require"
      }
    }
  }
}
```

## Features

- Execute SQL and get one page of the result, sized for model context, with the exact total row count
- Page through large results with `fetch_rows`, without running the query again
- Export complete results of any size to CSV or JSONL files with `export_query`
- Output as a readable table, CSV, or typed JSON with exact values
- Multi-statement scripts, run in order on one connection
- Timeouts, cancellation, and progress notifications for long-running queries
- Concurrent query execution: each query checks a connection out of a pool (up to `SQL_POOL_MAX`, default 10), so parallel tool calls run in parallel instead of queueing on one connection
- Errors that name the likely cause and the fix (VPN, network, DNS, TLS, login, AWS credentials, SQL), and a
  step-by-step `connection_status`
- Automatic reconnect-and-retry on connection-level failures (bounded, with backoff; SQL that may change data is
  never sent twice)
- Browse schemas, tables, and columns
- Multiple authentication methods (Direct, IAM, Secrets Manager)
- SSL/TLS support with multiple modes
- Custom schema context presets (local, S3, or URL)
- Input validation and response sanitization

### Available Tools

| Tool | Description |
|------|-------------|
| `run_query` | Execute SQL; returns a page of the result with the exact total |
| `fetch_rows` | Read the next page of a result, by its `resultId` |
| `export_query` | Stream a complete result to a CSV or JSONL file |
| `export_status` | Check or cancel an export started with `wait: false` |
| `list_schemas` | List all database schemas |
| `list_tables` | List tables in a schema |
| `describe_table` | Get column information for a table |
| `get_sample_data` | Preview rows from a table (up to 1,000) |
| `connection_status` | Check the connection step by step (settings, DNS, network, login) |
| `get_schema_context` | Load custom schema knowledge |
| `list_presets` | List available schema context presets |

---

## Working with Results

### Pages and exact totals

`run_query` returns as many rows as fit in a page: by default 100 rows (`maxRows`) and 100,000
characters (`maxChars`). Every response includes the exact total row count. When more rows exist,
it also includes a `resultId`:

```
event_date | campaign_id | installs
-----------+-------------+---------
...
... (1694 more rows)

More rows: fetch_rows {"resultId":"r_7k2mq4x9d3p8w1ab"}; full result: export_query
1794 rows returned. (2300ms)
```

For analysis in chat, aggregate in SQL (`GROUP BY`, `COUNT`, `SUM`) rather than paging through raw
rows. `maxRows` (up to 1,000,000) and `maxChars` (up to 5,000,000 by default) are meant for
programs that load data.

### Formats

| `format` | Output |
|----------|--------|
| `table` (default) | The readable padded table shown above |
| `csv` | Two text blocks: the CSV data (header and rows) in the first, the status lines in the second, so the first block can be parsed directly |
| `json` | One object: `columns` (`name`, `type`), `rows` (arrays of exact values), `rowCount` (rows in this page), `offset`, `totalRows`, `hasMore`, `truncated` (same as `hasMore`), `resultId`, `executionTimeMs`, and `statements` for scripts |

Values in `json` (and `jsonl` exports) are exact: `int2`, `int4`, `oid` and finite floats are
numbers, booleans are `true`/`false`, and everything else (`int8`, `numeric`, dates, timestamps,
intervals, `super`) is the database's text, so nothing loses precision. NULL is `null`.

In CSV, NULL is an empty unquoted field and an empty string is `""`. A row whose only column is
NULL is therefore an empty line, which some CSV readers skip. Use JSON or JSONL when NULLs must be
exact.

### Paging with `fetch_rows`

`fetch_rows` takes the `resultId` and the same `format`, `maxRows` and `maxChars` options. It
continues where the previous page ended, or starts at `offset`.

- Most results are written to a local spool file in the background, and the database connection
  is released as soon as that finishes. Any offset works.
- A result larger than `SQL_SPOOL_THRESHOLD_BYTES` (100 MB) keeps its database cursor open instead,
  at most `SQL_MAX_OPEN_CURSORS` (3) at a time. It can only move forward, and it closes after 15
  minutes without a `fetch_rows` call. When every slot is taken, `run_query` still returns the first
  page and the exact total, and suggests `export_query`.
- Results are kept until the server restarts. Spool files share a 2 GB budget per server process;
  the least recently used results are evicted first.

### Exports with `export_query`

`export_query` runs the SQL and streams the complete result to a file, with no row or size limit
by default. The response has the file path, a schema file (`<file>.schema.json`: columns with
names, types and OIDs, row count, size, and a SHA-256 of the SQL), the row count, size, duration,
the columns, and a 10-row preview. The data itself isn't returned. Clients on MCP 2025-06-18 or
later also get a `resource_link` to the file.

```json
{ "sql": "select * from events where event_date >= '2026-09-01'", "format": "jsonl", "fileName": "events" }
```

- `format`: `csv` (default) or `jsonl` (one JSON array of exact values per line).
- `wait: false` returns an `exportId` straight away; poll `export_status` for rows and bytes
  written, and pass `cancel: true` to stop it. At most `SQL_EXPORT_CONCURRENCY` (2) exports run at
  once; others wait in line.
- `maxRows` and `maxBytes` stop the export early and mark it `truncated`.
- Exports stream without a database cursor, so Redshift's cursor size limits don't apply, and
  memory stays flat whatever the size. Writing stops before free disk space drops below
  `SQL_EXPORT_MIN_FREE_BYTES` (1 GB).
- Export files hold the database's raw text. Hidden-character sanitization applies to inline
  responses only.

Files go to `SQL_EXPORT_DIR`, or by default to the OS cache folder:

- macOS: `~/Library/Caches/sql-context-presets`
- Linux: `$XDG_CACHE_HOME/sql-context-presets`, or `~/.cache/sql-context-presets`
- Windows: `%LOCALAPPDATA%\sql-context-presets\Cache`

Each server process writes into its own `<pid>-<start time>/` folder (with `exports/` and
`spool/`), readable only by your user. At startup, the server deletes the folders of server
processes that are no longer running. It never deletes exports at any other time, so move files you
want to keep.

### Scripts and session settings

- `sql` may contain several statements separated by semicolons. They run in order on one
  connection. The result of the last statement is shown, with a summary of the others
  (`Earlier statements: SET`) just above the row-count line.
- Scripts with `BEGIN`/`COMMIT` run exactly as written.
- Session settings don't carry over to the next call, so put `SET` and the query in the same call.
  A connection that ran a script, changed a setting, or was left in a transaction is closed
  instead of being reused.

### Long-running queries

- Queries run as long as they need. Set `timeoutMs` on a call, or `SQL_STATEMENT_TIMEOUT_MS` as the
  default; a statement that runs longer is cancelled on the database.
- Cancelling a tool call in your MCP client cancels its query on the database.
- When the client asks for progress, the server reports it every 30 seconds, which keeps clients
  that reset their request timeout on progress waiting for 15 to 20 minute queries. If your client
  still times out, use `export_query` with `wait: false` and poll `export_status`.

### Loading data into other programs

Use `export_query` with `format: "jsonl"` and read the file. For smaller results, `run_query` with
`format: "json"` and a large `maxChars`, followed by `fetch_rows` until `hasMore` is false, also
works.

---

## Errors and troubleshooting

When a call fails, the error says what failed, the likely cause, how to fix it, and whether any SQL
ran. With the VPN disconnected, for example:

```
Error: Could not reach the database server at my-cluster.example.com:5439: the connection attempt timed out.
Likely cause: The host name resolves to a private address (10.20.30.40), which is only reachable through a VPN, a peered network or an SSH tunnel, and that path is not working.
To fix: Connect to the VPN (or start the SSH tunnel), then retry.
Checked: the host name resolves to 10.20.30.40 (private); a TCP connection to 10.20.30.40:5439 got no answer within 3 s; 2 connection attempts over 20 s, each stopped by the 10 s connect timeout (SQL_CONNECT_TIMEOUT_MS).
Error type: network_timeout. No SQL was run.
```

Database errors keep the database's message on the first line. They add the SQLSTATE, the
database's detail and hint, and, when the database reports one, the error position as a line and
column of your SQL. On Redshift:

```
Error: syntax error at or near "from" in context "as installs, from", at line 3, column 1
To fix: Correct the SQL at the position shown.
At line 3, column 1:
  from installs
  ^
Error type: sql_error (SQLSTATE 42601 syntax_error).
```

The last line gives the error type and what happened to the SQL: `No SQL was run.`, which
statement of a script failed and which ones had completed, or, after a lost connection, whether a
statement that changes data may have run. The server's own errors (invalid arguments,
cancellation, timeouts, paging and export limits) stay one line. `export_status` reports the same
text in `error` and the type in `errorType`.

| Error type | Meaning | Usual fix |
|------------|---------|-----------|
| `config` | A setting is missing or invalid | Set it in the server's `env`, then reconnect the server |
| `aws_credentials` | IAM or Secrets Manager credentials couldn't be obtained: none found, expired, access denied, cluster or secret not found, or AWS unreachable | Refresh the credentials, or check `SQL_AWS_PROFILE`, `SQL_CLUSTER_ID`, `SQL_SECRET_ID` and `SQL_AWS_REGION` |
| `dns` | The host name doesn't resolve | Check `SQL_HOST`; private names need the VPN |
| `network_timeout` | The server didn't answer. For a private address, the VPN or tunnel is down | Connect to the VPN, or check the firewall or security group |
| `network_unreachable` | No network route to the server | Connect to the network or VPN |
| `connection_refused` | Nothing listens on the port. On localhost, the SSH tunnel isn't running | Check `SQL_PORT`; start the tunnel or the database |
| `connect_timeout` | The server accepted the connection but didn't finish the login in time | Retry; check the server; raise `SQL_CONNECT_TIMEOUT_MS` |
| `tls` | The SSL settings don't match the server, or its certificate can't be verified | Change `SQL_SSL_MODE`, or set `SQL_SSL_CA` |
| `auth` | The login was rejected | Fix `SQL_USER` and `SQL_PASSWORD`, the IAM database user, or the secret |
| `database_not_found` | `SQL_DATABASE` doesn't exist | Fix `SQL_DATABASE` |
| `too_many_connections` | The server's connection limit is reached | Close idle sessions, or lower `SQL_POOL_MAX` |
| `server_unavailable` | The server is starting up or paused, or it closed the connection during the login | Wait and retry |
| `connection_lost` | The connection dropped while SQL was running | Reconnect and run it again; for statements that change data, check first |
| `sql_error` | The database rejected the SQL | Fix the SQL |
| `permission_denied` | The database user lacks a privilege | Query objects the user can read, or ask for a grant |
| `server_timeout` | The database cancelled the query (`statement_timeout`, or a Redshift WLM rule) | Make the query cheaper, or ask about the limit |

`connection_status` checks each step and reports the first one that fails:

```
Not connected: Could not reach the database server at my-cluster.example.com:5439: the connection attempt timed out.
Likely cause: The host name resolves to a private address (10.20.30.40), which is only reachable through a VPN, a peered network or an SSH tunnel, and that path is not working.
To fix: Connect to the VPN (or start the SSH tunnel), then retry.
Checks:
  Settings: ok (password login, user analyst, database analytics at my-cluster.example.com:5439, SSL mode require)
  DNS: ok (resolves to 10.20.30.40, private)
  Network: failed (no answer from 10.20.30.40:5439 within 5 s)
  Login: not checked
Error type: network_timeout.
```

When connected, it shows the database, user and host as before, then the server version, the
round-trip time and pool use.

Each connection attempt is limited to `SQL_CONNECT_TIMEOUT_MS` (10 seconds), so an unreachable
database fails in about 20 seconds instead of several minutes. A connect that timed out is tried
twice; refused, unroutable and unresolvable connects aren't retried. A connection lost while SQL
runs is retried (up to 3 attempts) only when that's safe: before any row arrived, before any
statement of a script completed, and never after SQL that may change data was sent.

---

## Authentication Methods

### Method 1: Direct Authentication (Default)

```json
{
  "mcpServers": {
    "sql-context-presets": {
      "command": "npx",
      "args": ["-y", "sql-context-presets-mcp"],
      "env": {
        "SQL_AUTH_METHOD": "direct",
        "SQL_HOST": "your-host.example.com",
        "SQL_PORT": "5439",
        "SQL_DATABASE": "your_database",
        "SQL_USER": "your_username",
        "SQL_PASSWORD": "your_password",
        "SQL_SSL_MODE": "require"
      }
    }
  }
}
```

### Method 2: IAM Authentication (Redshift)

Use AWS IAM to get temporary database credentials. No password storage needed.

```json
{
  "mcpServers": {
    "sql-context-presets": {
      "command": "npx",
      "args": ["-y", "sql-context-presets-mcp"],
      "env": {
        "SQL_AUTH_METHOD": "iam",
        "SQL_HOST": "your-cluster.xxxx.us-east-1.redshift.amazonaws.com",
        "SQL_PORT": "5439",
        "SQL_DATABASE": "your_database",
        "SQL_USER": "your_db_user",
        "SQL_CLUSTER_ID": "your-cluster",
        "SQL_AWS_REGION": "us-east-1",
        "SQL_SSL_MODE": "require"
      }
    }
  }
}
```

Required IAM Policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "redshift:GetClusterCredentials",
    "Resource": [
      "arn:aws:redshift:us-east-1:123456789012:dbuser:your-cluster/your_db_user",
      "arn:aws:redshift:us-east-1:123456789012:dbname:your-cluster/your_database"
    ]
  }]
}
```

### Method 3: AWS Secrets Manager

```json
{
  "mcpServers": {
    "sql-context-presets": {
      "command": "npx",
      "args": ["-y", "sql-context-presets-mcp"],
      "env": {
        "SQL_AUTH_METHOD": "secrets_manager",
        "SQL_SECRET_ID": "my/redshift-credentials",
        "SQL_AWS_REGION": "us-east-1",
        "SQL_SSL_MODE": "require"
      }
    }
  }
}
```

Secret JSON format:
```json
{
  "username": "db_user",
  "password": "db_password",
  "host": "your-host.example.com",
  "port": 5439,
  "database": "your_database"
}
```

---

## SSL Configuration

| Mode | Description | Use Case |
|------|-------------|----------|
| `disable` | No SSL | SSH tunnels, local development |
| `require` | SSL on, skip cert verification | VPC endpoints (default) |
| `verify-ca` | SSL on, verify CA certificate | Production with custom CA |
| `verify-full` | SSL on, verify cert + hostname | Highest security |

---

## SSH Tunnel Setup

```bash
ssh -L 5439:internal-db-host:5439 bastion-user@bastion-host
```

Then set `SQL_HOST=localhost`, `SQL_PORT=5439`, `SQL_SSL_MODE=disable`.

---

## Schema Context Presets

Provide custom schema documentation so your AI assistant understands your database immediately.

### Local Directory

```json
{ "env": { "SQL_CONTEXT_DIR": "/path/to/team-contexts" } }
```

### S3 Bucket (Team Sharing)

```json
{
  "env": {
    "SQL_CONTEXT_S3": "s3://my-team-bucket/schema-contexts/",
    "SQL_AWS_REGION": "us-east-1"
  }
}
```

All `.md` and `.json` files in the bucket/prefix will be loaded as presets. Requires `s3:ListBucket` and `s3:GetObject` permissions.

### HTTP/HTTPS URL

```json
{ "env": { "SQL_CONTEXT_URL": "https://wiki.example.com/schema-docs/analytics.md" } }
```

### File Formats

Markdown (`my-schema.md`):
```markdown
# Analytics Schema

## Main Tables
- user_events - User activity tracking
- transactions - Payment data

## Required Filters
Always include: `status = 'active'`
```

JSON (`my-schema.json`):
```json
{
  "name": "Analytics",
  "description": "Team analytics database",
  "context": "# Schema documentation here..."
}
```

---

## Complete Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SQL_HOST` | Yes* | - | Database host |
| `SQL_PORT` | No | `5439` | Database port |
| `SQL_DATABASE` | Yes* | - | Database name |
| `SQL_AUTH_METHOD` | No | `direct` | `direct`, `iam`, or `secrets_manager` |
| `SQL_USER` | Direct/IAM | - | Database username |
| `SQL_PASSWORD` | Direct | - | Database password |
| `SQL_CLUSTER_ID` | IAM | - | Redshift cluster identifier |
| `SQL_SECRET_ID` | SM | - | Secrets Manager secret name/ARN |
| `SQL_AWS_REGION` | IAM/SM | `us-east-1` | AWS region |
| `SQL_AWS_PROFILE` | No | - | AWS profile name |
| `SQL_POOL_MAX` | No | `10` | Max pooled connections = max concurrent queries |
| `SQL_CONNECT_TIMEOUT_MS` | No | `10000` (10 s) | Time limit for opening one connection (network, TLS and login); `0` waits for the operating system |
| `SQL_DEFAULT_MAX_ROWS` | No | `100` | Default rows per page |
| `SQL_MAX_INLINE_CHARS` | No | `100000` | Default page budget, in characters |
| `SQL_MAX_INLINE_CHARS_CEILING` | No | `5000000` | Largest `maxChars` a call may request |
| `SQL_FETCH_BATCH_ROWS` | No | `5000` | Rows per cursor FETCH (at most 1,000 on single-node Redshift) |
| `SQL_STATEMENT_TIMEOUT_MS` | No | `0` (none) | Default statement timeout for `run_query` and `export_query` |
| `SQL_PROGRESS_INTERVAL_MS` | No | `30000` | How often progress is reported |
| `SQL_SPOOL_THRESHOLD_BYTES` | No | `104857600` (100 MB) | Largest result that is spooled for paging rather than kept as an open cursor |
| `SQL_SPOOL_MAX_TOTAL_BYTES` | No | `2147483648` (2 GB) | Spool budget per server process |
| `SQL_MAX_OPEN_CURSORS` | No | `3` | Open-cursor results at once |
| `SQL_CURSOR_IDLE_TTL_MS` | No | `900000` (15 min) | Idle time before an open cursor closes |
| `SQL_EXPORT_CONCURRENCY` | No | `2` | Exports running at once |
| `SQL_EXPORT_DIR` | No | OS cache folder | Base folder for exports and spool files |
| `SQL_EXPORT_MAX_ROWS` | No | - (no limit) | Optional row cap for exports |
| `SQL_EXPORT_MAX_BYTES` | No | - (no limit) | Optional size cap for exports |
| `SQL_EXPORT_MIN_FREE_BYTES` | No | `1073741824` (1 GB) | Stop writing files before free disk space drops below this; `0` disables |
| `SQL_SSL_MODE` | No | `require` | SSL mode |
| `SQL_SSL_CA` | No | - | CA certificate path |
| `SQL_SSL_CERT` | No | - | Client certificate path |
| `SQL_SSL_KEY` | No | - | Client private key path |
| `SQL_CONTEXT_DIR` | No | - | Local directory with context files |
| `SQL_CONTEXT_FILE` | No | - | Single local context file path |
| `SQL_CONTEXT_S3` | No | - | S3 URI (`s3://bucket/prefix/`) |
| `SQL_CONTEXT_URL` | No | - | HTTP/HTTPS URL to context file |

*Can be provided via Secrets Manager secret

Invalid values fall back to the default, with a warning on stderr. Open cursors plus concurrent
exports always leave at least one pooled connection free; if the settings don't, the server lowers
both and logs it.

---

## Why MCP Schema Presets?

| Aspect | Steering Files | MCP Schema Presets |
|--------|---------------|-------------------|
| Scope | Workspace-bound | Works across all workspaces |
| Loading | Always loaded | On-demand, selective |
| Multi-schema | All load together | Pick exactly which to load |
| Sharing | Copy to each workspace | Shared folder, S3, or URL |
| Discovery | Must know filename | `list_presets` shows all |

---

## Security

- Credentials via environment variables only (never stored in code)
- IAM auth uses temporary credentials that auto-expire
- Secrets Manager supports automatic credential rotation
- SSL enabled by default
- Runs over stdio only; it opens no network port
- Input validation via Zod schemas
- Response sanitization strips hidden/control characters from every inline format
- Page budgets (100,000 characters by default, 5,000,000 at most) keep responses bounded
- Export and spool files are written only inside a per-process folder readable by your user alone
  (folders 0700, files 0600). Callers can't choose paths, and `fileName` is reduced to safe
  characters. Export files contain raw data, without sanitization.
- `run_query` runs any SQL the database user is allowed to run. Give AI assistants a read-only
  database user.

---

## Development

```bash
git clone https://github.com/ybhagaab/sql-context-mcp
cd sql-context-mcp
npm install
npm run build
npm test
npm start
```

`npm test` runs the unit, property and integration tests against an in-memory fake database.
`npm run test:memory` runs the full memory-bound check (5 million rows through every path).

`npm run test:live` runs read-only tests against a real Redshift cluster. Set
`SQL_LIVE_TABLE=schema.table` (a small table you can read) and, for the export test,
`SQL_LIVE_BIG_TABLE=schema.table` (at least 500,000 rows). Connection settings come from the
`SQL_*` variables, or from an MCP client config (`SQL_LIVE_MCP_CONFIG`, default
`~/.kiro/settings/mcp.json`, server `sql-context-presets`).

## License

MIT
