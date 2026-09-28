"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOLS = void 0;
exports.handleToolCall = handleToolCall;
/**
 * MCP tool definitions and handlers.
 */
const path = __importStar(require("path"));
const url_1 = require("url");
const zod_1 = require("zod");
const index_js_1 = require("./presets/index.js");
const schemas_js_1 = require("./validation/schemas.js");
const sanitizer_js_1 = require("./validation/sanitizer.js");
const pool_1 = require("./db/pool");
const buffered_1 = require("./db/buffered");
const runner_1 = require("./runner");
const progress_1 = require("./mcp/progress");
const manager_1 = require("./export/manager");
const version_1 = require("./version");
const FORMAT_DESCRIPTION = 'Output format: "table" (default; readable text), "csv" (a header and rows, returned as a separate text block from the status line), ' +
    'or "json" (typed exact values with paging metadata; meant for programs).';
const MAX_ROWS_DESCRIPTION = `Most rows to return in this page (1 to ${schemas_js_1.PAGE_LIMITS.MAX_PAGE_ROWS.toLocaleString('en-US')}; default 100). The character budget can end the page earlier.`;
const MAX_CHARS_DESCRIPTION = 'Character budget for this page (default 100,000; values above the server ceiling, 5,000,000 by default, are reduced to it). ' +
    'Meant for programs that load data; for analysis in chat, aggregate in SQL instead.';
const TIMEOUT_DESCRIPTION = 'Cancel a statement that runs longer than this many milliseconds; 0 means no timeout. ' +
    'Default: the server setting (no timeout unless SQL_STATEMENT_TIMEOUT_MS is set).';
exports.TOOLS = [
    {
        name: 'run_query',
        description: 'Execute SQL on the connected database (PostgreSQL or Redshift) and return one page of the result, sized for model context ' +
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
                maxRows: { type: 'integer', minimum: 1, maximum: schemas_js_1.PAGE_LIMITS.MAX_PAGE_ROWS, description: MAX_ROWS_DESCRIPTION },
                maxChars: { type: 'integer', minimum: schemas_js_1.PAGE_LIMITS.MIN_PAGE_CHARS, description: MAX_CHARS_DESCRIPTION },
                timeoutMs: { type: 'integer', minimum: 0, description: TIMEOUT_DESCRIPTION },
            },
            required: ['sql'],
        },
    },
    {
        name: 'fetch_rows',
        description: 'Read the next page of a result returned by run_query (or get_sample_data and the catalog tools), using its resultId. ' +
            'Continues where the previous page ended, or starts at `offset`. The query is not run again. Results are kept until the server ' +
            'restarts; very large results keep an open cursor that can only move forward and closes after 15 idle minutes.',
        inputSchema: {
            type: 'object',
            properties: {
                resultId: { type: 'string', pattern: '^r_[a-z2-7]{16}$', description: 'The resultId from a previous response.' },
                format: { type: 'string', enum: ['table', 'csv', 'json'], default: 'table', description: FORMAT_DESCRIPTION },
                maxRows: { type: 'integer', minimum: 1, maximum: schemas_js_1.PAGE_LIMITS.MAX_PAGE_ROWS, description: MAX_ROWS_DESCRIPTION },
                maxChars: { type: 'integer', minimum: schemas_js_1.PAGE_LIMITS.MIN_PAGE_CHARS, description: MAX_CHARS_DESCRIPTION },
                offset: { type: 'integer', minimum: 0, description: 'Row offset (0-based) to start from. Defaults to where the previous page ended.' },
            },
            required: ['resultId'],
        },
    },
    {
        name: 'export_query',
        description: 'Execute SQL and stream the complete result to a local CSV or JSONL file, with no row or size limit. Returns the file path, a ' +
            'schema file path, the row count, the file size and a 10-row preview; the data itself is not returned in the response. Use it ' +
            'for complete datasets, for example to load into another tool. Values are written exactly as the database returns them. For ' +
            'long exports pass wait: false and poll export_status.',
        inputSchema: {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'The SQL to execute. In a script, the result of the last statement is exported, so it must return rows.' },
                format: {
                    type: 'string',
                    enum: ['csv', 'jsonl'],
                    default: 'csv',
                    description: '"csv" (header row; NULL is an empty field) or "jsonl" (one JSON array of exact values per line; NULL is null).',
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
        description: 'Show the state of an export started with export_query: queued (with its queue position), running (rows and bytes written ' +
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
    { name: 'connection_status', description: 'Check the current database connection status', inputSchema: { type: 'object', properties: {} } },
    {
        name: 'get_schema_context',
        description: 'IMPORTANT: Load schema knowledge, query patterns, and best practices for this database. Call this FIRST before writing queries to learn about table structures, required filters, and common patterns. Use list_presets to see available contexts.',
        inputSchema: { type: 'object', properties: { preset: { type: 'string', description: 'Schema preset name (use list_presets to see available options)' } }, required: ['preset'] },
    },
    { name: 'list_presets', description: 'List all available schema context presets. RECOMMENDED: Call this first when working with an unfamiliar database to discover available documentation and best practices.', inputSchema: { type: 'object', properties: {} } },
];
function text(value) {
    return { type: 'text', text: (0, sanitizer_js_1.sanitizeResponseText)(value) };
}
function pageResult(page) {
    return { content: page.blocks.map(text) };
}
function jsonText(value) {
    return text(JSON.stringify(value, null, 2));
}
function resourceLink(job) {
    return {
        type: 'resource_link',
        uri: (0, url_1.pathToFileURL)(job.paths.finalPath).href,
        name: path.basename(job.paths.finalPath),
        mimeType: job.format === 'csv' ? 'text/csv' : 'application/x-ndjson',
        description: `${job.rowsWritten.toLocaleString('en-US')} rows exported by ${version_1.SERVER_NAME}`,
    };
}
function progressFor(extra, runtime) {
    if (!extra.sendNotification)
        return null;
    return progress_1.ProgressReporter.fromExtra(extra, runtime.config.progressIntervalMs);
}
async function withProgress(extra, runtime, fn) {
    const progress = progressFor(extra, runtime);
    progress?.start();
    try {
        return await fn(progress);
    }
    finally {
        progress?.stop();
    }
}
const CATALOG_PAGE = { format: 'table' };
async function handleToolCall(name, args, extra, ctx) {
    const rt = ctx.runtime;
    const cfg = rt.config;
    try {
        switch (name) {
            case 'run_query': {
                const v = schemas_js_1.RunQueryInputSchema.parse(args ?? {});
                const page = await withProgress(extra, rt, (progress) => (0, runner_1.runQuery)({
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
                const v = schemas_js_1.FetchRowsInputSchema.parse(args ?? {});
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
                const v = schemas_js_1.ExportQueryInputSchema.parse(args ?? {});
                const job = await rt.exports.submit({
                    sql: v.sql,
                    format: v.format,
                    fileName: v.fileName,
                    maxRows: v.maxRows,
                    maxBytes: v.maxBytes,
                    timeoutMs: v.timeoutMs ?? cfg.statementTimeoutMs,
                });
                if (!v.wait) {
                    const started = { exportId: job.id, state: job.state };
                    const position = rt.exports.queuePosition(job);
                    if (position !== null)
                        started.queuePosition = position;
                    return { content: [jsonText(started)] };
                }
                await withProgress(extra, rt, async (progress) => {
                    progress?.setProvider(() => (0, manager_1.exportProgress)(job, rt.exports));
                    await rt.exports.wait(job, extra.signal);
                });
                if (job.state !== 'done')
                    throw new Error(job.error ?? `The export ended as ${job.state}.`);
                const content = [jsonText((0, manager_1.exportResult)(job, sanitizer_js_1.sanitizeString))];
                if (ctx.resourceLinks)
                    content.push(resourceLink(job));
                return { content };
            }
            case 'export_status': {
                const v = schemas_js_1.ExportStatusInputSchema.parse(args ?? {});
                const job = rt.exports.get(v.exportId);
                if (!job) {
                    throw new Error(`export ${v.exportId} is unknown. Exports are tracked only until the server restarts; finished files stay in ${rt.files.exportsDir}.`);
                }
                if (v.cancel)
                    await rt.exports.cancel(job);
                const content = [jsonText((0, manager_1.exportStatus)(job, rt.exports, sanitizer_js_1.sanitizeString))];
                if (job.state === 'done' && ctx.resourceLinks)
                    content.push(resourceLink(job));
                return { content };
            }
            case 'list_schemas': {
                const result = await (0, buffered_1.executeQuery)(`
          SELECT schema_name FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_internal')
          ORDER BY schema_name
        `);
                return pageResult(await (0, runner_1.renderBuffered)(result, { ...CATALOG_PAGE, maxRows: cfg.defaultMaxRows, maxChars: cfg.maxInlineChars }, rt));
            }
            case 'list_tables': {
                const validated = schemas_js_1.ListTablesInputSchema.parse(args ?? {});
                const result = await (0, buffered_1.executeQuery)(`
          SELECT table_name, table_type FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name
        `, [validated.schema]);
                return pageResult(await (0, runner_1.renderBuffered)(result, { ...CATALOG_PAGE, maxRows: cfg.defaultMaxRows, maxChars: cfg.maxInlineChars }, rt));
            }
            case 'describe_table': {
                const validated = schemas_js_1.DescribeTableInputSchema.parse(args ?? {});
                const parts = validated.table.split('.');
                const schema = parts.length > 1 ? parts[0] : 'public';
                const tableName = parts.length > 1 ? parts[1] : parts[0];
                const result = await (0, buffered_1.executeQuery)(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, tableName]);
                return pageResult(await (0, runner_1.renderBuffered)(result, { ...CATALOG_PAGE, maxRows: cfg.defaultMaxRows, maxChars: cfg.maxInlineChars }, rt));
            }
            case 'get_sample_data': {
                const validated = schemas_js_1.GetSampleDataInputSchema.parse(args ?? {});
                const page = await withProgress(extra, rt, (progress) => (0, runner_1.runQuery)({
                    sql: `SELECT * FROM ${validated.table} LIMIT ${validated.limit}`,
                    format: 'table',
                    maxRows: validated.limit,
                    maxChars: cfg.maxInlineChars,
                    timeoutMs: cfg.statementTimeoutMs,
                    signal: extra.signal,
                    progress,
                }, rt));
                return pageResult(page);
            }
            case 'connection_status': {
                try {
                    const activePool = await (0, pool_1.ensurePool)();
                    const result = await activePool.query(`
            SELECT current_database() as database, current_user as user, inet_server_addr() as host
          `);
                    const row = result.rows[0];
                    return { content: [text(`Connected\nDatabase: ${row.database}\nUser: ${row.user}\nHost: ${row.host || process.env.SQL_HOST}`)] };
                }
                catch (error) {
                    return { content: [text(`Not connected: ${error instanceof Error ? error.message : 'Unknown error'}`)] };
                }
            }
            case 'get_schema_context': {
                const validated = schemas_js_1.GetSchemaContextInputSchema.parse(args ?? {});
                const preset = await (0, index_js_1.getPresetAsync)(validated.preset);
                if (!preset) {
                    const available = await (0, index_js_1.listPresetsAsync)();
                    const availableText = available.length > 0
                        ? `Available presets: ${available.join(', ')}`
                        : 'No presets available. Set SQL_CONTEXT_DIR, SQL_CONTEXT_S3, or SQL_CONTEXT_URL environment variable to load context files.';
                    return { content: [text(`Unknown preset: ${validated.preset}\n\n${availableText}`)], isError: true };
                }
                const responseText = (0, sanitizer_js_1.truncateString)((0, sanitizer_js_1.sanitizeResponseText)(`# ${preset.name}\n\n${preset.description}\n\n${preset.context}`), schemas_js_1.LIMITS.MAX_RESPONSE_LENGTH);
                return { content: [{ type: 'text', text: responseText }] };
            }
            case 'list_presets': {
                const presets = await (0, index_js_1.listPresetsAsync)();
                if (presets.length === 0) {
                    return { content: [text(`# No Schema Presets Available\n\nTo add custom presets, set environment variables:\n- \`SQL_CONTEXT_DIR\`: Local directory containing .md or .json files\n- \`SQL_CONTEXT_S3\`: S3 URI (s3://bucket/prefix/) containing context files\n- \`SQL_CONTEXT_URL\`: HTTP/HTTPS URL to a single context file\n- \`SQL_CONTEXT_FILE\`: Path to a single local context file`)] };
                }
                const presetDetails = await Promise.all(presets.map(async (presetName) => {
                    const preset = await (0, index_js_1.getPresetAsync)(presetName);
                    return `- **${(0, sanitizer_js_1.sanitizeString)(presetName)}**: ${(0, sanitizer_js_1.sanitizeString)(preset?.description || 'No description')}`;
                }));
                return { content: [text(`# Available Schema Presets\n\n${presetDetails.join('\n')}\n\nUse \`get_schema_context\` with a preset name to load the context.`)] };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        if (error instanceof zod_1.ZodError) {
            const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
            return { content: [text(`Validation Error: ${issues}`)], isError: true };
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { content: [text(`Error: ${message}`)], isError: true };
    }
}
