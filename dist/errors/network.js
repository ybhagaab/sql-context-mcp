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
exports.__setNetworkForTests = __setNetworkForTests;
exports.lookupHost = lookupHost;
exports.probeTcp = probeTcp;
exports.isLoopbackAddress = isLoopbackAddress;
exports.isPrivateAddress = isPrivateAddress;
exports.isLoopbackHost = isLoopbackHost;
/**
 * Network checks used to explain connection failures: a DNS lookup and a plain TCP connection
 * to the database port, each with a short time limit. Neither sends anything to the database.
 */
const dns = __importStar(require("dns"));
const net = __importStar(require("net"));
const REFUSED = new Set(['ECONNREFUSED']);
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EHOSTDOWN']);
const DNS_FAILURES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
function outcomeOfCode(code) {
    if (!code)
        return 'error';
    if (REFUSED.has(code))
        return 'refused';
    if (UNREACHABLE.has(code))
        return 'unreachable';
    if (code === 'ETIMEDOUT')
        return 'timeout';
    if (DNS_FAILURES.has(code))
        return 'dns';
    return 'error';
}
const defaultImpl = {
    async lookup(host) {
        const found = await dns.promises.lookup(host, { all: true });
        return found.map((a) => ({ address: a.address, family: a.family }));
    },
    probe(address, port, timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const socket = net.connect({ host: address, port });
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                resolve({ ...result, address, port, timeoutMs });
            };
            const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
            timer.unref?.();
            socket.once('connect', () => finish({ outcome: 'open' }));
            // A persistent listener: a socket may report more than one error, and an unhandled one would crash the process.
            socket.on('error', (err) => {
                finish({ outcome: outcomeOfCode(err.code), code: err.code, message: err.message });
            });
        });
    },
};
let impl = defaultImpl;
/** Test seam: replaces the lookup and/or the probe (null restores the real ones). */
function __setNetworkForTests(stub) {
    impl = stub ? { ...defaultImpl, ...stub } : defaultImpl;
}
function withTimeout(promise, ms, onTimeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(onTimeout()), ms);
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
/** Resolves `host` the way the driver does (getaddrinfo), within `timeoutMs`. Never throws. */
async function lookupHost(host, timeoutMs = 2000) {
    const started = Date.now();
    const family = net.isIP(host);
    if (family)
        return { ok: true, addresses: [{ address: host, family }], ms: 0 };
    try {
        const addresses = await withTimeout(impl.lookup(host), timeoutMs, () => Object.assign(new Error(`the DNS lookup did not finish within ${timeoutMs} ms`), { code: 'ETIMEOUT' }));
        if (addresses.length === 0)
            return { ok: false, addresses, code: 'ENOTFOUND', message: 'no addresses', ms: Date.now() - started };
        return { ok: true, addresses, ms: Date.now() - started };
    }
    catch (err) {
        const e = err;
        return { ok: false, addresses: [], code: e?.code, message: e?.message, ms: Date.now() - started };
    }
}
/** Opens (and immediately closes) a TCP connection to `address:port`, within `timeoutMs`. Never throws. */
async function probeTcp(address, port, timeoutMs = 3000) {
    const started = Date.now();
    try {
        const result = await impl.probe(address, port, timeoutMs);
        return { ...result, ms: result.ms ?? Date.now() - started };
    }
    catch (err) {
        const e = err;
        return { outcome: outcomeOfCode(e?.code), address, port, timeoutMs, code: e?.code, message: e?.message, ms: Date.now() - started };
    }
}
function ipv4Of(ip) {
    if (net.isIPv4(ip))
        return ip;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    return mapped ? mapped[1] : null;
}
function isLoopbackAddress(ip) {
    const v4 = ipv4Of(ip);
    if (v4)
        return v4.startsWith('127.');
    return ip === '::1';
}
/**
 * True for addresses that are only reachable from inside a private network: RFC 1918, shared
 * address space (100.64/10, used by carrier NAT and some VPNs), link-local, loopback, and IPv6
 * unique-local and link-local addresses.
 */
function isPrivateAddress(ip) {
    const v4 = ipv4Of(ip);
    if (v4) {
        const [a, b] = v4.split('.').map(Number);
        return (a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            a === 127);
    }
    if (!net.isIPv6(ip))
        return false;
    const lower = ip.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
}
function isLoopbackHost(host) {
    const lower = host.toLowerCase();
    return lower === 'localhost' || lower.endsWith('.localhost') || isLoopbackAddress(lower);
}
