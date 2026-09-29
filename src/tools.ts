/**
 * MCP tool definitions and handlers.
 */
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { listPresetsAsync, getPresetAsync } from './presets/index.js';
import {
  RunQueryInputSchema,
  FetchRowsInputSchema,
  ExportQueryInputSchema,
  ExportStatusInputSchema,
  ListTablesInputSchema,
  DescribeTableInputSchema,
  GetSampleDataInputSchema,
  GetSchemaContextInputSchema,
  LIMITS,
  PAGE_LIMITS,
} from './validation/schemas.js';
import { sanitizeString, sanitizeResponseText, truncateString } from './validation/sanitizer.js';
import { executeQuery } from './db/buffered';
import { describeError } from './errors/describe';
import { connectionStatus } from './diagnostics';
import { runQuery, renderBuffered } from './runner';
import { ProgressReporter } from './mcp/progress';
import type { RenderedPage } from './results/page';
import type { Runtime } from './runtime';
import { ExportJob, exportResult, exportStatus, exportProgress } from './export/manager';
import { SERVER_NAME } from './version';

const FORMAT_DESCRIPTION =
  'Output format: "table" (default; readable text), "csv" (a header and rows, returned as a separate text block from the status line), ' +
  'or "json" (typed exact values with paging metadata; meant for programs).';
const MAX_ROWS_DESCRIPTION =
  `Most rows to return in this page (1 to ${PAGE_LIMITS.MAX_PAGE_ROWS.toLocaleString('en-US')}; default 100). The character budget can end the page earlier.`;
const MAX_CHARS_DESCRIPTION =
  'Character budget for this page (default 100,000; values above the server ceiling, 5,000,000 by default, are reduced to it). ' +
  'Meant for programs that load data; for analysis in chat, aggregate in SQL instead.';
const TIMEOUT_DESCRIPTION =
  'Cancel a statement that runs longer than this many milliseconds; 0 means no timeout. ' +
  'Default: the server setting (no timeout unless SQL_STATEMENT_TIMEOUT_MS is set).';

export const TOOLS: Tool[] = [
  {
    name: 'run_query',
    description:
      'Execute SQL on the connected database (PostgreSQL or Redshift) and return one page of the result, sized for model context ' +
      '(by default up to 100 rows and 100,000 characters), with the exact total row count. When more rows exist, the response includes a ' +
      'resultId: call fetch_rows to read the next page, or use export_query to write the complete result to a file. For analysis, ' +
      'aggregate in SQL (GROUP BY, COUNT, SUM) rather than paging through raw rows. The SQL may contain several statements separated ' +
      'by semicolons; they run in order on one connection, and the last result is shown. Session settings (SET) do not carry over to ' +
      'the next call, so put them in the same call as the query. TIP: If you\'re unfamiliar with the schema, use list_presets and ' +
      'get_schema_context first to learn about tables, columns, and required filters.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL to execute. May contain several statements separated by semicolons.' },
        format: { type: 'string', enum: ['table', 'csv', 'json'], default: 'table', description: FORMAT_DESCRIPTION },
        maxRows: { type: 'integer', minimum: 1, maximum: PAGE_LIMITS.MAX_PAGE_ROWS, description: MAX_ROWS_DESCRIPTION },
        maxChars: { type: 'integer', minimum: PAGE_LIMITS.MIN_PAGE_CHARS, description: MAX_CHARS_DESCRIPTION },
        timeoutMs: { type: 'integer', minimum: 0, description: TIMEOUT_DESCRIPTION },
      },
      required: ['sql'],
    },
  },
  {
    name: 'fetch_rows',
    description:
      'Read the next page of a result returned by run_query (or get_sample_data and the catalog tools), using its resultId. ' +
      'Continues where the previous page ended, or starts at `offset`. The query is not run again. Results are kept until the server ' +
      'restarts, though the least recently used may be evicted when the spool budget is full; very large results keep an open cursor that can ' +
      'only move forward and closes after 15 idle minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        resultId: { type: 'string', pattern: '^r_[a-z2-7]{16}$', description: 'The resultId from a previous response.' },
        format: { type: 'string', enum: ['table', 'csv', 'json'], default: 'table', description: FORMAT_DESCRIPTION },
        maxRows: { type: 'integer', minimum: 1, maximum: PAGE_LIMITS.MAX_PAGE_ROWS, description: MAX_ROWS_DESCRIPTION },
        maxChars: { type: 'integer', minimum: PAGE_LIMITS.MIN_PAGE_CHARS, description: MAX_CHARS_DESCRIPTION },
        offset: { type: 'integer', minimum: 0, description: 'Row offset (0-based) to start from. Defaults to where the previous page ended.' },
      },
      required: ['resultId'],
    },
  },
  {
    name: 'export_query',
    description:
      'Execute SQL and stream the complete result to a local CSV or JSONL file, with no row or size limit. Returns the file path, a ' +
      'schema file path, the row count, the file size and a 10-row preview; the data itself is not returned in the response. Use it ' +
      'for complete datasets, for example to load into another tool. Values are exact and not sanitized (see format). For ' +
      'long exports pass wait: false and poll export_status. Export files are deleted when the server restarts, so move files ' +
      'you want to keep.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL to execute. In a script, the result of the last statement is exported, so it must return rows.' },
        format: {
          type: 'string',
          enum: ['csv', 'jsonl'],
          default: 'csv',
          description:
            '"csv" (header row; each value is the database\'s text, booleans are true/false, NULL is an empty field) or "jsonl" ' +
            '(one JSON array per line; int2, int4 and finite floats are numbers, booleans are true/false, NULL is null, and ' +
            'everything else, including int8, numeric and dates, is the database\'s text).',
        },
        fileName: { type: 'string', description: 'Base name for the file (letters, digits, dot, dash and underscore). A timestamp is added.' },
        wait: {
          type: 'boolean',
          default: true,
          description: 'true (default): wait for the export to finish. false: return an exportId at once; poll export_status.',
        },
        maxRows: { type: 'integer', minimum: 1, description: 'Stop after this many rows (the export is marked truncated). Default: no limit.' },
        maxBytes: { type: 'integer', minimum: 1, description: 'Stop before the file exceeds this many bytes (marked truncated). Default: no limit.' },
        timeoutMs: { type: 'integer', minimum: 0, description: TIMEOUT_DESCRIPTION },
      },
      required: ['sql'],
    },
  },
  {
    name: 'export_status',
    description:
      'Show the state of an export started with export_query: queued (with its queue position), running (rows and bytes written ' +
      'so far), done (with the file path and details), failed or cancelled. Pass cancel: true to cancel a queued or running export.',
    inputSchema: {
      type: 'object',
      properties: {
        exportId: { type: 'string', pattern: '^e_[a-z2-7]{16}$', description: 'The exportId from export_query.' },
        cancel: { type: 'boolean', default: false, description: 'Cancel the export.' },
      },
      required: ['exportId'],
    },
  },
  { name: 'list_schemas', description: 'List all schemas in the database (excluding system schemas)', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'list_tables', description: 'List all tables in a schema',
    inputSchema: { type: 'object', properties: { schema: { type: 'string', description: 'Schema name (default: public)', default: 'public' } } },
  },
  {
    name: 'describe_table', description: 'Get column information for a table',
    inputSchema: { type: 'object', properties: { table: { type: 'string', description: 'Table name (can include schema prefix like schema.table)' } }, required: ['table'] },
  },
  {
    name: 'get_sample_data', description: 'Get sample rows from a table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (can include schema prefix)' },
        limit: { type: 'number', description: 'Number of rows to return (1 to 1,000; default: 5)', default: 5 },
      },
      required: ['table'],
    },
  },
  {
    name: 'connection_status',
    description:
      'Check the database connection. If it fails, reports which step failed (settings, DNS, network or VPN, TLS, login) and how to fix it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_schema_context',
    description: 'IMPORTANT: Load schema knowledge, query patterns, and best practices for this database. Call this FIRST before writing queries to learn about table structures, required filters, and common patterns. Use list_presets to see available contexts.',
    inputSchema: { type: 'object', properties: { preset: { type: 'string', description: 'Schema preset name (use list_presets to see available options)' } }, required: ['preset'] },
  },
  { name: 'list_presets', description: 'List all available schema context presets. RECOMMENDED: Call this first when working with an unfamiliar database to discover available documentation and best practices.', inputSchema: { type: 'object', properties: {} } },
];

export interface ToolExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>;
}

export interface ToolContext {
  runtime: Runtime;
  /** The client negotiated MCP 2025-06-18 or later, so it understands resource_link content. */
  resourceLinks: boolean;
}

type Content =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
  [key: string]: unknown;
}

function text(value: string): Content {
  return { type: 'text', text: sanitizeResponseText(value) };
}

function pageResult(page: RenderedPage): ToolResult {
  return { content: page.blocks.map(text) };
}

function jsonText(value: unknown): Content {
  return text(JSON.stringify(value, null, 2));
}

function resourceLink(job: ExportJob): Content {
  return {
    type: 'resource_link',
    uri: pathToFileURL(job.paths.finalPath).href,
    name: path.basename(job.paths.finalPath),
    mimeType: job.format === 'csv' ? 'text/csv' : 'application/x-ndjson',
    description: `${job.rowsWritten.toLocaleString('en-US')} rows exported by ${SERVER_NAME}`,
  };
}

function progressFor(extra: ToolExtra, runtime: Runtime): ProgressReporter | null {
  if (!extra.sendNotification) return null;
  return ProgressReporter.fromExtra(extra as never, runtime.config.progressIntervalMs);
}

async function withProgress<T>(extra: ToolExtra, runtime: Runtime, fn: (progress: ProgressReporter | null) => Promise<T>): Promise<T> {
  const progress = progressFor(extra, runtime);
  progress?.start();
  try {
    return await fn(progress);
  } finally {
    progress?.stop();
  }
}

const CATALOG_PAGE = { format: 'table' as const };

export async function handleToolCall(name: string, args: unknown, extra: ToolExtra, ctx: ToolContext): Promise<ToolResult> {
  const rt = ctx.runtime;
  const cfg = rt.config;
  try {
    switch (name) {
      case 'run_query': {
        const v = RunQueryInputSchema.parse(args ?? {});
        const page = await withProgress(extra, rt, (progress) => runQuery({
          sql: v.sql,
          format: v.format,
          maxRows: v.maxRows ?? cfg.defaultMaxRows,
          maxChars: v.maxChars ?? cfg.maxInlineChars,
          timeoutMs: v.timeoutMs ?? cfg.statementTimeoutMs,
          signal: extra.signal,
          progress,
        }, rt));
        return pageResult(page);
      }
      case 'fetch_rows': {
        const v = FetchRowsInputSchema.parse(args ?? {});
        const page = await withProgress(extra, rt, (progress) => rt.results.fetch(v.resultId, {
          format: v.format,
          maxRows: v.maxRows ?? cfg.defaultMaxRows,
          maxChars: Math.min(v.maxChars ?? cfg.maxInlineChars, cfg.maxInlineCharsCeiling),
          ceiling: cfg.maxInlineCharsCeiling,
          offset: v.offset,
        }, { signal: extra.signal, progress }));
        return pageResult(page);
      }
      case 'export_query': {
        const v = ExportQueryInputSchema.parse(args ?? {});
        const job = await rt.exports.submit({
          sql: v.sql,
          format: v.format,
          fileName: v.fileName,
          maxRows: v.maxRows,
          maxBytes: v.maxBytes,
          timeoutMs: v.timeoutMs ?? cfg.statementTimeoutMs,
        });
        if (!v.wait) {
          const started: Record<string, unknown> = { exportId: job.id, state: job.state };
          const position = rt.exports.queuePosition(job);
          if (position !== null) started.queuePosition = position;
          return { content: [jsonText(started)] };
        }
        await withProgress(extra, rt, async (progress) => {
          progress?.setProvider(() => exportProgress(job, rt.exports));
          await rt.exports.wait(job, extra.signal);
        });
        if (job.state !== 'done') {
          // job.error is already the described error (without its "Error: " prefix).
          return { content: [text(`Error: ${job.error ?? `The export ended as ${job.state}.`}`)], isError: true };
        }
        const content = [jsonText(exportResult(job, sanitizeString))];
        if (ctx.resourceLinks) content.push(resourceLink(job));
        return { content };
      }
      case 'export_status': {
        const v = ExportStatusInputSchema.parse(args ?? {});
        const job = rt.exports.get(v.exportId);
        if (!job) {
          throw new Error(
            `export ${v.exportId} is unknown. Exports are tracked only until the server restarts; finished files stay in ${rt.files.exportsDir}.`,
          );
        }
        if (v.cancel) await rt.exports.cancel(job);
        const content = [jsonText(exportStatus(job, rt.exports, sanitizeString))];
        if (job.state === 'done' && ctx.resourceLinks) content.push(resourceLink(job));
        return { content };
      }
      case 'list_schemas': {
        const result = await executeQuery(`
          SELECT schema_name FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_internal')
          ORDER BY schema_name
        `);
        return pageResult(await renderBuffered(result, { ...CATALOG_PAGE, maxRows: cfg.defaultMaxRows, maxChars: cfg.maxInlineChars }, rt));
      }
      case 'list_tables': {
        const validated = ListTablesInputSchema.parse(args ?? {});
        const result = await executeQuery(`
          SELECT table_name, table_type FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name
        `, [validated.schema]);
        return pageResult(await renderBuffered(result, { ...CATALOG_PAGE, maxRows: cfg.defaultMaxRows, maxChars: cfg.maxInlineChars }, rt));
      }
      case 'describe_table': {
        const validated = DescribeTableInputSchema.parse(args ?? {});
        const parts = validated.table.split('.');
        const schema = parts.length > 1 ? parts[0] : 'public';
        const tableName = parts.length > 1 ? parts[1] : parts[0];
        const result = await executeQuery(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, tableName]);
        return pageResult(await renderBuffered(result, { ...CATALOG_PAGE, maxRows: cfg.defaultMaxRows, maxChars: cfg.maxInlineChars }, rt));
      }
      case 'get_sample_data': {
        const validated = GetSampleDataInputSchema.parse(args ?? {});
        const page = await withProgress(extra, rt, (progress) => runQuery({
          sql: `SELECT * FROM ${validated.table} LIMIT ${validated.limit}`,
          format: 'table',
          maxRows: validated.limit,
          maxChars: cfg.maxInlineChars,
          timeoutMs: cfg.statementTimeoutMs,
          signal: extra.signal,
          progress,
          operation: 'get_sample_data',
        }, rt));
        return pageResult(page);
      }
      case 'connection_status':
        return { content: [text(await connectionStatus())] };
      case 'get_schema_context': {
        const validated = GetSchemaContextInputSchema.parse(args ?? {});
        const preset = await getPresetAsync(validated.preset);
        if (!preset) {
          const available = await listPresetsAsync();
          const availableText = available.length > 0
            ? `Available presets: ${available.join(', ')}`
            : 'No presets available. Set SQL_CONTEXT_DIR, SQL_CONTEXT_S3, or SQL_CONTEXT_URL environment variable to load context files.';
          return { content: [text(`Unknown preset: ${validated.preset}\n\n${availableText}`)], isError: true };
        }
        const responseText = truncateString(
          sanitizeResponseText(`# ${preset.name}\n\n${preset.description}\n\n${preset.context}`),
          LIMITS.MAX_RESPONSE_LENGTH,
        );
        return { content: [{ type: 'text', text: responseText }] };
      }
      case 'list_presets': {
        const presets = await listPresetsAsync();
        if (presets.length === 0) {
          return { content: [text(
            `# No Schema Presets Available\n\nTo add custom presets, set environment variables:\n- \`SQL_CONTEXT_DIR\`: Local directory containing .md or .json files\n- \`SQL_CONTEXT_S3\`: S3 URI (s3://bucket/prefix/) containing context files\n- \`SQL_CONTEXT_URL\`: HTTP/HTTPS URL to a single context file\n- \`SQL_CONTEXT_FILE\`: Path to a single local context file`,
          )] };
        }
        const presetDetails = await Promise.all(presets.map(async (presetName) => {
          const preset = await getPresetAsync(presetName);
          return `- **${sanitizeString(presetName)}**: ${sanitizeString(preset?.description || 'No description')}`;
        }));
        return { content: [text(
          `# Available Schema Presets\n\n${presetDetails.join('\n')}\n\nUse \`get_schema_context\` with a preset name to load the context.`,
        )] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { content: [text(`Validation Error: ${issues}`)], isError: true };
    }
    const rendered = await describeError(error);
    return { content: [text(rendered.text)], isError: true };
  }
}
