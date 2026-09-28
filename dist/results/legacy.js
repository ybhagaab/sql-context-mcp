"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatResults = formatResults;
/**
 * Legacy table formatting for buffered results.
 */
const schemas_js_1 = require("../validation/schemas.js");
const sanitizer_js_1 = require("../validation/sanitizer.js");
function formatResults(result) {
    if (result.rows.length === 0) {
        return (0, sanitizer_js_1.sanitizeResponseText)(`Query executed successfully. ${result.rowCount} rows affected. (${result.executionTime}ms)`);
    }
    const widths = result.columns.map((col, i) => {
        const maxDataWidth = Math.max(...result.rows.map(row => String(row[i] ?? 'NULL').length));
        return Math.max(col.length, maxDataWidth, 4);
    });
    const header = result.columns.map((col, i) => col.padEnd(widths[i])).join(' | ');
    const separator = widths.map(w => '-'.repeat(w)).join('-+-');
    const displayRows = result.rows.slice(0, 100);
    const rowStrings = displayRows.map(row => row.map((val, i) => String(val ?? 'NULL').padEnd(widths[i])).join(' | '));
    let output = `${header}\n${separator}\n${rowStrings.join('\n')}`;
    if (result.rows.length > 100)
        output += `\n... (${result.rows.length - 100} more rows)`;
    output += `\n\n${result.rowCount} rows returned. (${result.executionTime}ms)`;
    return (0, sanitizer_js_1.truncateString)((0, sanitizer_js_1.sanitizeResponseText)(output), schemas_js_1.LIMITS.MAX_RESPONSE_LENGTH);
}
