export declare const INFO_SQL = "SELECT current_database() as database, current_user as user, inet_server_addr() as host, version() as version";
/** Time limits for the checks (a test seam). */
export declare const statusLimits: {
    queryLimitMs: number;
    probeTimeoutMs: number;
};
/** The connection_status text (never throws). */
export declare function connectionStatus(): Promise<string>;
//# sourceMappingURL=diagnostics.d.ts.map