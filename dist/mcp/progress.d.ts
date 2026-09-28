/**
 * MCP progress notifications (design Component 11).
 *
 * Sent only when the client supplied a progressToken. A timer sends one notification per interval
 * with a strictly increasing `progress` (elapsed seconds, or rows written) and a message naming the
 * current phase, so clients that reset their request timeout on progress keep long calls alive.
 */
interface ExtraLike {
    _meta?: {
        progressToken?: string | number;
    };
    sendNotification: (notification: {
        method: 'notifications/progress';
        params: Record<string, unknown>;
    }) => Promise<void>;
}
export declare function formatElapsed(ms: number): string;
export declare function formatBytes(bytes: number): string;
/** Current state of long work, read before each notification. */
export interface ProgressSnapshot {
    message: string;
    rows?: number | null;
    bytes?: number | null;
}
export declare class ProgressReporter {
    private readonly send;
    private readonly token;
    private readonly intervalMs;
    private timer;
    private counter;
    private message;
    private phaseStartedAt;
    private rows;
    private bytes;
    private provider;
    constructor(send: (params: Record<string, unknown>) => Promise<void>, token: string | number, intervalMs: number);
    static fromExtra(extra: ExtraLike | undefined, intervalMs: number): ProgressReporter | null;
    start(): void;
    /** Sets the current phase; the elapsed time shown restarts when the phase changes. */
    phase(message: string): void;
    /** Reports a row count for the current phase instead of elapsed time. */
    setRows(rows: number): void;
    /** Reports a byte count for the current phase (shown after the row count). */
    setBytes(bytes: number): void;
    /** Reads the phase, rows and bytes from `provider` before each notification. */
    setProvider(provider: (() => ProgressSnapshot) | null): void;
    private tick;
    stop(): void;
}
export {};
//# sourceMappingURL=progress.d.ts.map