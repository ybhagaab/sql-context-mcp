/**
 * SQL statement splitter (design Component 3).
 *
 * A single pass that splits on `;` only in normal text. It understands single-quoted strings
 * (with `''` and backslash escapes, matching Redshift), double-quoted identifiers (with `""`),
 * line comments, nested block comments, and dollar-quoted bodies (`$tag$ … $tag$`). Empty and
 * comment-only statements are dropped. `complete: false` means the text ended inside a quote or
 * comment; callers then run the whole text as written and let the database report any error.
 *
 * The splitter only routes execution. It never authorizes SQL.
 */
export interface SplitResult {
    statements: string[];
    /** Where each statement starts in the original text (UTF-16 index), for error positions. */
    offsets: number[];
    complete: boolean;
}
/** Returns `stmt` with leading whitespace and comments removed. */
export declare function stripLeadingNoise(stmt: string): string;
export declare function splitStatements(sql: string): SplitResult;
//# sourceMappingURL=split.d.ts.map