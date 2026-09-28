"use strict";
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
exports.MAX_QUERY_ATTEMPTS = void 0;
exports.__setTestConnectionState = __setTestConnectionState;
exports.__getTestConnectionState = __getTestConnectionState;
exports.buildSSLConfig = buildSSLConfig;
exports.getPoolMax = getPoolMax;
exports.isConnectionLevelError = isConnectionLevelError;
exports.discardPool = discardPool;
exports.discardActivePool = discardActivePool;
exports.getActivePool = getActivePool;
exports.getLastConnectionConfig = getLastConnectionConfig;
exports.ensurePool = ensurePool;
exports.withConnectionRetry = withConnectionRetry;
/**
 * Connection pool, authentication, SSL configuration, error classification, and the bounded
 * reconnect-and-retry helper.
 *
 * Moved from index.ts unchanged in behavior (mcp-server-connection-reliability spec): per-query
 * pool checkout, creation-race guard, compare-and-swap pool discard with background drain, IAM
 * credential-expiry recycling, keepalive, and connection-level error classification.
 */
const pg_1 = require("pg");
const zod_1 = require("zod");
// Connection pooling state. Queries check a client out of `pool` per call, so concurrent MCP tool
// calls execute on separate connections in parallel (up to the pool's `max`) instead of
// serializing on a single shared cached client.
let pool = null;
// Creation-race guard: when multiple concurrent queries find `pool === null`, only one
// `createPool()` runs; the rest await the same in-flight promise instead of racing to create (and
// leak) extra pools.
let creatingPool = null;
let iamCredentialsCache = null;
// The config the active pool was created with. Used to open short-lived side connections, e.g.
// to cancel a running query while every pooled connection is busy.
let lastConnectionConfig = null;
// NOTE: `__setTestConnectionState`/`__getTestConnectionState` are test-only seams (see the
// reliability tests). They inject a mocked `pool` and `iamCredentialsCache` expiry state before
// calling `ensurePool()`, without changing any production code path. Setting `pool` also clears
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
// NOTE: Exported as a test-only seam (see the SSL config tests). Production code reaches this
// function only via `getConnectionConfig()`.
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
/**
 * Classifies an error as connection-level (socket/connection fault, eligible for the bounded
 * reconnect-and-retry) vs application-level (ZodError, SQL syntax/constraint errors, or anything
 * else), which must never be retried.
 */
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
 * pool, or failures on a stale pool reference after a replacement was created, are no-ops.
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
/** Discards the active pool, if any (used by the process-level crash guards). */
function discardActivePool() {
    if (pool)
        discardPool(pool);
}
/** The active pool, or null. */
function getActivePool() {
    return pool;
}
/** The connection config the most recent pool was created with, or null. */
function getLastConnectionConfig() {
    return lastConnectionConfig;
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
    // Eager connectivity validation: config/auth/network problems surface here (inside the
    // classified retry loop) rather than on the first real query. The validated connection is
    // returned to the pool as an idle client.
    await newPool.query('SELECT 1');
    lastConnectionConfig = config;
    pool = newPool;
    return newPool;
}
/**
 * Returns the active connection pool, creating it if needed.
 *
 * Staleness is handled reactively by the bounded retry: a connection-level failure discards the
 * WHOLE pool and the retry rebuilds it fresh. `keepAlive` remains enabled as proactive
 * mitigation. IAM credential expiry is an independent recycling trigger: the pool's config
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
// Bounded reconnect-and-retry configuration: 3 total attempts with a short exponential backoff
// (100ms, then 300ms) between retries.
exports.MAX_QUERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MILLIS = [100, 300];
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Runs `operation` against the active pool with bounded reconnect-and-retry.
 *
 * `ensurePool()` runs inside the retry loop so a connection-level error during pool creation
 * itself is also retried. On a connection-level error the pool the attempt used is discarded
 * (compare-and-swap) and, after a short backoff, the operation is retried, up to
 * MAX_QUERY_ATTEMPTS in total. Application-level errors are re-thrown immediately.
 *
 * `canRetry` lets callers forbid retries once retrying would be unsafe or wasteful, for example
 * after rows were delivered or after an earlier script statement completed.
 */
async function withConnectionRetry(operation, options = {}) {
    for (let attempt = 1; attempt <= exports.MAX_QUERY_ATTEMPTS; attempt++) {
        let activePool = null;
        try {
            activePool = await ensurePool();
            return await operation(activePool, attempt);
        }
        catch (error) {
            if (!isConnectionLevelError(error)) {
                throw error;
            }
            if (activePool) {
                discardPool(activePool);
            }
            if (attempt >= exports.MAX_QUERY_ATTEMPTS || (options.canRetry && !options.canRetry())) {
                throw error;
            }
            const backoffMillis = RETRY_BACKOFF_MILLIS[Math.min(attempt - 1, RETRY_BACKOFF_MILLIS.length - 1)];
            await delay(backoffMillis);
        }
    }
    // Unreachable: the loop above always either returns or throws.
    throw new Error('withConnectionRetry: exhausted retries without a result');
}
