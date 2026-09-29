/**
 * Connection pool, authentication, SSL configuration, error classification, and the bounded
 * reconnect-and-retry helper.
 *
 * Moved from index.ts unchanged in behavior (mcp-server-connection-reliability spec): per-query
 * pool checkout, creation-race guard, compare-and-swap pool discard with background drain, IAM
 * credential-expiry recycling, keepalive, and connection-level error classification.
 */
import { Pool, Client } from 'pg';
import { ZodError } from 'zod';
import { getConfig } from '../config';
import { annotate, setContext, contextOf, ConnectTarget } from '../errors/context';

// Connection pooling state. Queries check a client out of `pool` per call, so concurrent MCP tool
// calls execute on separate connections in parallel (up to the pool's `max`) instead of
// serializing on a single shared cached client.
let pool: Pool | null = null;
// Creation-race guard: when multiple concurrent queries find `pool === null`, only one
// `createPool()` runs; the rest await the same in-flight promise instead of racing to create (and
// leak) extra pools.
let creatingPool: Promise<Pool> | null = null;
let iamCredentialsCache: { user: string; password: string; expiry: number } | null = null;
// The config the active pool was created with. Used to open short-lived side connections, e.g.
// to cancel a running query while every pooled connection is busy.
let lastConnectionConfig: ConnectionConfig | null = null;

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean | object;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  max: number;
}

// NOTE: `__setTestConnectionState`/`__getTestConnectionState` are test-only seams (see the
// reliability tests). They inject a mocked `pool` and `iamCredentialsCache` expiry state before
// calling `ensurePool()`, without changing any production code path. Setting `pool` also clears
// any in-flight `creatingPool` promise so each test starts from a deterministic state.
export function __setTestConnectionState(state: {
  pool?: Pool | null;
  iamCredentialsCache?: { user: string; password: string; expiry: number } | null;
}): void {
  if ('pool' in state) {
    pool = state.pool ?? null;
    creatingPool = null;
  }
  if ('iamCredentialsCache' in state) iamCredentialsCache = state.iamCredentialsCache ?? null;
}

export function __getTestConnectionState(): {
  pool: Pool | null;
  iamCredentialsCache: { user: string; password: string; expiry: number } | null;
} {
  return { pool, iamCredentialsCache };
}

type AuthMethod = 'direct' | 'iam' | 'secrets_manager';

function authMethodOf(): AuthMethod {
  return (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase() as AuthMethod;
}

/** A settings problem: no connection was attempted. */
function configError(message: string): Error {
  return annotate(new Error(message), { phase: 'config', authMethod: authMethodOf() });
}

/** An AWS credential call failed. Keeps the SDK error as `cause`, so its name and code stay visible. */
function credentialsError(
  message: string,
  cause: unknown,
  aws: { service: 'redshift' | 'secretsmanager'; region: string; resource?: string },
): Error {
  return annotate(Object.assign(new Error(message), { cause }), { phase: 'credentials', authMethod: authMethodOf(), aws });
}

async function getSecretsManagerCredentials(): Promise<{
  host?: string; port?: number; database?: string; user: string; password: string;
}> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const secretId = process.env.SQL_SECRET_ID;
  if (!secretId) throw configError('SQL_SECRET_ID is required when using secrets_manager authentication');

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
    throw credentialsError(`Failed to retrieve secret from Secrets Manager: ${message}`, error, {
      service: 'secretsmanager', region, resource: secretId,
    });
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

  if (!clusterId) throw configError('SQL_CLUSTER_ID is required when using IAM authentication');
  if (!dbUser) throw configError('SQL_USER is required when using IAM authentication (Redshift database user)');
  if (!database) throw configError('SQL_DATABASE is required when using IAM authentication');

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
    throw credentialsError(`Failed to get IAM credentials: ${message}`, error, { service: 'redshift', region, resource: clusterId });
  }
}

// NOTE: Exported as a test-only seam (see the SSL config tests). Production code reaches this
// function only via `getConnectionConfig()`.
export function buildSSLConfig(): boolean | object {
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
        try {
          sslConfig.ca = fs.readFileSync(process.env.SQL_SSL_CA);
        } catch (error) {
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
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load SQL_SSL_CERT file at "${process.env.SQL_SSL_CERT}": ${originalMessage}`);
    }
    try {
      sslConfig.key = fs.readFileSync(process.env.SQL_SSL_KEY);
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load SQL_SSL_KEY file at "${process.env.SQL_SSL_KEY}": ${originalMessage}`);
    }
  }
  return sslConfig;
}

// Pool sizing: how many connections (and therefore how many truly concurrent queries) the pool
// may open. Overridable via SQL_POOL_MAX; defaults to pg's own default of 10.
export function getPoolMax(): number {
  const parsed = parseInt(process.env.SQL_POOL_MAX || '', 10);
  if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  return 10;
}

/**
 * Resolves the connection settings, including IAM or Secrets Manager credentials. Errors are
 * tagged with the phase that failed (`config` or `credentials`).
 */
export function resolveConnectionConfig(): Promise<ConnectionConfig> {
  return getConnectionConfig();
}

async function getConnectionConfig(): Promise<ConnectionConfig> {
  const authMethod = authMethodOf();
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

  if (!host) throw configError('Missing SQL_HOST. Set it directly or include in Secrets Manager secret.');
  if (!database) throw configError('Missing SQL_DATABASE. Set it directly or include in Secrets Manager secret.');
  if (!user || !password) throw configError(`Missing credentials. For auth method '${authMethod}', ensure required variables are set.`);
  let ssl: boolean | object;
  try {
    ssl = buildSSLConfig();
  } catch (error) {
    throw annotate(error, { phase: 'config', authMethod });
  }
  return {
    host, port, database, user, password, ssl,
    keepAlive: true, keepAliveInitialDelayMillis: 10000,
    max: getPoolMax(),
  };
}

/** The connect timeout in force (SQL_CONNECT_TIMEOUT_MS; 0 means none). */
export function connectTimeoutMs(): number {
  return getConfig().connectTimeoutMs;
}

type ConnectCallback = (err?: Error) => void;
interface ConnectableClient {
  connect: (callback?: ConnectCallback) => unknown;
  host?: unknown;
  port?: unknown;
}

/**
 * The client class the pool uses for new connections: pg's Client with the connect timeout
 * applied to that one connection, and connect errors tagged with the connect phase and target
 * (so no SQL is reported as sent). The timeout is per connection on purpose: pg-pool's own
 * `connectionTimeoutMillis` would also limit how long a query may wait for a free connection.
 *
 * Returns undefined when the driver has no Client export (test mocks); the pool then uses its
 * default.
 */
function connectingClientClass(timeoutMs: number): unknown {
  let Base: unknown;
  try {
    Base = Client;
  } catch {
    return undefined;
  }
  if (typeof Base !== 'function') return undefined;
  const Ctor = Base as new (config?: Record<string, unknown>) => ConnectableClient;
  return function ConnectingClient(config?: Record<string, unknown>): ConnectableClient {
    const client = new Ctor(timeoutMs > 0 ? { ...(config ?? {}), connectionTimeoutMillis: timeoutMs } : config);
    const connect = client.connect.bind(client);
    const target = (): ConnectTarget => ({
      host: String(client.host ?? config?.host ?? ''),
      port: Number(client.port ?? config?.port) || null,
    });
    const tag = (err: unknown): unknown => annotate(err, { phase: 'connect', target: target(), connectTimeoutMs: timeoutMs, authMethod: authMethodOf() });
    client.connect = (callback?: ConnectCallback): unknown => {
      if (typeof callback === 'function') {
        return connect((err?: Error) => {
          if (err) tag(err);
          callback(err);
        });
      }
      return Promise.resolve(connect()).catch((err: unknown) => {
        throw tag(err);
      });
    };
    return client;
  };
}

const CONNECTION_LEVEL_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  // The network path to the server went away (for example a VPN disconnect).
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL',
]);
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
export function isConnectionLevelError(error: unknown): boolean {
  if (error instanceof ZodError) return false;
  let code: unknown;
  if (error && typeof error === 'object') {
    code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_LEVEL_ERROR_CODES.has(code)) return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === 'string'
        ? (error as { message: string }).message
        : undefined;
  if (typeof message === 'string') {
    // pg's connect timeout (SQL_CONNECT_TIMEOUT_MS). A database error never has this text and no code.
    if (message === 'timeout expired' && code === undefined) return true;
    return CONNECTION_LEVEL_ERROR_MESSAGE_PHRASES.some((phrase) => message.includes(phrase));
  }
  return false;
}

/** Connect errors that an immediate retry won't fix: nothing listens, there is no route, or the name doesn't resolve. */
const NO_RETRY_CONNECT_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN']);
/** Connection attempts allowed when each one ends in a connect timeout. */
export const CONNECT_TIMEOUT_ATTEMPTS = 2;

function networkCodeOf(error: unknown): string | undefined {
  const e = error as { code?: unknown; errors?: unknown } | null;
  if (typeof e?.code === 'string') return e.code;
  if (Array.isArray(e?.errors)) {
    for (const inner of e.errors) {
      const code = (inner as { code?: unknown } | null)?.code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

function isConnectTimeout(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return (
    networkCodeOf(error) === 'ETIMEDOUT' ||
    message === 'timeout expired' ||
    (typeof message === 'string' && message.includes('timeout exceeded when trying to connect'))
  );
}

/** How many attempts a connection-level error allows: fewer for connect failures that won't clear in a moment. */
function attemptLimitFor(error: unknown): number {
  if (contextOf(error).phase !== 'connect') return MAX_QUERY_ATTEMPTS;
  const code = networkCodeOf(error);
  if (code && NO_RETRY_CONNECT_CODES.has(code)) return 1;
  if (isConnectTimeout(error)) return CONNECT_TIMEOUT_ATTEMPTS;
  return MAX_QUERY_ATTEMPTS;
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
export function discardPool(failedPool: Pool): void {
  if (pool === failedPool) {
    pool = null;
    creatingPool = null;
    failedPool.end().catch((err) => console.error('[pool drain error]', err));
  }
}

/** Discards the active pool, if any (used by the process-level crash guards). */
export function discardActivePool(): void {
  if (pool) discardPool(pool);
}

/** The active pool, or null. */
export function getActivePool(): Pool | null {
  return pool;
}

/** The connection config the most recent pool was created with, or null. */
export function getLastConnectionConfig(): ConnectionConfig | null {
  return lastConnectionConfig;
}

async function createPool(): Promise<Pool> {
  const config = await getConnectionConfig();
  const timeoutMs = connectTimeoutMs();
  const ClientClass = connectingClientClass(timeoutMs);
  const newPool = new Pool(ClientClass ? ({ ...config, Client: ClientClass } as never) : config);
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
  try {
    await newPool.query('SELECT 1');
  } catch (error) {
    // Only this server's validation query ran, so errors here belong to the connect phase.
    throw annotate(error, {
      phase: 'connect',
      target: { host: config.host, port: config.port },
      connectTimeoutMs: timeoutMs,
      authMethod: authMethodOf(),
    });
  }
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
export async function ensurePool(): Promise<Pool> {
  const authMethod = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase();
  const iamCredentialsExpired =
    authMethod === 'iam' && !!iamCredentialsCache && Date.now() >= iamCredentialsCache.expiry;

  if (pool && iamCredentialsExpired) {
    discardPool(pool);
  }

  if (pool) return pool;

  if (!creatingPool) {
    creatingPool = createPool().finally(() => {
      creatingPool = null;
    });
  }
  return creatingPool;
}

// Bounded reconnect-and-retry configuration: 3 total attempts with a short exponential backoff
// (100ms, then 300ms) between retries.
export const MAX_QUERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MILLIS = [100, 300];

function delay(ms: number): Promise<void> {
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
export async function withConnectionRetry<T>(
  operation: (activePool: Pool, attempt: number) => Promise<T>,
  options: { canRetry?: () => boolean } = {},
): Promise<T> {
  const started = Date.now();
  // The final error records how many attempts were made and how long they took.
  const final = (error: unknown, attempt: number): unknown => setContext(error, { attempts: attempt, elapsedMs: Date.now() - started });
  for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
    let activePool: Pool | null = null;
    try {
      activePool = await ensurePool();
      return await operation(activePool, attempt);
    } catch (error) {
      if (!isConnectionLevelError(error)) {
        throw final(error, attempt);
      }
      if (activePool) {
        discardPool(activePool);
      }
      if (attempt >= MAX_QUERY_ATTEMPTS || (options.canRetry && !options.canRetry())) {
        throw final(error, attempt);
      }
      // Refused, unroutable and unresolvable connects fail the same way right away; a connect
      // that timed out gets one more try, which bounds the wait (SQL_CONNECT_TIMEOUT_MS each).
      if (attempt >= attemptLimitFor(error)) {
        throw final(error, attempt);
      }
      const backoffMillis = RETRY_BACKOFF_MILLIS[Math.min(attempt - 1, RETRY_BACKOFF_MILLIS.length - 1)];
      await delay(backoffMillis);
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error('withConnectionRetry: exhausted retries without a result');
}
