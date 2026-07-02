#!/usr/bin/env node
"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.__setTestConnectionState = __setTestConnectionState;
exports.__getTestConnectionState = __getTestConnectionState;
exports.buildSSLConfig = buildSSLConfig;
exports.isConnectionLevelError = isConnectionLevelError;
exports.ensureConnection = ensureConnection;
exports.executeQuery = executeQuery;
exports.formatResults = formatResults;
exports.handleSigint = handleSigint;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const pg_1 = require("pg");
const zod_1 = require("zod");
const index_js_2 = require("./presets/index.js");
const schemas_js_1 = require("./validation/schemas.js");
const sanitizer_js_1 = require("./validation/sanitizer.js");
let pool = null;
let client = null;
let iamCredentialsCache = null;
// NOTE: `__setTestConnectionState`/`__getTestConnectionState` are additive test-only seams for the
// mcp-server-connection-reliability bugfix spec's property-based bug-condition/preservation tests
// (see opensource/src/index.stale-connection.exploration.test.ts). They allow injecting a mocked
// cached `client`/`pool` and `iamCredentialsCache` expiry state before calling the exported
// `ensureConnection()`, without changing any production code path: nothing in `main()` or the tool
// handlers ever calls these functions, so normal CLI/bin execution behavior is unchanged.
function __setTestConnectionState(state) {
    if ('client' in state)
        client = state.client ?? null;
    if ('pool' in state)
        pool = state.pool ?? null;
    if ('iamCredentialsCache' in state)
        iamCredentialsCache = state.iamCredentialsCache ?? null;
}
function __getTestConnectionState() {
    return { client, pool, iamCredentialsCache };
}
async function getSecretsManagerCredentials() {
    const { SecretsManagerClient, GetSecretValueCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/client-secrets-manager')));
    const secretId = process.env.SQL_SECRET_ID;
    if (!secretId)
        throw new Error('SQL_SECRET_ID is required when using secrets_manager authentication');
    const region = process.env.SQL_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
    const clientConfig = { region };
    if (process.env.SQL_AWS_PROFILE)
        process.env.AWS_PROFILE = process.env.SQL_AWS_PROFILE;
    const smClient = new SecretsManagerClient(clientConfig);
    try {
        const response = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
        if (!response.SecretString)
            throw new Error('Secret does not contain a string value');
        const secret = JSON.parse(response.SecretString);
        return {
            host: secret.host || secret.hostname || secret.endpoint,
            port: secret.port ? parseInt(secret.port, 10) : undefined,
            database: secret.database || secret.dbname || secret.db,
            user: secret.username || secret.user,
            password: secret.password,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to retrieve secret from Secrets Manager: ${message}`);
    }
}
async function getIAMCredentials() {
    if (iamCredentialsCache && Date.now() < iamCredentialsCache.expiry) {
        return { user: iamCredentialsCache.user, password: iamCredentialsCache.password };
    }
    const { RedshiftClient, GetClusterCredentialsCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/client-redshift')));
    const clusterId = process.env.SQL_CLUSTER_ID;
    const dbUser = process.env.SQL_USER;
    const database = process.env.SQL_DATABASE;
    if (!clusterId)
        throw new Error('SQL_CLUSTER_ID is required when using IAM authentication');
    if (!dbUser)
        throw new Error('SQL_USER is required when using IAM authentication (Redshift database user)');
    if (!database)
        throw new Error('SQL_DATABASE is required when using IAM authentication');
    const region = process.env.SQL_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
    const clientConfig = { region };
    if (process.env.SQL_AWS_PROFILE)
        process.env.AWS_PROFILE = process.env.SQL_AWS_PROFILE;
    const rsClient = new RedshiftClient(clientConfig);
    try {
        const response = await rsClient.send(new GetClusterCredentialsCommand({
            ClusterIdentifier: clusterId, DbUser: dbUser, DbName: database,
            DurationSeconds: 900, AutoCreate: false,
        }));
        if (!response.DbUser || !response.DbPassword)
            throw new Error('IAM authentication did not return credentials');
        iamCredentialsCache = {
            user: response.DbUser, password: response.DbPassword,
            expiry: Date.now() + (14 * 60 * 1000),
        };
        return { user: response.DbUser, password: response.DbPassword };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to get IAM credentials: ${message}`);
    }
}
// NOTE: Exported as an additive test-only seam for the mcp-server-connection-reliability bugfix
// spec's property-based bug-condition/preservation tests (see
// opensource/src/index.ssl-config.exploration.test.ts), mirroring the same minimal-seam precedent
// used for `ensureConnection()`/`executeQuery()`. No production call site changes: `main()` and
// the tool handlers still reach this function only via `getConnectionConfig()`.
function buildSSLConfig() {
    const sslMode = process.env.SQL_SSL_MODE || 'require';
    if (sslMode === 'disable')
        return false;
    const sslConfig = {};
    switch (sslMode) {
        case 'require':
            sslConfig.rejectUnauthorized = false;
            break;
        case 'verify-ca':
        case 'verify-full':
            sslConfig.rejectUnauthorized = true;
            if (process.env.SQL_SSL_CA) {
                const fs = require('fs');
                try {
                    sslConfig.ca = fs.readFileSync(process.env.SQL_SSL_CA);
                }
                catch (error) {
                    const originalMessage = error instanceof Error ? error.message : String(error);
                    throw new Error(`Failed to load SQL_SSL_CA file at "${process.env.SQL_SSL_CA}": ${originalMessage}`);
                }
            }
            break;
        default: sslConfig.rejectUnauthorized = false;
    }
    if (process.env.SQL_SSL_CERT && process.env.SQL_SSL_KEY) {
        const fs = require('fs');
        try {
            sslConfig.cert = fs.readFileSync(process.env.SQL_SSL_CERT);
        }
        catch (error) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to load SQL_SSL_CERT file at "${process.env.SQL_SSL_CERT}": ${originalMessage}`);
        }
        try {
            sslConfig.key = fs.readFileSync(process.env.SQL_SSL_KEY);
        }
        catch (error) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to load SQL_SSL_KEY file at "${process.env.SQL_SSL_KEY}": ${originalMessage}`);
        }
    }
    return sslConfig;
}
async function getConnectionConfig() {
    const authMethod = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase();
    let host = process.env.SQL_HOST;
    let port = parseInt(process.env.SQL_PORT || '5439', 10);
    let database = process.env.SQL_DATABASE;
    let user = process.env.SQL_USER;
    let password = process.env.SQL_PASSWORD;
    switch (authMethod) {
        case 'secrets_manager': {
            const creds = await getSecretsManagerCredentials();
            host = creds.host || host;
            port = creds.port || port;
            database = creds.database || database;
            user = creds.user;
            password = creds.password;
            break;
        }
        case 'iam': {
            const creds = await getIAMCredentials();
            user = creds.user;
            password = creds.password;
            break;
        }
        case 'direct':
        default: break;
    }
    if (!host)
        throw new Error('Missing SQL_HOST. Set it directly or include in Secrets Manager secret.');
    if (!database)
        throw new Error('Missing SQL_DATABASE. Set it directly or include in Secrets Manager secret.');
    if (!user || !password)
        throw new Error(`Missing credentials. For auth method '${authMethod}', ensure required variables are set.`);
    return {
        host, port, database, user, password, ssl: buildSSLConfig(),
        keepAlive: true, keepAliveInitialDelayMillis: 10000,
    };
}
const CONNECTION_LEVEL_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);
const CONNECTION_LEVEL_ERROR_MESSAGE_PHRASES = [
    'Connection terminated',
    'terminated unexpectedly',
    'Client has encountered a connection error',
];
// NOTE: Exported as an additive test-only seam for the mcp-server-connection-reliability bugfix
// spec (Task 13.1, see opensource/src/index.connection-error-classifier.test.ts and the
// mid-query-retry/app-error-no-retry property tests), mirroring the same minimal-seam precedent
// used for `ensureConnection()`/`executeQuery()`/`buildSSLConfig()`. Classifies an error as
// connection-level (socket/connection fault, eligible for the bounded reconnect-and-retry wrapper
// in `executeQuery()`, Task 13.2) vs application-level (ZodError, SQL syntax/constraint errors,
// or anything else) which must never be retried.
function isConnectionLevelError(error) {
    if (error instanceof zod_1.ZodError)
        return false;
    if (error && typeof error === 'object') {
        const code = error.code;
        if (typeof code === 'string' && CONNECTION_LEVEL_ERROR_CODES.has(code))
            return true;
    }
    const message = error instanceof Error
        ? error.message
        : typeof error?.message === 'string'
            ? error.message
            : undefined;
    if (typeof message === 'string') {
        return CONNECTION_LEVEL_ERROR_MESSAGE_PHRASES.some((phrase) => message.includes(phrase));
    }
    return false;
}
async function ensureConnection() {
    if (client) {
        const authMethod = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase();
        // IAM credential expiry is an independent condition that always forces recycling, regardless
        // of whether the cached client's socket is still alive. This check must fire (and discard the
        // client/pool) without ever attempting a liveness check against an already-doomed client.
        const iamCredentialsExpired = authMethod === 'iam' && !!iamCredentialsCache && Date.now() >= iamCredentialsCache.expiry;
        if (iamCredentialsExpired) {
            if (client)
                client.release();
            if (pool)
                await pool.end();
            client = null;
            pool = null;
        }
        else {
            // Auth-method-agnostic liveness check: a cached client is only reused if it survives a
            // lightweight `SELECT 1`. If it throws (e.g. a dropped TCP connection), discard the stale
            // client/pool and fall through to reconnection instead of returning a dead connection.
            let isLive = true;
            try {
                await client.query('SELECT 1');
            }
            catch {
                isLive = false;
            }
            if (isLive) {
                return client;
            }
            if (client)
                client.release();
            if (pool)
                await pool.end();
            client = null;
            pool = null;
        }
    }
    const config = await getConnectionConfig();
    pool = new pg_1.Pool(config);
    pool.on('error', (err) => {
        console.error('[pool error]', err);
        client = null;
        pool = null;
    });
    client = await pool.connect();
    await client.query('SELECT 1');
    return client;
}
// Bounded reconnect-and-retry configuration for `executeQuery()` (mcp-server-connection-reliability
// bugfix spec, Task 13.2, design.md "Fix Implementation" change 4 / Correctness Property 5). 3 total
// attempts with a short exponential backoff (100ms, then 300ms) between retries.
const MAX_QUERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MILLIS = [100, 300];
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function executeQuery(sql, params) {
    for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
        try {
            // `ensureConnection()` is inside this try/catch (not just `conn.query(...)`) so that a
            // connection-level error surfacing during reconnection itself (e.g. its own post-connect
            // liveness check failing on a persistently dead network) is also classified and retried,
            // rather than escaping the bounded retry loop early.
            const conn = await ensureConnection();
            const startTime = Date.now();
            const result = await conn.query(sql, params);
            const executionTime = Date.now() - startTime;
            const columns = (0, sanitizer_js_1.sanitizeColumns)(result.fields.map(f => f.name));
            const rawRows = result.rows.map(row => Object.values(row));
            const limitedRows = rawRows.slice(0, schemas_js_1.LIMITS.MAX_ROWS);
            const rows = (0, sanitizer_js_1.sanitizeRows)(limitedRows);
            const queryResult = { columns, rows, rowCount: result.rowCount || 0, executionTime };
            return schemas_js_1.QueryResultSchema.parse(queryResult);
        }
        catch (error) {
            // Application-level errors (ZodError, pg syntax/constraint errors, or anything else not
            // classified as connection-level) are re-thrown immediately with no retry, preserving the
            // existing CallToolRequestSchema handler's error-formatting path.
            if (!isConnectionLevelError(error)) {
                throw error;
            }
            // Connection-level error: discard the dead client/pool so the next ensureConnection() call
            // rebuilds both from scratch, matching the discard pattern used elsewhere in this module.
            if (client)
                client.release();
            if (pool)
                await pool.end();
            client = null;
            pool = null;
            // Retries exhausted: return a clear error to the caller without crashing the process.
            if (attempt >= MAX_QUERY_ATTEMPTS) {
                throw error;
            }
            // Short exponential backoff before the next attempt.
            const backoffMillis = RETRY_BACKOFF_MILLIS[Math.min(attempt - 1, RETRY_BACKOFF_MILLIS.length - 1)];
            await delay(backoffMillis);
        }
    }
    // Unreachable: the loop above always either returns or throws.
    throw new Error('executeQuery: exhausted retries without a result');
}
// NOTE: Exported as an additive test-only seam for the mcp-server-connection-reliability bugfix
// spec's property-based preservation tests (see
// opensource/src/index.healthy-path.preservation.test.ts), mirroring the same minimal-seam
// precedent used for `ensureConnection()`/`executeQuery()`/`buildSSLConfig()`. No production call
// site changes: the `CallToolRequestSchema` handler below still calls this function exactly as
// before.
function formatResults(result) {
    if (result.rows.length === 0) {
        return (0, sanitizer_js_1.sanitizeResponseText)(`Query executed successfully. ${result.rowCount} rows affected. (${result.executionTime}ms)`);
    }
    const widths = result.columns.map((col, i) => {
        const maxDataWidth = Math.max(...result.rows.map(row => String(row[i] ?? 'NULL').length));
        return Math.max(col.length, maxDataWidth, 4);
    });
    const header = result.columns.map((col, i) => col.padEnd(widths[i])).join(' | ');
    const separator = widths.map(w => '-'.repeat(w)).join('-+-');
    const displayRows = result.rows.slice(0, 100);
    const rowStrings = displayRows.map(row => row.map((val, i) => String(val ?? 'NULL').padEnd(widths[i])).join(' | '));
    let output = `${header}\n${separator}\n${rowStrings.join('\n')}`;
    if (result.rows.length > 100)
        output += `\n... (${result.rows.length - 100} more rows)`;
    output += `\n\n${result.rowCount} rows returned. (${result.executionTime}ms)`;
    return (0, sanitizer_js_1.truncateString)((0, sanitizer_js_1.sanitizeResponseText)(output), schemas_js_1.LIMITS.MAX_RESPONSE_LENGTH);
}
const tools = [
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
const server = new index_js_1.Server({ name: 'sql-context-presets-mcp', version: '1.3.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case 'run_query': {
                const validated = schemas_js_1.RunQueryInputSchema.parse(args);
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
                const validated = schemas_js_1.ListTablesInputSchema.parse(args);
                const result = await executeQuery(`
          SELECT table_name, table_type FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name
        `, [validated.schema]);
                return { content: [{ type: 'text', text: formatResults(result) }] };
            }
            case 'describe_table': {
                const validated = schemas_js_1.DescribeTableInputSchema.parse(args);
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
                const validated = schemas_js_1.GetSampleDataInputSchema.parse(args);
                if (validated.limit <= 0)
                    throw new Error('Limit must be a positive number');
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
                    return { content: [{ type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(`Connected\nDatabase: ${row.database}\nUser: ${row.user}\nHost: ${row.host || process.env.SQL_HOST}`) }] };
                }
                catch (error) {
                    return { content: [{ type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(`Not connected: ${error instanceof Error ? error.message : 'Unknown error'}`) }] };
                }
            }
            case 'get_schema_context': {
                const validated = schemas_js_1.GetSchemaContextInputSchema.parse(args);
                const preset = await (0, index_js_2.getPresetAsync)(validated.preset);
                if (!preset) {
                    const available = await (0, index_js_2.listPresetsAsync)();
                    const availableText = available.length > 0
                        ? `Available presets: ${available.join(', ')}`
                        : 'No presets available. Set SQL_CONTEXT_DIR, SQL_CONTEXT_S3, or SQL_CONTEXT_URL environment variable to load context files.';
                    return { content: [{ type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(`Unknown preset: ${validated.preset}\n\n${availableText}`) }], isError: true };
                }
                const responseText = (0, sanitizer_js_1.truncateString)((0, sanitizer_js_1.sanitizeResponseText)(`# ${preset.name}\n\n${preset.description}\n\n${preset.context}`), schemas_js_1.LIMITS.MAX_RESPONSE_LENGTH);
                return { content: [{ type: 'text', text: responseText }] };
            }
            case 'list_presets': {
                const presets = await (0, index_js_2.listPresetsAsync)();
                if (presets.length === 0) {
                    return { content: [{ type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(`# No Schema Presets Available\n\nTo add custom presets, set environment variables:\n- \`SQL_CONTEXT_DIR\`: Local directory containing .md or .json files\n- \`SQL_CONTEXT_S3\`: S3 URI (s3://bucket/prefix/) containing context files\n- \`SQL_CONTEXT_URL\`: HTTP/HTTPS URL to a single context file\n- \`SQL_CONTEXT_FILE\`: Path to a single local context file`) }] };
                }
                const presetDetails = await Promise.all(presets.map(async (name) => {
                    const preset = await (0, index_js_2.getPresetAsync)(name);
                    return `- **${(0, sanitizer_js_1.sanitizeString)(name)}**: ${(0, sanitizer_js_1.sanitizeString)(preset?.description || 'No description')}`;
                }));
                return { content: [{ type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(`# Available Schema Presets\n\n${presetDetails.join('\n')}\n\nUse \`get_schema_context\` with a preset name to load the context.`) }] };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        if (error instanceof zod_1.ZodError) {
            const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return { content: [{ type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(`Validation Error: ${issues}`) }], isError: true };
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { content: [{ type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(`Error: ${message}`) }], isError: true };
    }
});
// NOTE: Extracted from the inline `process.on('SIGINT', ...)` callback as an additive test-only
// seam for the mcp-server-connection-reliability bugfix spec's property-based preservation tests
// (see opensource/src/index.healthy-path.preservation.test.ts), mirroring the same minimal-seam
// precedent used for `ensureConnection()`/`executeQuery()`/`buildSSLConfig()`/`formatResults()`.
// The SIGINT handler below still invokes this function with the exact same release()/end()/exit()
// call sequence as before — behavior is byte-for-byte unchanged.
async function handleSigint() {
    if (client)
        client.release();
    if (pool)
        await pool.end();
    process.exit(0);
}
process.on('SIGINT', handleSigint);
// NOTE: Process-level crash guards for the mcp-server-connection-reliability bugfix spec (Task
// 14.1, design.md "Fix Implementation" change 5 / Correctness Property 1, Requirements 1.5, 2.5).
// These are registered at module scope (like the SIGINT handler above), so any error not caught
// by the tool-handler try/catch or the `pool.on('error', ...)` listener — e.g. an unexpected
// async rejection elsewhere — is logged with full context instead of crashing the process with no
// diagnostics. Connection-level errors (per `isConnectionLevelError()`, Task 13.1) reset
// `client`/`pool` state so the next tool call transparently reconnects, matching the discard
// pattern used in `ensureConnection()`/`executeQuery()`. Genuinely unrecoverable (non-connection)
// errors still log clearly and exit the process, preserving the "unrecoverable errors still exit"
// requirement — this guard must never degrade into "the process never exits."
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack || err);
    if (isConnectionLevelError(err)) {
        client = null;
        pool = null;
    }
    else {
        process.exit(1);
    }
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason) : reason);
    if (isConnectionLevelError(reason)) {
        client = null;
        pool = null;
    }
    else {
        process.exit(1);
    }
});
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error('SQL Context Presets MCP Server running on stdio');
}
// Only auto-start the stdio server when this file is executed directly (normal `node
// dist/index.js` / bin invocation). When the module is `require`d by a test runner (e.g. Vitest,
// per the mcp-server-connection-reliability bugfix spec's exploration tests) this guard prevents
// the real MCP server from starting and touching stdio during `import`/`require`.
if (require.main === module) {
    main().catch((error) => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });
}
