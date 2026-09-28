"use strict";
/**
 * Zod Validation Schemas for MCP Tool Inputs and Outputs
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpResponseSchema = exports.McpTextContentSchema = exports.QueryResultSchema = exports.GetSchemaContextInputSchema = exports.GetSampleDataInputSchema = exports.DescribeTableInputSchema = exports.ListTablesInputSchema = exports.ExportStatusInputSchema = exports.ExportQueryInputSchema = exports.FetchRowsInputSchema = exports.RunQueryInputSchema = exports.EXPORT_ID_PATTERN = exports.RESULT_ID_PATTERN = exports.PAGE_LIMITS = exports.LIMITS = void 0;
const zod_1 = require("zod");
exports.LIMITS = {
    MAX_ROWS: 10000,
    MAX_RESPONSE_LENGTH: 1000000,
    MAX_SQL_LENGTH: 100000,
    MAX_TABLE_NAME_LENGTH: 128,
    MAX_SCHEMA_NAME_LENGTH: 128,
    MAX_PRESET_NAME_LENGTH: 256,
    MAX_SAMPLE_LIMIT: 1000,
    MIN_SAMPLE_LIMIT: 1,
};
const tableNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
const schemaNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const presetNamePattern = /^[a-zA-Z0-9_\-\.]+$/;
exports.PAGE_LIMITS = {
    MAX_PAGE_ROWS: 1000000,
    MIN_PAGE_CHARS: 1000,
};
const sqlSchema = zod_1.z.string()
    .min(1, 'SQL query cannot be empty')
    .max(exports.LIMITS.MAX_SQL_LENGTH, `SQL query exceeds maximum length of ${exports.LIMITS.MAX_SQL_LENGTH}`)
    .refine((sql) => !sql.includes('\x00'), 'SQL query contains null bytes');
const pageFormatSchema = zod_1.z.enum(['table', 'csv', 'json']).optional().default('table');
const maxRowsSchema = zod_1.z.number()
    .int('maxRows must be an integer')
    .min(1, 'maxRows must be at least 1')
    .max(exports.PAGE_LIMITS.MAX_PAGE_ROWS, `maxRows cannot exceed ${exports.PAGE_LIMITS.MAX_PAGE_ROWS}`)
    .optional();
const maxCharsSchema = zod_1.z.number()
    .int('maxChars must be an integer')
    .min(exports.PAGE_LIMITS.MIN_PAGE_CHARS, `maxChars must be at least ${exports.PAGE_LIMITS.MIN_PAGE_CHARS}`)
    .optional();
const timeoutMsSchema = zod_1.z.number()
    .int('timeoutMs must be an integer')
    .min(0, 'timeoutMs cannot be negative')
    .optional();
exports.RESULT_ID_PATTERN = /^r_[a-z2-7]{16}$/;
exports.EXPORT_ID_PATTERN = /^e_[a-z2-7]{16}$/;
exports.RunQueryInputSchema = zod_1.z.object({
    sql: sqlSchema,
    format: pageFormatSchema,
    maxRows: maxRowsSchema,
    maxChars: maxCharsSchema,
    timeoutMs: timeoutMsSchema,
});
exports.FetchRowsInputSchema = zod_1.z.object({
    resultId: zod_1.z.string().regex(exports.RESULT_ID_PATTERN, 'Invalid resultId: use the resultId returned by run_query'),
    format: pageFormatSchema,
    maxRows: maxRowsSchema,
    maxChars: maxCharsSchema,
    offset: zod_1.z.number().int('offset must be an integer').min(0, 'offset cannot be negative').optional(),
});
exports.ExportQueryInputSchema = zod_1.z.object({
    sql: sqlSchema,
    format: zod_1.z.enum(['csv', 'jsonl']).optional().default('csv'),
    fileName: zod_1.z.string().max(256, 'fileName is too long').optional(),
    wait: zod_1.z.boolean().optional().default(true),
    maxRows: zod_1.z.number().int('maxRows must be an integer').min(1, 'maxRows must be at least 1').optional(),
    maxBytes: zod_1.z.number().int('maxBytes must be an integer').min(1, 'maxBytes must be at least 1').optional(),
    timeoutMs: timeoutMsSchema,
});
exports.ExportStatusInputSchema = zod_1.z.object({
    exportId: zod_1.z.string().regex(exports.EXPORT_ID_PATTERN, 'Invalid exportId: use the exportId returned by export_query'),
    cancel: zod_1.z.boolean().optional().default(false),
});
exports.ListTablesInputSchema = zod_1.z.object({
    schema: zod_1.z.string()
        .max(exports.LIMITS.MAX_SCHEMA_NAME_LENGTH)
        .regex(schemaNamePattern, 'Invalid schema name format')
        .optional()
        .default('public'),
});
exports.DescribeTableInputSchema = zod_1.z.object({
    table: zod_1.z.string()
        .min(1, 'Table name cannot be empty')
        .max(exports.LIMITS.MAX_TABLE_NAME_LENGTH, `Table name exceeds maximum length of ${exports.LIMITS.MAX_TABLE_NAME_LENGTH}`)
        .regex(tableNamePattern, 'Invalid table name format. Use alphanumeric characters and underscores only.'),
});
exports.GetSampleDataInputSchema = zod_1.z.object({
    table: zod_1.z.string()
        .min(1, 'Table name cannot be empty')
        .max(exports.LIMITS.MAX_TABLE_NAME_LENGTH)
        .regex(tableNamePattern, 'Invalid table name format'),
    limit: zod_1.z.number()
        .int('Limit must be an integer')
        .min(exports.LIMITS.MIN_SAMPLE_LIMIT, `Limit must be at least ${exports.LIMITS.MIN_SAMPLE_LIMIT}`)
        .max(exports.LIMITS.MAX_SAMPLE_LIMIT, `Limit cannot exceed ${exports.LIMITS.MAX_SAMPLE_LIMIT}`)
        .optional()
        .default(5),
});
exports.GetSchemaContextInputSchema = zod_1.z.object({
    preset: zod_1.z.string()
        .min(1, 'Preset name cannot be empty')
        .max(exports.LIMITS.MAX_PRESET_NAME_LENGTH)
        .regex(presetNamePattern, 'Invalid preset name format'),
});
const CellValueSchema = zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean(), zod_1.z.null(), zod_1.z.date()]);
exports.QueryResultSchema = zod_1.z.object({
    columns: zod_1.z.array(zod_1.z.string().max(256)).max(1000),
    rows: zod_1.z.array(zod_1.z.array(CellValueSchema)).max(exports.LIMITS.MAX_ROWS),
    rowCount: zod_1.z.number().int().min(0, 'Row count cannot be negative'),
    executionTime: zod_1.z.number().min(0, 'Execution time cannot be negative'),
});
exports.McpTextContentSchema = zod_1.z.object({
    type: zod_1.z.literal('text'),
    text: zod_1.z.string().max(exports.LIMITS.MAX_RESPONSE_LENGTH),
});
exports.McpResponseSchema = zod_1.z.object({
    content: zod_1.z.array(exports.McpTextContentSchema).min(1).max(10),
    isError: zod_1.z.boolean().optional(),
});
