import { ErrorContext, StatementRef } from './context';
import { LookupResult, ProbeResult } from './network';
export type ErrorType = 'config' | 'aws_credentials' | 'dns' | 'network_timeout' | 'network_unreachable' | 'connection_refused' | 'connect_timeout' | 'tls' | 'auth' | 'database_not_found' | 'too_many_connections' | 'server_unavailable' | 'connection_lost' | 'sql_error' | 'permission_denied' | 'server_timeout';
export interface Diagnosis {
    type: ErrorType;
    summary: string;
    cause?: string;
    fix?: string;
    /** Extra lines: Detail, Hint, Where, the error position, Checked. */
    lines: string[];
    /** "SQLSTATE 42P01 undefined_table" for database errors. */
    sqlstate?: string;
}
export interface NetworkFacts {
    lookup?: LookupResult;
    probe?: ProbeResult;
}
export interface RenderedError {
    /** null for the server's own one-line errors and for errors that can't be classified. */
    type: ErrorType | null;
    text: string;
}
/** Masks credential literals in a line of SQL, keeping its length so a caret still lines up. */
export declare function maskSecrets(line: string): string;
/** "850 ms", "3.2 s", "20 s". */
export declare function formatSeconds(ms: number): string;
/**
 * A one-line description of any thrown value, never blank: the message, else the messages of an
 * AggregateError's errors, else the name, code and cause.
 */
export declare function errorText(err: unknown): string;
/** "loopback", "private", "private and public" or "public". */
export declare function addressKind(addresses: string[]): string;
/**
 * Maps a database error position (1-based, counted in characters of the text that was sent) to a
 * line and column of the caller's SQL, with that line (windowed when long) and a caret offset.
 */
export declare function locate(sql: string, statement: StatementRef, position: number): {
    line: number;
    column: number;
    snippet: string;
    caret: number;
} | null;
export declare function statusSentence(type: ErrorType, ctx: ErrorContext): string | null;
export interface DescribeOptions {
    /** Network facts already gathered (connection_status), so they aren't checked twice. */
    network?: NetworkFacts;
    /** false: don't run DNS or TCP checks. */
    checks?: boolean;
    probeTimeoutMs?: number;
}
/** The server's own errors, whose one-line message is already specific. */
export declare function isClearError(err: unknown): boolean;
/** Diagnoses an error, or returns null when it isn't one the server can explain. */
export declare function diagnose(err: unknown, opts?: DescribeOptions): Promise<Diagnosis | null>;
export declare function renderDiagnosis(d: Diagnosis, opts?: {
    prefix?: string;
    status?: string | null;
    before?: string[];
}): string;
/**
 * The tool error text for any thrown value. Never throws and is never blank. May take a few
 * seconds for connection failures (a DNS lookup and a short TCP check).
 */
export declare function describeError(err: unknown, opts?: DescribeOptions): Promise<RenderedError>;
//# sourceMappingURL=describe.d.ts.map