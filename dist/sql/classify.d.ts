export type StatementKind = 'rows' | 'transaction' | 'session' | 'other';
export interface StatementInfo {
    text: string;
    keyword: string;
    kind: StatementKind;
    /** The statement changes session state, so its connection must not be reused. */
    changesSession: boolean;
    /** Where `text` starts in the script (UTF-16 index), for error positions. */
    offset: number;
}
/**
 * True when the text may change data or schema. Deliberately broad (a keyword inside a string
 * literal also counts): it decides whether re-running the text could apply a change twice.
 */
export declare function mayChangeData(text: string): boolean;
export interface ScriptPlan {
    statements: StatementInfo[];
    /** False when the text ended inside a quote or comment; `statements` then holds the whole text. */
    complete: boolean;
    isScript: boolean;
    hasTransactionControl: boolean;
    changesSession: boolean;
    last: StatementInfo | null;
    prefix: StatementInfo[];
}
export declare function classifyStatement(text: string, offset?: number): StatementInfo;
export declare class EmptySqlError extends Error {
    constructor();
}
export declare function planScript(sql: string): ScriptPlan;
//# sourceMappingURL=classify.d.ts.map