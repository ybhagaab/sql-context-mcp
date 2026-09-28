"use strict";
/**
 * MCP progress notifications (design Component 11).
 *
 * Sent only when the client supplied a progressToken. A timer sends one notification per interval
 * with a strictly increasing `progress` (elapsed seconds, or rows written) and a message naming the
 * current phase, so clients that reset their request timeout on progress keep long calls alive.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProgressReporter = void 0;
exports.formatElapsed = formatElapsed;
exports.formatBytes = formatBytes;
function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    if (total < 60)
        return `${total}s`;
    if (total < 3600)
        return `${Math.floor(total / 60)}m ${total % 60}s`;
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.floor(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${Math.floor(bytes / (1024 * 1024))} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
class ProgressReporter {
    constructor(send, token, intervalMs) {
        this.send = send;
        this.token = token;
        this.intervalMs = intervalMs;
        this.timer = null;
        this.counter = 0;
        this.message = '';
        this.phaseStartedAt = Date.now();
        this.rows = null;
        this.bytes = null;
        this.provider = null;
    }
    static fromExtra(extra, intervalMs) {
        const token = extra?._meta?.progressToken;
        if (token === undefined || token === null || !extra)
            return null;
        return new ProgressReporter((params) => extra.sendNotification({ method: 'notifications/progress', params }), token, intervalMs);
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
    }
    /** Sets the current phase; the elapsed time shown restarts when the phase changes. */
    phase(message) {
        if (message !== this.message)
            this.phaseStartedAt = Date.now();
        this.message = message;
        this.rows = null;
        this.bytes = null;
    }
    /** Reports a row count for the current phase instead of elapsed time. */
    setRows(rows) {
        this.rows = rows;
    }
    /** Reports a byte count for the current phase (shown after the row count). */
    setBytes(bytes) {
        this.bytes = bytes;
    }
    /** Reads the phase, rows and bytes from `provider` before each notification. */
    setProvider(provider) {
        this.provider = provider;
    }
    tick() {
        if (this.provider) {
            try {
                const snapshot = this.provider();
                this.phase(snapshot.message);
                if (typeof snapshot.rows === 'number')
                    this.rows = snapshot.rows;
                if (typeof snapshot.bytes === 'number')
                    this.bytes = snapshot.bytes;
            }
            catch {
                // A failing provider must never break the request.
            }
        }
        const parts = [];
        if (this.rows !== null)
            parts.push(`${this.rows.toLocaleString('en-US')} rows`);
        if (this.bytes !== null)
            parts.push(formatBytes(this.bytes));
        const detail = parts.length ? parts.join(', ') : formatElapsed(Date.now() - this.phaseStartedAt);
        const candidate = this.rows ?? 0;
        this.counter = Math.max(this.counter + 1, candidate);
        const params = { progressToken: this.token, progress: this.counter, message: `${this.message} (${detail})` };
        this.send(params).catch(() => undefined);
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
}
exports.ProgressReporter = ProgressReporter;
