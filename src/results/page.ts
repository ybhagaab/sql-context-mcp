/**
 * Budgeted page builder and renderers (design Component 7).
 *
 * Rows are added one at a time. The builder tracks the exact rendered size incrementally and
 * rejects the row that would exceed `maxChars` (or `maxRows`); that row becomes carry-over for the
 * next page. A room reserve (FOOTER_RESERVE) is kept for the status/footer lines or the JSON
 * envelope, whose final values are only known after the page is built.
 *
 * Formats:
 * - table: today's padded layout (legacy value display), widths from the page's rows;
 * - csv:   RFC 4180, exact wire text, NULL as an empty unquoted field, '' as "";
 * - json:  one object with typed exact values and paging metadata.
 */
import { ColumnInfo, toExact, toCsvText, toLegacyDisplay, ExactValue } from './values';
import { sanitizeString } from '../validation/sanitizer.js';

export type Format = 'table' | 'csv' | 'json';
export type PagingUnavailable = 'busy' | 'too-large' | 'unavailable';

export interface PageMeta {
  /** 'run' for run_query/get_sample_data/metadata tools, 'fetch' for fetch_rows. */
  mode: 'run' | 'fetch';
  /** 0-based index of the first row in this page. */
  offset: number;
  /** Exact total rows in the result, or null when unknown. */
  totalRows: number | null;
  /** More rows exist after this page. */
  hasMore: boolean;
  /** Result session to continue with fetch_rows, when paging is available. */
  resultId: string | null;
  /** Why paging isn't available although more rows exist. */
  pagingUnavailable?: PagingUnavailable | null;
  executionTimeMs: number;
  /** Summaries of earlier script statements, e.g. "SET" or "INSERT (5 rows)". */
  statements?: string[];
  /** For statements without rows. */
  command?: string;
  rowsAffected?: number | null;
}

export interface RenderedPage {
  blocks: string[];
}

export class RowTooLargeError extends Error {
  constructor(public readonly size: number, public readonly ceiling: number) {
    super(`A single row needs ${size} characters, more than the ${ceiling}-character limit for one response. Use export_query for this result.`);
    this.name = 'RowTooLargeError';
  }
}

/** Room reserved for footer/status lines or the JSON envelope suffix. */
export const FOOTER_RESERVE = 800;
const MAX_STATEMENTS_LISTED = 10;
const MAX_STATEMENT_SUMMARY_LENGTH = 40;

export interface PageBuilderOptions {
  format: Format;
  columns: ColumnInfo[];
  maxRows: number;
  maxChars: number;
  /** Hard limit for a single oversized row returned on its own. */
  ceiling: number;
  /** Apply hidden-character sanitization to strings and column names (default true). */
  sanitize?: boolean;
}

/** RFC 4180 field quoting: quoted when it contains a comma, quote, CR or LF; '' becomes "". */
export function quoteCsv(text: string): string {
  if (text === '') return '""';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** PostgreSQL type names are at most 63 characters (NAMEDATALEN - 1). */
const MAX_TYPE_NAME_LENGTH = 63;
const UNRESOLVED_TYPE = /^\d+$/;

function summarizeStatements(statements: string[]): string[] {
  return statements.map((s) => (s.length > MAX_STATEMENT_SUMMARY_LENGTH ? `${s.slice(0, MAX_STATEMENT_SUMMARY_LENGTH - 1)}…` : s));
}

function statementsLine(statements: string[] | undefined): string | null {
  if (!statements || statements.length === 0) return null;
  const listed = summarizeStatements(statements.slice(0, MAX_STATEMENTS_LISTED));
  const more = statements.length > MAX_STATEMENTS_LISTED ? `, and ${statements.length - MAX_STATEMENTS_LISTED} more` : '';
  return `Earlier statements: ${listed.join(', ')}${more}`;
}

function unavailableLine(reason: PagingUnavailable | null | undefined): string {
  switch (reason) {
    case 'busy':
      return 'More rows exist, but paging is busy. Use export_query or narrow the query.';
    case 'too-large':
      return 'More rows exist, but this result is too large to page. Use export_query or narrow the query.';
    default:
      return "More rows exist, but paging isn't available for this result. Use export_query or narrow the query.";
  }
}

function pagingLine(meta: PageMeta): string | null {
  if (!meta.hasMore) return null;
  if (meta.resultId) {
    const call = `fetch_rows {"resultId":"${meta.resultId}"}`;
    return meta.mode === 'run' ? `More rows: ${call}; full result: export_query` : `More rows: ${call}`;
  }
  return unavailableLine(meta.pagingUnavailable);
}

function rangeLine(meta: PageMeta, count: number): string {
  if (count === 0) {
    if (meta.mode === 'run') return 'No rows.';
    return `No rows at offset ${meta.offset} (total ${meta.totalRows ?? 'unknown'}).`;
  }
  const first = meta.offset + 1;
  const last = meta.offset + count;
  const total = meta.totalRows === null ? `more than ${last}` : String(meta.totalRows);
  return `Rows ${first}–${last} of ${total}.`;
}

export class PageBuilder {
  readonly rows: unknown[][] = [];
  private full = false;
  private readonly sanitize: boolean;
  private readonly names: string[];
  // table state
  private widths: number[];
  private readonly displays: string[][] = [];
  // csv state
  private readonly csvHeader: string;
  private readonly csvLines: string[] = [];
  private csvSize: number;
  // json state
  private readonly jsonRows: string[] = [];
  private jsonSize: number;

  constructor(private readonly opts: PageBuilderOptions) {
    this.sanitize = opts.sanitize ?? true;
    this.names = opts.columns.map((c) => this.clean(c.name));
    this.widths = this.names.map((n) => Math.max(n.length, 4));
    this.csvHeader = this.names.map(quoteCsv).join(',');
    this.csvSize = this.csvHeader.length;
    // Type names may still be resolved (from pg_type) after rows were added, so the JSON prefix is
    // built at render time. Room is reserved now for the longest possible name of each column
    // whose type is still an OID.
    const slack = opts.columns.reduce(
      (sum, c) => sum + (UNRESOLVED_TYPE.test(c.type) ? Math.max(0, MAX_TYPE_NAME_LENGTH - c.type.length) : 0),
      0,
    );
    this.jsonSize = this.jsonPrefix().length + slack;
  }

  private jsonPrefix(): string {
    const columns = this.opts.columns.map((c, i) => ({ name: this.names[i], type: this.clean(c.type) }));
    return `{"columns":${JSON.stringify(columns)},"rows":[`;
  }

  get count(): number {
    return this.rows.length;
  }

  get isFull(): boolean {
    return this.full;
  }

  get columns(): ColumnInfo[] {
    return this.opts.columns;
  }

  private clean(text: string): string {
    return this.sanitize ? sanitizeString(text) : text;
  }

  private cleanExact(value: ExactValue): ExactValue {
    return typeof value === 'string' ? this.clean(value) : value;
  }

  /**
   * Adds a row if it fits. Returns false (row not added) when the page is full. Throws
   * RowTooLargeError when a single row alone exceeds the ceiling.
   */
  tryAdd(raw: unknown[]): boolean {
    if (this.full) return false;
    if (this.rows.length >= this.opts.maxRows) {
      this.full = true;
      return false;
    }
    const candidate = this.measure(raw);
    const fits = candidate.size <= this.opts.maxChars;
    if (!fits) {
      if (this.rows.length > 0) {
        this.full = true;
        return false;
      }
      if (candidate.size > this.opts.ceiling) throw new RowTooLargeError(candidate.size, this.opts.ceiling);
    }
    this.commit(raw, candidate);
    if (!fits || this.rows.length >= this.opts.maxRows) this.full = true;
    return true;
  }

  private measure(raw: unknown[]): { size: number; display?: string[]; widths?: number[]; line?: string } {
    const cols = this.opts.columns;
    switch (this.opts.format) {
      case 'table': {
        const display = cols.map((c, i) => this.clean(toLegacyDisplay(raw[i], c.oid)));
        const widths = this.widths.map((w, i) => Math.max(w, display[i].length));
        const lineLen = widths.reduce((a, b) => a + b, 0) + 3 * Math.max(cols.length - 1, 0);
        const n = this.rows.length + 1;
        return { size: (n + 2) * lineLen + (n + 1) + FOOTER_RESERVE, display, widths };
      }
      case 'csv': {
        const line = cols
          .map((c, i) => {
            const text = toCsvText(raw[i], c.oid);
            return text === null ? '' : quoteCsv(this.clean(text));
          })
          .join(',');
        return { size: this.csvSize + 1 + line.length + FOOTER_RESERVE, line };
      }
      case 'json': {
        const line = JSON.stringify(cols.map((c, i) => this.cleanExact(toExact(raw[i], c.oid))));
        const separator = this.rows.length > 0 ? 1 : 0;
        return { size: this.jsonSize + separator + line.length + FOOTER_RESERVE, line };
      }
    }
  }

  private commit(raw: unknown[], m: { size: number; display?: string[]; widths?: number[]; line?: string }): void {
    this.rows.push(raw);
    switch (this.opts.format) {
      case 'table':
        this.displays.push(m.display as string[]);
        this.widths = m.widths as number[];
        break;
      case 'csv':
        this.csvLines.push(m.line as string);
        this.csvSize += 1 + (m.line as string).length;
        break;
      case 'json':
        this.jsonSize += (this.jsonRows.length > 0 ? 1 : 0) + (m.line as string).length;
        this.jsonRows.push(m.line as string);
        break;
    }
  }

  render(meta: PageMeta): RenderedPage {
    const n = this.rows.length;
    const ms = meta.executionTimeMs;
    const noColumns = this.opts.columns.length === 0;

    if (this.opts.format === 'json') {
      const parts = [
        `],"rowCount":${n}`,
        `"offset":${meta.offset}`,
        `"totalRows":${meta.totalRows === null ? 'null' : meta.totalRows}`,
        `"hasMore":${meta.hasMore}`,
        `"truncated":${meta.hasMore}`,
        `"resultId":${meta.resultId ? JSON.stringify(meta.resultId) : 'null'}`,
        `"executionTimeMs":${ms}`,
      ];
      if (meta.statements && meta.statements.length) parts.push(`"statements":${JSON.stringify(summarizeStatements(meta.statements.slice(0, MAX_STATEMENTS_LISTED)))}`);
      if (meta.hasMore && !meta.resultId) parts.push(`"pagingUnavailable":${JSON.stringify(meta.pagingUnavailable ?? 'unavailable')}`);
      if (meta.command) parts.push(`"command":${JSON.stringify(meta.command)}`);
      if (meta.rowsAffected !== undefined && meta.rowsAffected !== null) parts.push(`"rowsAffected":${meta.rowsAffected}`);
      return { blocks: [`${this.jsonPrefix()}${this.jsonRows.join(',')}${parts.join(',')}}`] };
    }

    const extra = [pagingLine(meta), statementsLine(meta.statements)].filter((l): l is string => l !== null);

    if (noColumns) {
      const lines = [`Query executed successfully. ${meta.rowsAffected ?? 0} rows affected. (${ms}ms)`, ...extra];
      return { blocks: [lines.join('\n')] };
    }

    if (this.opts.format === 'csv') {
      const data = n ? `${this.csvHeader}\n${this.csvLines.join('\n')}` : this.csvHeader;
      const status = [meta.mode === 'run' ? `${rangeLine(meta, n)} (${ms}ms)` : rangeLine(meta, n), ...extra];
      return { blocks: [data, status.join('\n')] };
    }

    // table
    if (n === 0) {
      const first = meta.mode === 'run' ? `Query executed successfully. 0 rows affected. (${ms}ms)` : rangeLine(meta, 0);
      return { blocks: [[first, ...extra].join('\n')] };
    }
    const header = this.names.map((name, i) => name.padEnd(this.widths[i])).join(' | ');
    const separator = this.widths.map((w) => '-'.repeat(w)).join('-+-');
    const body = this.displays.map((d) => d.map((v, i) => v.padEnd(this.widths[i])).join(' | ')).join('\n');
    let output = `${header}\n${separator}\n${body}`;
    if (meta.mode === 'run') {
      if (meta.hasMore) {
        output += meta.totalRows === null ? '\n... (more rows)' : `\n... (${meta.totalRows - (meta.offset + n)} more rows)`;
      }
      output += meta.totalRows === null
        ? `\n\nMore than ${meta.offset + n} rows returned. (${ms}ms)`
        : `\n\n${meta.totalRows} rows returned. (${ms}ms)`;
    } else {
      output += `\n\n${rangeLine(meta, n)}`;
    }
    if (extra.length) output += `\n${extra.join('\n')}`;
    return { blocks: [output] };
  }
}
