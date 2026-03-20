"use strict";
/**
 * Zod Validation Schemas for MCP Tool Inputs and Outputs
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpResponseSchema = exports.McpTextContentSchema = exports.QueryResultSchema = exports.GetSchemaContextInputSchema = exports.GetSampleDataInputSchema = exports.DescribeTableInputSchema = exports.ListTablesInputSchema = exports.RunQueryInputSchema = exports.LIMITS = void 0;
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
exports.RunQueryInputSchema = zod_1.z.object({
    sql: zod_1.z.string()
        .min(1, 'SQL query cannot be empty')
        .max(exports.LIMITS.MAX_SQL_LENGTH, `SQL query exceeds maximum length of ${exports.LIMITS.MAX_SQL_LENGTH}`)
        .refine((sql) => !sql.includes('\x00'), 'SQL query contains null bytes'),
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
