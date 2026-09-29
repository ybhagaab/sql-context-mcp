/**
 * Server configuration from environment variables (design Component 1).
 *
 * Every setting has a default, so no configuration is needed to upgrade. Invalid values fall back
 * to the default with a one-time warning on stderr. A guardrail keeps open cursors plus exports
 * from taking every pooled connection.
 */
export interface ServerConfig {
    poolMax: number;
    /** How long one connection attempt (network, TLS and login) may take; 0 waits for the OS. */
    connectTimeoutMs: number;
    defaultMaxRows: number;
    maxInlineChars: number;
    maxInlineCharsCeiling: number;
    fetchBatchRows: number;
    statementTimeoutMs: number;
    progressIntervalMs: number;
    spoolThresholdBytes: number;
    spoolMaxTotalBytes: number;
    maxOpenCursors: number;
    cursorIdleTtlMs: number;
    exportConcurrency: number;
    exportDir: string | null;
    exportMaxRows: number | null;
    exportMaxBytes: number | null;
    exportMinFreeBytes: number;
}
export declare const DEFAULTS: ServerConfig;
type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;
/**
 * Parses configuration from `env`. Pure apart from `warn`; `getConfig()` reads process.env.
 */
export declare function loadConfig(env?: Env, warn?: Warn): ServerConfig;
/** Current configuration from process.env (cheap to call; warnings are shown once). */
export declare function getConfig(): ServerConfig;
export {};
//# sourceMappingURL=config.d.ts.map