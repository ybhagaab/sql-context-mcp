#!/usr/bin/env node
/**
 * SQL Context Presets MCP Server
 *
 * Provides tools for executing SQL queries on PostgreSQL/Redshift databases
 * via the Model Context Protocol.
 *
 * Supports multiple authentication methods:
 * - Direct username/password
 * - AWS IAM Authentication (Redshift)
 * - AWS Secrets Manager
 *
 * Security Features:
 * - Zod schema validation for all inputs and outputs
 * - Response content sanitization (hidden character stripping)
 * - Response size limits
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Pool, PoolClient } from 'pg';
import { ZodError } from 'zod';
import { listPresetsAsync, getPresetAsync } from './presets/index.js';
import {
  RunQueryInputSchema,
  ListTablesInputSchema,
  DescribeTableInputSchema,
  GetSampleDataInputSchema,
  GetSchemaContextInputSchema,
  QueryResultSchema,
  LIMITS,
} from './validation/schemas.js';
import {
  sanitizeString,
  sanitizeRows,
  sanitizeColumns,
  sanitizeResponseText,
  truncateString,
} from './validation/sanitizer.js';

let pool: Pool | null = null;
let client: PoolClient | null = null;
let iamCredentialsCache: { user: string; password: string; expiry: number } | null = null;

type AuthMethod = 'direct' | 'iam' | 'secrets_manager';

async function getSecretsManagerCredentials(): Promise<{
  host?: string; port?: number; database?: string; user: string; password: string;
}> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const secretId = process.env.SQL_SECRET_ID;
  if (!secretId) throw new Error('SQL_SECRET_ID is required when using secrets_manager authentication');

  const region = process.env.SQL_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const clientConfig: any = { region };
  if (process.env.SQL_AWS_PROFILE) process.env.AWS_PROFILE = process.env.SQL_AWS_PROFILE;

  const smClient = new SecretsManagerClient(clientConfig);
  try {
    const response = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!response.SecretString) throw new Error('Secret does not contain a string value');
    const secret = JSON.parse(response.SecretString);
    return {
      host: secret.host || secret.hostname || secret.endpoint,
      port: secret.port ? parseInt(secret.port, 10) : undefined,
      database: secret.database || secret.dbname || secret.db,
      user: secret.username || secret.user,
      password: secret.password,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to retrieve secret from Secrets Manager: ${message}`);
  }
}

async function getIAMCredentials(): Promise<{ user: string; password: string }> {
  if (iamCredentialsCache && Date.now() < iamCredentialsCache.expiry) {
    return { user: iamCredentialsCache.user, password: iamCredentialsCache.password };
  }

  const { RedshiftClient, GetClusterCredentialsCommand } = await import('@aws-sdk/client-redshift');
  const clusterId = process.env.SQL_CLUSTER_ID;
  const dbUser = process.env.SQL_USER;
  const database = process.env.SQL_DATABASE;

  if (!clusterId) throw new Error('SQL_CLUSTER_ID is required when using IAM authentication');
  if (!dbUser) throw new Error('SQL_USER is required when using IAM authentication (Redshift database user)');
  if (!database) throw new Error('SQL_DATABASE is required when using IAM authentication');

  const region = process.env.SQL_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const clientConfig: any = { region };
  if (process.env.SQL_AWS_PROFILE) process.env.AWS_PROFILE = process.env.SQL_AWS_PROFILE;

  const rsClient = new RedshiftClient(clientConfig);
  try {
    const response = await rsClient.send(new GetClusterCredentialsCommand({
      ClusterIdentifier: clusterId, DbUser: dbUser, DbName: database,
      DurationSeconds: 900, AutoCreate: false,
    }));
    if (!response.DbUser || !response.DbPassword) throw new Error('IAM authentication did not return credentials');
    iamCredentialsCache = {
      user: response.DbUser, password: response.DbPassword,
      expiry: Date.now() + (14 * 60 * 1000),
    };
    return { user: response.DbUser, password: response.DbPassword };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to get IAM credentials: ${message}`);
  }
}

function buildSSLConfig(): boolean | object {
  const sslMode = process.env.SQL_SSL_MODE || 'require';
  if (sslMode === 'disable') return false;
  const sslConfig: any = {};
  switch (sslMode) {
    case 'require': sslConfig.rejectUnauthorized = false; break;
    case 'verify-ca':
    case 'verify-full':
      sslConfig.rejectUnauthorized = true;
      if (process.env.SQL_SSL_CA) {
        const fs = require('fs');
        sslConfig.ca = fs.readFileSync(process.env.SQL_SSL_CA);
      }
      break;
    default: sslConfig.rejectUnauthorized = false;
  }
  if (process.env.SQL_SSL_CERT && process.env.SQL_SSL_KEY) {
    const fs = require('fs');
    sslConfig.cert = fs.readFileSync(process.env.SQL_SSL_CERT);
    sslConfig.key = fs.readFileSync(process.env.SQL_SSL_KEY);
  }
  return sslConfig;
}

async function getConnectionConfig(): Promise<{
  host: string; port: number; database: string; user: string; password: string; ssl: boolean | object;
}> {
  const authMethod = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase() as AuthMethod;
  let host = process.env.SQL_HOST;
  let port = parseInt(process.env.SQL_PORT || '5439', 10);
  let database = process.env.SQL_DATABASE;
  let user = process.env.SQL_USER;
  let password = process.env.SQL_PASSWORD;

  switch (authMethod) {
    case 'secrets_manager': {
      const creds = await getSecretsManagerCredentials();
      host = creds.host || host; port = creds.port || port;
      database = creds.database || database; user = creds.user; password = creds.password;
      break;
    }
    case 'iam': {
      const creds = await getIAMCredentials();
      user = creds.user; password = creds.password;
      break;
    }
    case 'direct': default: break;
  }

  if (!host) throw new Error('Missing SQL_HOST. Set it directly or include in Secrets Manager secret.');
  if (!database) throw new Error('Missing SQL_DATABASE. Set it directly or include in Secrets Manager secret.');
  if (!user || !password) throw new Error(`Missing credentials. For auth method '${authMethod}', ensure required variables are set.`);
  return { host, port, database, user, password, ssl: buildSSLConfig() };
}

async function ensureConnection(): Promise<PoolClient> {
  if (client) {
    const authMethod = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase();
    if (authMethod === 'iam' && iamCredentialsCache && Date.now() >= iamCredentialsCache.expiry) {
      if (client) client.release();
      if (pool) await pool.end();
      client = null; pool = null;
    } else {
      return client;
    }
  }
  const config = await getConnectionConfig();
  pool = new Pool(config);
  client = await pool.connect();
  await client.query('SELECT 1');
  return client;
}

async function executeQuery(sql: string, params?: any[]): Promise<{
  columns: string[]; rows: any[][]; rowCount: number; executionTime: number;
}> {
  const conn = await ensureConnection();
  const startTime = Date.now();
  const result = await conn.query(sql, params);
  const executionTime = Date.now() - startTime;
  const columns = sanitizeColumns(result.fields.map(f => f.name));
  const rawRows = result.rows.map(row => Object.values(row));
  const limitedRows = rawRows.slice(0, LIMITS.MAX_ROWS);
  const rows = sanitizeRows(limitedRows);
  const queryResult = { columns, rows, rowCount: result.rowCount || 0, executionTime };
  return QueryResultSchema.parse(queryResult);
}

function formatResults(result: { columns: string[]; rows: any[][]; rowCount: number; executionTime: number }): string {
  if (result.rows.length === 0) {
    return sanitizeResponseText(`Query executed successfully. ${result.rowCount} rows affected. (${result.executionTime}ms)`);
  }
  const widths = result.columns.map((col, i) => {
    const maxDataWidth = Math.max(...result.rows.map(row => String(row[i] ?? 'NULL').length));
    return Math.max(col.length, maxDataWidth, 4);
  });
  const header = result.columns.map((col, i) => col.padEnd(widths[i])).join(' | ');
  const separator = widths.map(w => '-'.repeat(w)).join('-+-');
  const displayRows = result.rows.slice(0, 100);
  const rowStrings = displayRows.map(row =>
    row.map((val, i) => String(val ?? 'NULL').padEnd(widths[i])).join(' | ')
  );
  let output = `${header}\n${separator}\n${rowStrings.join('\n')}`;
  if (result.rows.length > 100) output += `\n... (${result.rows.length - 100} more rows)`;
  output += `\n\n${result.rowCount} rows returned. (${result.executionTime}ms)`;
  return truncateString(sanitizeResponseText(output), LIMITS.MAX_RESPONSE_LENGTH);
}

const tools: Tool[] = [
  {
    name: 'run_query',
    description: 'Execute a SQL query on the connected database. Returns results as a formatted table. TIP: If you\'re unfamiliar with the schema, use list_presets and get_schema_context first to learn about tables, columns, and required filters.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'The SQL query to execute' } }, required: ['sql'] },
  },
  { name: 'list_schemas', description: 'List all schemas in the database (excluding system schemas)', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'list_tables', description: 'List all tables in a schema',
    inputSchema: { type: 'object', properties: { schema: { type: 'string', description: 'Schema name (default: public)', default: 'public' } } },
  },
  {
    name: 'describe_table', description: 'Get column information for a table',
    inputSchema: { type: 'object', properties: { table: { type: 'string', description: 'Table name (can include schema prefix like schema.table)' } }, required: ['table'] },
  },
  {
    name: 'get_sample_data', description: 'Get sample rows from a table',
    inputSchema: { type: 'object', properties: { table: { type: 'string', description: 'Table name (can include schema prefix)' }, limit: { type: 'number', description: 'Number of rows to return (default: 5)', default: 5 } }, required: ['table'] },
  },
  { name: 'connection_status', description: 'Check the current database connection status', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'get_schema_context',
    description: 'IMPORTANT: Load schema knowledge, query patterns, and best practices for this database. Call this FIRST before writing queries to learn about table structures, required filters, and common patterns. Use list_presets to see available contexts.',
    inputSchema: { type: 'object', properties: { preset: { type: 'string', description: 'Schema preset name (use list_presets to see available options)' } }, required: ['preset'] },
  },
  { name: 'list_presets', description: 'List all available schema context presets. RECOMMENDED: Call this first when working with an unfamiliar database to discover available documentation and best practices.', inputSchema: { type: 'object', properties: {} } },
];

const server = new Server(
  { name: 'sql-context-presets-mcp', version: '1.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'run_query': {
        const validated = RunQueryInputSchema.parse(args);
        const result = await executeQuery(validated.sql);
        return { content: [{ type: 'text', text: formatResults(result) }] };
      }
      case 'list_schemas': {
        const result = await executeQuery(`
          SELECT schema_name FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_internal')
          ORDER BY schema_name
        `);
        return { content: [{ type: 'text', text: formatResults(result) }] };
      }
      case 'list_tables': {
        const validated = ListTablesInputSchema.parse(args);
        const result = await executeQuery(`
          SELECT table_name, table_type FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name
        `, [validated.schema]);
        return { content: [{ type: 'text', text: formatResults(result) }] };
      }
      case 'describe_table': {
        const validated = DescribeTableInputSchema.parse(args);
        const parts = validated.table.split('.');
        const schema = parts.length > 1 ? parts[0] : 'public';
        const tableName = parts.length > 1 ? parts[1] : parts[0];
        const result = await executeQuery(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, tableName]);
        return { content: [{ type: 'text', text: formatResults(result) }] };
      }
      case 'get_sample_data': {
        const validated = GetSampleDataInputSchema.parse(args);
        if (validated.limit <= 0) throw new Error('Limit must be a positive number');
        const result = await executeQuery(`SELECT * FROM ${validated.table} LIMIT ${validated.limit}`);
        return { content: [{ type: 'text', text: formatResults(result) }] };
      }
      case 'connection_status': {
        try {
          const conn = await ensureConnection();
          const result = await conn.query(`
            SELECT current_database() as database, current_user as user, inet_server_addr() as host
          `);
          const row = result.rows[0];
          return { content: [{ type: 'text', text: sanitizeResponseText(
            `Connected\nDatabase: ${row.database}\nUser: ${row.user}\nHost: ${row.host || process.env.SQL_HOST}`
          ) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: sanitizeResponseText(
            `Not connected: ${error instanceof Error ? error.message : 'Unknown error'}`
          ) }] };
        }
      }
      case 'get_schema_context': {
        const validated = GetSchemaContextInputSchema.parse(args);
        const preset = await getPresetAsync(validated.preset);
        if (!preset) {
          const available = await listPresetsAsync();
          const availableText = available.length > 0
            ? `Available presets: ${available.join(', ')}`
            : 'No presets available. Set SQL_CONTEXT_DIR, SQL_CONTEXT_S3, or SQL_CONTEXT_URL environment variable to load context files.';
          return { content: [{ type: 'text', text: sanitizeResponseText(`Unknown preset: ${validated.preset}\n\n${availableText}`) }], isError: true };
        }
        const responseText = truncateString(
          sanitizeResponseText(`# ${preset.name}\n\n${preset.description}\n\n${preset.context}`),
          LIMITS.MAX_RESPONSE_LENGTH
        );
        return { content: [{ type: 'text', text: responseText }] };
      }
      case 'list_presets': {
        const presets = await listPresetsAsync();
        if (presets.length === 0) {
          return { content: [{ type: 'text', text: sanitizeResponseText(
            `# No Schema Presets Available\n\nTo add custom presets, set environment variables:\n- \`SQL_CONTEXT_DIR\`: Local directory containing .md or .json files\n- \`SQL_CONTEXT_S3\`: S3 URI (s3://bucket/prefix/) containing context files\n- \`SQL_CONTEXT_URL\`: HTTP/HTTPS URL to a single context file\n- \`SQL_CONTEXT_FILE\`: Path to a single local context file`
          ) }] };
        }
        const presetDetails = await Promise.all(presets.map(async name => {
          const preset = await getPresetAsync(name);
          return `- **${sanitizeString(name)}**: ${sanitizeString(preset?.description || 'No description')}`;
        }));
        return { content: [{ type: 'text', text: sanitizeResponseText(
          `# Available Schema Presets\n\n${presetDetails.join('\n')}\n\nUse \`get_schema_context\` with a preset name to load the context.`
        ) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { content: [{ type: 'text', text: sanitizeResponseText(`Validation Error: ${issues}`) }], isError: true };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { content: [{ type: 'text', text: sanitizeResponseText(`Error: ${message}`) }], isError: true };
  }
});

process.on('SIGINT', async () => {
  if (client) client.release();
  if (pool) await pool.end();
  process.exit(0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('SQL Context Presets MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
