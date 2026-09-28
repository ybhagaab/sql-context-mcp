export interface BufferedResult {
    columns: string[];
    rows: unknown[][];
    /** Rows returned, or rows affected for statements without rows. */
    rowCount: number;
    executionTime: number;
    fields: Array<{
        name: string;
        dataTypeID: number;
    }>;
    command: string;
}
export declare function executeQuery(sql: string, params?: unknown[]): Promise<BufferedResult>;
//# sourceMappingURL=buffered.d.ts.map