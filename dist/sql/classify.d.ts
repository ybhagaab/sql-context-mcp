export type StatementKind = 'rows' | 'transaction' | 'session' | 'other';
export interface StatementInfo {
    text: string;
    keyword: string;
    kind: StatementKind;
    /** The statement changes session state, so its connection must not be reused. */
    changesSession: boolean;
}
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
export declare function classifyStatement(text: string): StatementInfo;
export declare class EmptySqlError extends Error {
    constructor();
}
export declare function planScript(sql: string): ScriptPlan;
//# sourceMappingURL=classify.d.ts.map