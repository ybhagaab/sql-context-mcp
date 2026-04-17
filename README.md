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

- Execute SQL queries with formatted results
- Browse schemas, tables, and columns
- Multiple authentication methods (Direct, IAM, Secrets Manager)
- SSL/TLS support with multiple modes
- Custom schema context presets (local, S3, or URL)
- Input validation and response sanitization

### Available Tools

| Tool | Description |
|------|-------------|
| `run_query` | Execute any SQL query |
| `list_schemas` | List all database schemas |
| `list_tables` | List tables in a schema |
| `describe_table` | Get column information for a table |
| `get_sample_data` | Preview rows from a table |
| `connection_status` | Check connection health |
| `get_schema_context` | Load custom schema knowledge |
| `list_presets` | List available schema context presets |

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
| `SQL_SSL_MODE` | No | `require` | SSL mode |
| `SQL_SSL_CA` | No | - | CA certificate path |
| `SQL_SSL_CERT` | No | - | Client certificate path |
| `SQL_SSL_KEY` | No | - | Client private key path |
| `SQL_CONTEXT_DIR` | No | - | Local directory with context files |
| `SQL_CONTEXT_FILE` | No | - | Single local context file path |
| `SQL_CONTEXT_S3` | No | - | S3 URI (`s3://bucket/prefix/`) |
| `SQL_CONTEXT_URL` | No | - | HTTP/HTTPS URL to context file |

*Can be provided via Secrets Manager secret

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
- Input validation via Zod schemas
- Response sanitization strips hidden/control characters
- Configurable limits (max 10K rows, 1MB response)

---

## Development

```bash
git clone https://github.com/ybhagaab/sql-context-preset-mcp
cd sql-context-preset-mcp
npm install
npm run build
npm start
```

## License

MIT
