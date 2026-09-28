/**
 * Legacy table formatting for buffered results.
 */
import { LIMITS } from '../validation/schemas.js';
import { sanitizeResponseText, truncateString } from '../validation/sanitizer.js';

export function formatResults(result: { columns: string[]; rows: any[][]; rowCount: number; executionTime: number }): string {
  if (result.rows.length === 0) {
    return sanitizeResponseText(`Query executed successfully. ${result.rowCount} rows affected. (${result.executionTime}ms)`);
  }
  const widths = result.columns.map((col, i) => {
    const maxDataWidth = Math.max(...result.rows.map(row => String(row[i] ?? 'NULL').length));
    return Math.max(col.length, maxDataWidth, 4);
  });
  const header = result.columns.map((col, i) => col.padEnd(widths[i])).join(' | ');
  const separator = widths.map(w => '-'.repeat(w)).join('-+-');
  const displayRows = result.rows.slice(0, 100);
  const rowStrings = displayRows.map(row =>
    row.map((val, i) => String(val ?? 'NULL').padEnd(widths[i])).join(' | ')
  );
  let output = `${header}\n${separator}\n${rowStrings.join('\n')}`;
  if (result.rows.length > 100) output += `\n... (${result.rows.length - 100} more rows)`;
  output += `\n\n${result.rowCount} rows returned. (${result.executionTime}ms)`;
  return truncateString(sanitizeResponseText(output), LIMITS.MAX_RESPONSE_LENGTH);
}
