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
exports.ensurePool = ensurePool;
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
// Connection pooling state. Queries check a client out of `pool` per call (`pool.query()`), so
// concurrent MCP tool calls execute on separate connections in parallel (up to the pool's `max`)
// instead of serializing on a single shared cached client.
let pool = null;
// Creation-race guard: when multiple concurrent queries find `pool === null`, only one
// `createPool()` runs; the rest await the same in-flight promise instead of racing to create (and
// leak) extra pools.
let creatingPool = null;
let iamCredentialsCache = null;
// NOTE: `__setTestConnectionState`/`__getTestConnectionState` are additive test-only seams for the
// mcp-server-connection-reliability bugfix spec's property-based bug-condition/preservation tests
// (see opensource/src/index.stale-connection.exploration.test.ts). They allow injecting a mocked
// `pool` and `iamCredentialsCache` expiry state before calling the exported `ensurePool()`,
// without changing any production code path: nothing in `main()` or the tool handlers ever calls
// these functions, so normal CLI/bin execution behavior is unchanged. Setting `pool` also clears
// any in-flight `creatingPool` promise so each test starts from a deterministic state.
function __setTestConnectionState(state) {
    if ('pool' in state) {
        pool = state.pool ?? null;
        creatingPool = null;
    }
    if ('iamCredentialsCache' in state)
        iamCredentialsCache = state.iamCredentialsCache ?? null;
}
function __getTestConnectionState() {
    return { pool, iamCredentialsCache };
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
// used for `ensurePool()`/`executeQuery()`. No production call site changes: `main()` and
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
// Pool sizing: how many connections (and therefore how many truly concurrent queries) the pool
// may open. Overridable via SQL_POOL_MAX; defaults to pg's own default of 10.
function getPoolMax() {
    const parsed = parseInt(process.env.SQL_POOL_MAX || '', 10);
    if (Number.isFinite(parsed) && parsed >= 1)
        return parsed;
    return 10;
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
        max: getPoolMax(),
    };
}
const CONNECTION_LEVEL_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);
const CONNECTION_LEVEL_ERROR_MESSAGE_PHRASES = [
    'Connection terminated',
    'terminated unexpectedly',
    'Client has encountered a connection error',
    // Benign race under concurrency: a query may hold a reference to a pool that a concurrent
    // query's failure has just discarded (drained via `pool.end()`). pg then rejects new checkouts
    // with this message; classifying it as connection-level lets the bounded retry transparently
    // pick up the replacement pool.
    'Cannot use a pool after calling end',
];
// NOTE: Exported as an additive test-only seam for the mcp-server-connection-reliability bugfix
// spec (Task 13.1, see opensource/src/index.connection-error-classifier.test.ts and the
// mid-query-retry/app-error-no-retry property tests), mirroring the same minimal-seam precedent
// used for `ensurePool()`/`executeQuery()`/`buildSSLConfig()`. Classifies an error as
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
/**
 * Discards a pool so the next `ensurePool()` call rebuilds from scratch, without blocking the
 * caller on in-flight queries.
 *
 * Compare-and-swap semantics: only the FIRST discarder of the currently-active pool clears the
 * module reference and initiates the drain. Concurrent failures on the same (already-discarded)
 * pool, or failures on a stale pool reference after a replacement was created, are no-ops — they
 * must never stomp a healthy replacement pool.
 *
 * The drain (`pool.end()`) runs in the background: it lets queries still executing on the old
 * pool's other connections finish before their sockets close, while the caller immediately
 * proceeds to reconnect/retry. Drain errors are logged, never thrown.
 */
function discardPool(failedPool) {
    if (pool === failedPool) {
        pool = null;
        creatingPool = null;
        failedPool.end().catch((err) => console.error('[pool drain error]', err));
    }
}
async function createPool() {
    const config = await getConnectionConfig();
    const newPool = new pg_1.Pool(config);
    newPool.on('error', (err) => {
        // Background error on an idle pooled connection: log and discard this pool so the next tool
        // call rebuilds it. Never re-throw and never exit — pg emits this for e.g. an idle socket
        // dropped by the server, which is recoverable.
        console.error('[pool error]', err);
        discardPool(newPool);
    });
    // Eager connectivity validation, preserving the old post-connect `SELECT 1` semantics: config/
    // auth/network problems surface here (inside executeQuery's classified retry loop) rather than
    // on the first real query. The validated connection is returned to the pool as an idle client.
    await newPool.query('SELECT 1');
    pool = newPool;
    return newPool;
}
/**
 * Returns the active connection pool, creating it if needed.
 *
 * Replaces the previous `ensureConnection(): Promise<PoolClient>` single-cached-client pattern:
 * callers now run queries via `pool.query()`, which checks a client out PER QUERY, so concurrent
 * MCP tool calls genuinely execute in parallel (up to `max` connections) instead of serializing
 * on one shared client.
 *
 * The old per-reuse `SELECT 1` liveness check does not map to a pool (each query may get a
 * different pooled connection, and pg provides no checkout-time validation hook); staleness is
 * instead handled reactively by `executeQuery()`'s bounded retry: a connection-level failure
 * discards the WHOLE pool (covering the "every idle connection died while the laptop slept"
 * case) and the retry rebuilds it fresh. `keepAlive` remains enabled as proactive mitigation.
 *
 * IAM credential expiry is preserved as an independent recycling trigger: the pool's config
 * captures the password at creation time, so once the cached IAM credentials expire the pool
 * must be discarded before it mints any new connection with the stale password.
 */
async function ensurePool() {
    const authMethod = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase();
    const iamCredentialsExpired = authMethod === 'iam' && !!iamCredentialsCache && Date.now() >= iamCredentialsCache.expiry;
    if (pool && iamCredentialsExpired) {
        discardPool(pool);
    }
    if (pool)
        return pool;
    if (!creatingPool) {
        creatingPool = createPool().finally(() => {
            creatingPool = null;
        });
    }
    return creatingPool;
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
        // The pool this attempt actually ran against, captured so the catch block discards THAT pool
        // (compare-and-swap inside discardPool), never a replacement created by a concurrent retry.
        let activePool = null;
        try {
            // `ensurePool()` is inside this try/catch (not just the query call) so that a
            // connection-level error surfacing during pool creation itself (e.g. its eager `SELECT 1`
            // validation failing on a persistently dead network) is also classified and retried,
            // rather than escaping the bounded retry loop early.
            activePool = await ensurePool();
            const startTime = Date.now();
            // Per-query checkout: `pool.query()` acquires a client from the pool, runs the query, and
            // releases it — so concurrent executeQuery() calls run in parallel on separate connections
            // (up to the pool's `max`) instead of serializing on one shared client. pg automatically
            // destroys (rather than returns to the pool) a client whose query failed at the
            // connection level.
            const result = await activePool.query(sql, params);
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
            // Connection-level error: discard the pool this attempt used (if it is still the active
            // one) so the next ensurePool() call rebuilds it from scratch. Discarding the WHOLE pool —
            // not just the one dead connection — covers the case where every idle connection died
            // together (e.g. network drop); the drain of in-flight queries happens in the background.
            if (activePool) {
                discardPool(activePool);
            }
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
// precedent used for `ensurePool()`/`executeQuery()`/`buildSSLConfig()`. No production call
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
const server = new index_js_1.Server({ name: 'sql-context-presets-mcp', version: '1.4.0' }, { capabilities: { tools: {} } });
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
                    const activePool = await ensurePool();
                    const result = await activePool.query(`
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
// precedent used for `ensurePool()`/`executeQuery()`/`buildSSLConfig()`/`formatResults()`.
// Graceful shutdown: drain the pool (releasing all idle connections, letting in-flight queries
// finish) and then exit(0). With per-query checkout there is no long-lived client to release
// first; `pool.end()` errors are swallowed so shutdown always reaches exit(0).
async function handleSigint() {
    if (pool)
        await pool.end().catch(() => undefined);
    process.exit(0);
}
process.on('SIGINT', handleSigint);
// NOTE: Process-level crash guards for the mcp-server-connection-reliability bugfix spec (Task
// 14.1, design.md "Fix Implementation" change 5 / Correctness Property 1, Requirements 1.5, 2.5).
// These are registered at module scope (like the SIGINT handler above), so any error not caught
// by the tool-handler try/catch or the `pool.on('error', ...)` listener — e.g. an unexpected
// async rejection elsewhere — is logged with full context instead of crashing the process with no
// diagnostics. Connection-level errors (per `isConnectionLevelError()`, Task 13.1) discard the
// active pool so the next tool call transparently reconnects, matching the discard pattern used
// in `ensurePool()`/`executeQuery()`. Genuinely unrecoverable (non-connection)
// errors still log clearly and exit the process, preserving the "unrecoverable errors still exit"
// requirement — this guard must never degrade into "the process never exits."
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack || err);
    if (isConnectionLevelError(err)) {
        if (pool)
            discardPool(pool);
    }
    else {
        process.exit(1);
    }
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason) : reason);
    if (isConnectionLevelError(reason)) {
        if (pool)
            discardPool(pool);
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
