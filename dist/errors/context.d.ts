/**
 * Facts about where and how an error happened, attached to the error object without changing it.
 *
 * Errors pass through several layers (the driver, the pool, the retry loop, the runner). Each
 * layer adds what it knows, and the error description reads it all at the end. A WeakMap keeps
 * the thrown objects themselves unchanged, so callers that compare or re-throw them see the
 * original error.
 */
export type ErrorPhase = 
/** Reading the connection settings. */
'config'
/** Getting database credentials from AWS (IAM or Secrets Manager). */
 | 'credentials'
/** Opening a database connection: network, TLS and login. No SQL was sent. */
 | 'connect'
/** Running SQL on an open connection. */
 | 'query';
export interface ConnectTarget {
    host: string;
    port: number | null;
}
/** A statement that was sent to the database, located in the caller's SQL. */
export interface StatementRef {
    text: string;
    /** Where `text` starts in the caller's SQL. */
    offset: number;
    /** Characters sent before `text` (for example the DECLARE ... CURSOR FOR prefix). */
    shift: number;
    /** 1-based position in the script, or null when the whole text was sent as one request. */
    index: number | null;
}
export interface ErrorContext {
    phase?: ErrorPhase;
    target?: ConnectTarget;
    authMethod?: string;
    /** The AWS call that failed, for credential errors. */
    aws?: {
        service: 'redshift' | 'secretsmanager';
        region: string;
        resource?: string;
    };
    /** The connect timeout in force (SQL_CONNECT_TIMEOUT_MS). */
    connectTimeoutMs?: number;
    /** Connection attempts made by the retry loop, and the time they took. */
    attempts?: number;
    elapsedMs?: number;
    /** The tool operation, for wording ('run_query', 'export_query', 'fetch_rows', ...). */
    operation?: string;
    /** The caller's SQL. */
    sql?: string;
    /** Attempts on which the caller's SQL was sent to the database. */
    sentCount?: number;
    /** Script statements that had completed, as summaries like "INSERT (5 rows)". */
    completed?: string[];
    /** The statement that was running when the error happened. */
    statement?: StatementRef;
    isScript?: boolean;
    statementCount?: number;
    /** A fetch_rows result that this error closed. */
    resultClosed?: boolean;
}
/** Adds facts that aren't known yet; facts recorded closer to the failure win. Returns `err`. */
export declare function annotate<T>(err: T, facts: ErrorContext): T;
/** Records facts, replacing earlier values (for counts that the outer layers know best). Returns `err`. */
export declare function setContext<T>(err: T, facts: ErrorContext): T;
export declare function contextOf(err: unknown): ErrorContext;
//# sourceMappingURL=context.d.ts.map