/**
 * Zod Validation Schemas for MCP Tool Inputs and Outputs
 */
import { z } from 'zod';
export declare const LIMITS: {
    readonly MAX_ROWS: 10000;
    readonly MAX_RESPONSE_LENGTH: 1000000;
    readonly MAX_SQL_LENGTH: 100000;
    readonly MAX_TABLE_NAME_LENGTH: 128;
    readonly MAX_SCHEMA_NAME_LENGTH: 128;
    readonly MAX_PRESET_NAME_LENGTH: 256;
    readonly MAX_SAMPLE_LIMIT: 1000;
    readonly MIN_SAMPLE_LIMIT: 1;
};
export declare const PAGE_LIMITS: {
    readonly MAX_PAGE_ROWS: 1000000;
    readonly MIN_PAGE_CHARS: 1000;
};
export declare const RESULT_ID_PATTERN: RegExp;
export declare const EXPORT_ID_PATTERN: RegExp;
export declare const RunQueryInputSchema: z.ZodObject<{
    sql: z.ZodEffects<z.ZodString, string, string>;
    format: z.ZodDefault<z.ZodOptional<z.ZodEnum<["table", "csv", "json"]>>>;
    maxRows: z.ZodOptional<z.ZodNumber>;
    maxChars: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    sql: string;
    format: "table" | "csv" | "json";
    timeoutMs?: number | undefined;
    maxRows?: number | undefined;
    maxChars?: number | undefined;
}, {
    sql: string;
    timeoutMs?: number | undefined;
    format?: "table" | "csv" | "json" | undefined;
    maxRows?: number | undefined;
    maxChars?: number | undefined;
}>;
export declare const FetchRowsInputSchema: z.ZodObject<{
    resultId: z.ZodString;
    format: z.ZodDefault<z.ZodOptional<z.ZodEnum<["table", "csv", "json"]>>>;
    maxRows: z.ZodOptional<z.ZodNumber>;
    maxChars: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    format: "table" | "csv" | "json";
    resultId: string;
    maxRows?: number | undefined;
    maxChars?: number | undefined;
    offset?: number | undefined;
}, {
    resultId: string;
    format?: "table" | "csv" | "json" | undefined;
    maxRows?: number | undefined;
    maxChars?: number | undefined;
    offset?: number | undefined;
}>;
export declare const ExportQueryInputSchema: z.ZodObject<{
    sql: z.ZodEffects<z.ZodString, string, string>;
    format: z.ZodDefault<z.ZodOptional<z.ZodEnum<["csv", "jsonl"]>>>;
    fileName: z.ZodOptional<z.ZodString>;
    wait: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    maxRows: z.ZodOptional<z.ZodNumber>;
    maxBytes: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    sql: string;
    format: "csv" | "jsonl";
    wait: boolean;
    timeoutMs?: number | undefined;
    maxRows?: number | undefined;
    fileName?: string | undefined;
    maxBytes?: number | undefined;
}, {
    sql: string;
    timeoutMs?: number | undefined;
    format?: "csv" | "jsonl" | undefined;
    maxRows?: number | undefined;
    fileName?: string | undefined;
    wait?: boolean | undefined;
    maxBytes?: number | undefined;
}>;
export declare const ExportStatusInputSchema: z.ZodObject<{
    exportId: z.ZodString;
    cancel: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    exportId: string;
    cancel: boolean;
}, {
    exportId: string;
    cancel?: boolean | undefined;
}>;
export declare const ListTablesInputSchema: z.ZodObject<{
    schema: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    schema: string;
}, {
    schema?: string | undefined;
}>;
export declare const DescribeTableInputSchema: z.ZodObject<{
    table: z.ZodString;
}, "strip", z.ZodTypeAny, {
    table: string;
}, {
    table: string;
}>;
export declare const GetSampleDataInputSchema: z.ZodObject<{
    table: z.ZodString;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    table: string;
    limit: number;
}, {
    table: string;
    limit?: number | undefined;
}>;
export declare const GetSchemaContextInputSchema: z.ZodObject<{
    preset: z.ZodString;
}, "strip", z.ZodTypeAny, {
    preset: string;
}, {
    preset: string;
}>;
export declare const QueryResultSchema: z.ZodObject<{
    columns: z.ZodArray<z.ZodString, "many">;
    rows: z.ZodArray<z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull, z.ZodDate]>, "many">, "many">;
    rowCount: z.ZodNumber;
    executionTime: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    rows: (string | number | boolean | Date | null)[][];
    columns: string[];
    rowCount: number;
    executionTime: number;
}, {
    rows: (string | number | boolean | Date | null)[][];
    columns: string[];
    rowCount: number;
    executionTime: number;
}>;
export declare const McpTextContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
}, {
    type: "text";
    text: string;
}>;
export declare const McpResponseSchema: z.ZodObject<{
    content: z.ZodArray<z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, "many">;
    isError: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    content: {
        type: "text";
        text: string;
    }[];
    isError?: boolean | undefined;
}, {
    content: {
        type: "text";
        text: string;
    }[];
    isError?: boolean | undefined;
}>;
export type RunQueryInput = z.infer<typeof RunQueryInputSchema>;
export type FetchRowsInput = z.infer<typeof FetchRowsInputSchema>;
export type ExportQueryInput = z.infer<typeof ExportQueryInputSchema>;
export type ExportStatusInput = z.infer<typeof ExportStatusInputSchema>;
export type ListTablesInput = z.infer<typeof ListTablesInputSchema>;
export type DescribeTableInput = z.infer<typeof DescribeTableInputSchema>;
export type GetSampleDataInput = z.infer<typeof GetSampleDataInputSchema>;
export type GetSchemaContextInput = z.infer<typeof GetSchemaContextInputSchema>;
export type QueryResult = z.infer<typeof QueryResultSchema>;
export type McpResponse = z.infer<typeof McpResponseSchema>;
//# sourceMappingURL=schemas.d.ts.map