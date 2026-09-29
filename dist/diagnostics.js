"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statusLimits = exports.INFO_SQL = void 0;
exports.connectionStatus = connectionStatus;
/**
 * connection_status: checks the connection step by step and reports the first step that fails,
 * with the likely cause and the fix.
 *
 * 1. Settings: the connection settings resolve, including IAM or Secrets Manager credentials.
 * 2. An existing connection pool answers a small query (the usual, fast path).
 * 3. DNS: the host name resolves (private addresses need a VPN, peered network or tunnel).
 * 4. Network: a TCP connection to the database port opens.
 * 5. Login: a new connection logs in and answers the query.
 *
 * The first lines of a success stay `Connected`, `Database:`, `User:` and `Host:`, as before.
 */
const pg_1 = require("pg");
const pool_1 = require("./db/pool");
const describe_1 = require("./errors/describe");
const network_1 = require("./errors/network");
const context_1 = require("./errors/context");
exports.INFO_SQL = 'SELECT current_database() as database, current_user as user, inet_server_addr() as host, version() as version';
/** Time limits for the checks (a test seam). */
exports.statusLimits = { queryLimitMs: 5000, probeTimeoutMs: 5000 };
class CheckTimeout extends Error {
    constructor(ms) {
        super(`no answer within ${(0, describe_1.formatSeconds)(ms)}`);
        this.ms = ms;
        this.name = 'CheckTimeout';
    }
}
function within(promise, ms) {
    promise.catch(() => undefined);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new CheckTimeout(ms)), ms);
        timer.unref?.();
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
async function queryInfo(pool) {
    const started = Date.now();
    const result = await pool.query(exports.INFO_SQL);
    return { row: (result.rows?.[0] ?? {}), ms: Date.now() - started };
}
/** Logs in on a new connection outside the pool (used when the pool is busy or not answering). */
async function sideClientInfo(config) {
    const timeout = (0, pool_1.connectTimeoutMs)() || 10000;
    const client = new pg_1.Client({ ...config, connectionTimeoutMillis: timeout });
    client.on?.('error', () => undefined);
    try {
        try {
            await client.connect();
        }
        catch (err) {
            throw (0, context_1.annotate)(err, { phase: 'connect', target: { host: config.host, port: config.port }, connectTimeoutMs: timeout });
        }
        const started = Date.now();
        const result = await within(client.query(exports.INFO_SQL), exports.statusLimits.queryLimitMs);
        return { row: (result.rows?.[0] ?? {}), ms: Date.now() - started };
    }
    finally {
        await client.end().catch(() => undefined);
    }
}
function poolLine(pool) {
    const p = pool;
    const total = p.totalCount ?? 0;
    const idle = p.idleCount ?? 0;
    return `${Math.max(0, total - idle)} in use, ${idle} idle, ${p.waitingCount ?? 0} waiting (max ${p.options?.max ?? (0, pool_1.getPoolMax)()})`;
}
function connected(info, pool, config, note) {
    const row = info.row;
    const lines = [
        'Connected',
        `Database: ${row.database}`,
        `User: ${row.user}`,
        `Host: ${row.host || config.host}`,
    ];
    if (row.version) {
        const version = String(row.version);
        lines.push(`Server: ${version.length > 300 ? `${version.slice(0, 299)}…` : version}`);
    }
    lines.push(`Round trip: ${info.ms} ms`, `Pool: ${poolLine(pool)}`);
    if (note)
        lines.push(note);
    return lines.join('\n');
}
function region() {
    return process.env.SQL_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
}
function settingsSummary(config) {
    const auth = (process.env.SQL_AUTH_METHOD || 'direct').toLowerCase();
    const where = `database ${config.database} at ${config.host}:${config.port}, SSL mode ${process.env.SQL_SSL_MODE || 'require'}`;
    if (auth === 'iam')
        return `IAM credentials for cluster ${process.env.SQL_CLUSTER_ID} in ${region()}, user ${config.user}, ${where}`;
    if (auth === 'secrets_manager')
        return `secret ${process.env.SQL_SECRET_ID} in ${region()}, user ${config.user}, ${where}`;
    return `password login, user ${config.user}, ${where}`;
}
function addressesText(addresses) {
    const shown = addresses.slice(0, 4).join(', ') + (addresses.length > 4 ? `, and ${addresses.length - 4} more` : '');
    return `${shown}, ${(0, describe_1.addressKind)(addresses)}`;
}
function probeText(probe) {
    const where = `${probe.address}:${probe.port}`;
    switch (probe.outcome) {
        case 'open':
            return `TCP connection to ${where} in ${(0, describe_1.formatSeconds)(probe.ms)}`;
        case 'timeout':
            return `no answer from ${where} within ${(0, describe_1.formatSeconds)(probe.timeoutMs)}`;
        case 'refused':
            return `${where} refused the connection`;
        case 'unreachable':
            return `no route to ${where} (${probe.code ?? 'unreachable'})`;
        default:
            return `${where}: ${probe.code ?? probe.message ?? 'error'}`;
    }
}
/** An error standing for a failed network check, so it is described like the same failure in a query. */
function networkError(probe, config) {
    const code = probe.outcome === 'refused' ? 'ECONNREFUSED' : probe.outcome === 'timeout' ? 'ETIMEDOUT' : probe.code ?? 'EHOSTUNREACH';
    const message = probe.message ?? `connect ${code} ${probe.address}:${probe.port}`;
    return (0, context_1.annotate)(Object.assign(new Error(message), { code, syscall: 'connect' }), {
        phase: 'connect',
        target: { host: config.host, port: config.port },
    });
}
function dnsError(code, message, config) {
    const c = code ?? 'ENOTFOUND';
    return (0, context_1.annotate)(Object.assign(new Error(message ?? `getaddrinfo ${c} ${config.host}`), { code: c, syscall: 'getaddrinfo' }), {
        phase: 'connect',
        target: { host: config.host, port: config.port },
    });
}
async function notConnected(err, checks, failed, network, skipped) {
    const d = await (0, describe_1.diagnose)(err, { network, checks: false }).catch(() => null);
    const block = [
        'Checks:',
        ...checks.map((c) => `  ${c}`),
        `  ${failed.step}: failed${failed.detail ? ` (${failed.detail})` : ''}`,
        ...skipped.map((s) => `  ${s}: not checked`),
    ];
    if (!d)
        return [`Not connected: ${(0, describe_1.errorText)(err)}`, ...block].join('\n');
    // The Checks block replaces the diagnosis's own "Checked:" line; DNS and network failures come
    // from this check itself, so there is no driver message to show.
    const own = failed.step === 'DNS' || failed.step === 'Network';
    const lines = d.lines.filter((l) => !l.startsWith('Checked: ') && !(own && l.startsWith('Driver message: ')));
    return (0, describe_1.renderDiagnosis)({ ...d, lines }, { prefix: 'Not connected', before: block });
}
/** The connection_status text (never throws). */
async function connectionStatus() {
    try {
        return await check();
    }
    catch (err) {
        return `Not connected: ${(0, describe_1.errorText)(err)}`;
    }
}
async function check() {
    const checks = [];
    let config;
    try {
        config = await (0, pool_1.resolveConnectionConfig)();
    }
    catch (err) {
        return notConnected(err, checks, { step: 'Settings' }, {}, ['DNS', 'Network', 'Login']);
    }
    checks.push(`Settings: ok (${settingsSummary(config)})`);
    // The usual case: the pool answers right away.
    const existing = (0, pool_1.getActivePool)();
    let poolTrouble = null;
    if (existing) {
        const limit = ((0, pool_1.connectTimeoutMs)() || 10000) + exports.statusLimits.queryLimitMs;
        try {
            return connected(await within(queryInfo(existing), limit), existing, config, null);
        }
        catch (err) {
            if (err instanceof CheckTimeout) {
                poolTrouble = `the existing connection pool did not answer within ${(0, describe_1.formatSeconds)(limit)} (${poolLine(existing)})`;
            }
            else if ((0, pool_1.isConnectionLevelError)(err)) {
                (0, pool_1.discardPool)(existing);
            }
        }
    }
    const network = {};
    if (config.host.startsWith('/')) {
        checks.push('DNS: not needed (Unix socket)', 'Network: not needed (Unix socket)');
    }
    else {
        const lookup = await (0, network_1.lookupHost)(config.host, 2000);
        network.lookup = lookup;
        if (!lookup.ok) {
            const detail = `${config.host}: ${lookup.code ?? lookup.message ?? 'no answer'}`;
            return notConnected(dnsError(lookup.code, lookup.message, config), checks, { step: 'DNS', detail }, network, ['Network', 'Login']);
        }
        const addresses = lookup.addresses.map((a) => a.address);
        checks.push(addresses.length === 1 && addresses[0] === config.host
            ? 'DNS: not needed (SQL_HOST is an IP address)'
            : `DNS: ok (resolves to ${addressesText(addresses)})`);
        const probe = await (0, network_1.probeTcp)(addresses[0], config.port, exports.statusLimits.probeTimeoutMs);
        network.probe = probe;
        if (probe.outcome !== 'open') {
            return notConnected(networkError(probe, config), checks, { step: 'Network', detail: probeText(probe) }, network, ['Login']);
        }
        checks.push(`Network: ok (${probeText(probe)})`);
    }
    try {
        const current = (0, pool_1.getActivePool)();
        if (!current) {
            const started = Date.now();
            const created = await (0, pool_1.ensurePool)();
            const loginMs = Date.now() - started;
            const info = await within(queryInfo(created), exports.statusLimits.queryLimitMs);
            return connected(info, created, config, loginMs > 5000 ? `Note: logging in took ${(0, describe_1.formatSeconds)(loginMs)}.` : null);
        }
        const info = await sideClientInfo(config);
        const note = poolTrouble
            ? `Note: a new connection works, but ${poolTrouble}. Long-running queries or open results may be holding every connection.`
            : null;
        return connected(info, current, config, note);
    }
    catch (err) {
        return notConnected(err, checks, { step: 'Login' }, network, []);
    }
}
