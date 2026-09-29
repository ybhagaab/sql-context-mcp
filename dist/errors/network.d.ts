export interface ResolvedAddress {
    address: string;
    family: number;
}
export interface LookupResult {
    ok: boolean;
    addresses: ResolvedAddress[];
    code?: string;
    message?: string;
    ms: number;
}
export type ProbeOutcome = 'open' | 'timeout' | 'refused' | 'unreachable' | 'dns' | 'error';
export interface ProbeResult {
    outcome: ProbeOutcome;
    /** The address that was tried. */
    address: string;
    port: number;
    timeoutMs: number;
    code?: string;
    message?: string;
    ms: number;
}
interface NetworkImpl {
    lookup(host: string): Promise<ResolvedAddress[]>;
    probe(address: string, port: number, timeoutMs: number): Promise<Omit<ProbeResult, 'ms'> & {
        ms?: number;
    }>;
}
/** Test seam: replaces the lookup and/or the probe (null restores the real ones). */
export declare function __setNetworkForTests(stub: Partial<NetworkImpl> | null): void;
/** Resolves `host` the way the driver does (getaddrinfo), within `timeoutMs`. Never throws. */
export declare function lookupHost(host: string, timeoutMs?: number): Promise<LookupResult>;
/** Opens (and immediately closes) a TCP connection to `address:port`, within `timeoutMs`. Never throws. */
export declare function probeTcp(address: string, port: number, timeoutMs?: number): Promise<ProbeResult>;
export declare function isLoopbackAddress(ip: string): boolean;
/**
 * True for addresses that are only reachable from inside a private network: RFC 1918, shared
 * address space (100.64/10, used by carrier NAT and some VPNs), link-local, loopback, and IPv6
 * unique-local and link-local addresses.
 */
export declare function isPrivateAddress(ip: string): boolean;
export declare function isLoopbackHost(host: string): boolean;
export {};
//# sourceMappingURL=network.d.ts.map