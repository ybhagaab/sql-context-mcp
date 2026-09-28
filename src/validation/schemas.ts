/**
 * Zod Validation Schemas for MCP Tool Inputs and Outputs
 */

import { z } from 'zod';

export const LIMITS = {
  MAX_ROWS: 10000,
  MAX_RESPONSE_LENGTH: 1_000_000,
  MAX_SQL_LENGTH: 100_000,
  MAX_TABLE_NAME_LENGTH: 128,
  MAX_SCHEMA_NAME_LENGTH: 128,
  MAX_PRESET_NAME_LENGTH: 256,
  MAX_SAMPLE_LIMIT: 1000,
  MIN_SAMPLE_LIMIT: 1,
} as const;

const tableNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
const schemaNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const presetNamePattern = /^[a-zA-Z0-9_\-\.]+$/;

export const PAGE_LIMITS = {
  MAX_PAGE_ROWS: 1_000_000,
  MIN_PAGE_CHARS: 1_000,
} as const;

const sqlSchema = z.string()
  .min(1, 'SQL query cannot be empty')
  .max(LIMITS.MAX_SQL_LENGTH, `SQL query exceeds maximum length of ${LIMITS.MAX_SQL_LENGTH}`)
  .refine((sql) => !sql.includes('\x00'), 'SQL query contains null bytes');

const pageFormatSchema = z.enum(['table', 'csv', 'json']).optional().default('table');
const maxRowsSchema = z.number()
  .int('maxRows must be an integer')
  .min(1, 'maxRows must be at least 1')
  .max(PAGE_LIMITS.MAX_PAGE_ROWS, `maxRows cannot exceed ${PAGE_LIMITS.MAX_PAGE_ROWS}`)
  .optional();
const maxCharsSchema = z.number()
  .int('maxChars must be an integer')
  .min(PAGE_LIMITS.MIN_PAGE_CHARS, `maxChars must be at least ${PAGE_LIMITS.MIN_PAGE_CHARS}`)
  .optional();
const timeoutMsSchema = z.number()
  .int('timeoutMs must be an integer')
  .min(0, 'timeoutMs cannot be negative')
  .optional();

export const RESULT_ID_PATTERN = /^r_[a-z2-7]{16}$/;
export const EXPORT_ID_PATTERN = /^e_[a-z2-7]{16}$/;

export const RunQueryInputSchema = z.object({
  sql: sqlSchema,
  format: pageFormatSchema,
  maxRows: maxRowsSchema,
  maxChars: maxCharsSchema,
  timeoutMs: timeoutMsSchema,
});

export const FetchRowsInputSchema = z.object({
  resultId: z.string().regex(RESULT_ID_PATTERN, 'Invalid resultId: use the resultId returned by run_query'),
  format: pageFormatSchema,
  maxRows: maxRowsSchema,
  maxChars: maxCharsSchema,
  offset: z.number().int('offset must be an integer').min(0, 'offset cannot be negative').optional(),
});

export const ExportQueryInputSchema = z.object({
  sql: sqlSchema,
  format: z.enum(['csv', 'jsonl']).optional().default('csv'),
  fileName: z.string().max(256, 'fileName is too long').optional(),
  wait: z.boolean().optional().default(true),
  maxRows: z.number().int('maxRows must be an integer').min(1, 'maxRows must be at least 1').optional(),
  maxBytes: z.number().int('maxBytes must be an integer').min(1, 'maxBytes must be at least 1').optional(),
  timeoutMs: timeoutMsSchema,
});

export const ExportStatusInputSchema = z.object({
  exportId: z.string().regex(EXPORT_ID_PATTERN, 'Invalid exportId: use the exportId returned by export_query'),
  cancel: z.boolean().optional().default(false),
});

export const ListTablesInputSchema = z.object({
  schema: z.string()
    .max(LIMITS.MAX_SCHEMA_NAME_LENGTH)
    .regex(schemaNamePattern, 'Invalid schema name format')
    .optional()
    .default('public'),
});

export const DescribeTableInputSchema = z.object({
  table: z.string()
    .min(1, 'Table name cannot be empty')
    .max(LIMITS.MAX_TABLE_NAME_LENGTH, `Table name exceeds maximum length of ${LIMITS.MAX_TABLE_NAME_LENGTH}`)
    .regex(tableNamePattern, 'Invalid table name format. Use alphanumeric characters and underscores only.'),
});

export const GetSampleDataInputSchema = z.object({
  table: z.string()
    .min(1, 'Table name cannot be empty')
    .max(LIMITS.MAX_TABLE_NAME_LENGTH)
    .regex(tableNamePattern, 'Invalid table name format'),
  limit: z.number()
    .int('Limit must be an integer')
    .min(LIMITS.MIN_SAMPLE_LIMIT, `Limit must be at least ${LIMITS.MIN_SAMPLE_LIMIT}`)
    .max(LIMITS.MAX_SAMPLE_LIMIT, `Limit cannot exceed ${LIMITS.MAX_SAMPLE_LIMIT}`)
    .optional()
    .default(5),
});

export const GetSchemaContextInputSchema = z.object({
  preset: z.string()
    .min(1, 'Preset name cannot be empty')
    .max(LIMITS.MAX_PRESET_NAME_LENGTH)
    .regex(presetNamePattern, 'Invalid preset name format'),
});

const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.date()]);

export const QueryResultSchema = z.object({
  columns: z.array(z.string().max(256)).max(1000),
  rows: z.array(z.array(CellValueSchema)).max(LIMITS.MAX_ROWS),
  rowCount: z.number().int().min(0, 'Row count cannot be negative'),
  executionTime: z.number().min(0, 'Execution time cannot be negative'),
});

export const McpTextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(LIMITS.MAX_RESPONSE_LENGTH),
});

export const McpResponseSchema = z.object({
  content: z.array(McpTextContentSchema).min(1).max(10),
  isError: z.boolean().optional(),
});

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
