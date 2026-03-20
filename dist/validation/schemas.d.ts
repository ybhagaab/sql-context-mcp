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
export declare const RunQueryInputSchema: z.ZodObject<{
    sql: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    sql: string;
}, {
    sql: string;
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
    columns: string[];
    rows: (string | number | boolean | Date | null)[][];
    rowCount: number;
    executionTime: number;
}, {
    columns: string[];
    rows: (string | number | boolean | Date | null)[][];
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
export type ListTablesInput = z.infer<typeof ListTablesInputSchema>;
export type DescribeTableInput = z.infer<typeof DescribeTableInputSchema>;
export type GetSampleDataInput = z.infer<typeof GetSampleDataInputSchema>;
export type GetSchemaContextInput = z.infer<typeof GetSchemaContextInputSchema>;
export type QueryResult = z.infer<typeof QueryResultSchema>;
export type McpResponse = z.infer<typeof McpResponseSchema>;
//# sourceMappingURL=schemas.d.ts.map