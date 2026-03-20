/**
 * Response Content Sanitizer
 *
 * Strips undesirable characters from response content to mitigate:
 * - Hidden character smuggling
 * - Injection attempts
 * - Control character attacks
 */

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const UNICODE_CONTROL = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const VARIATION_SELECTORS = /[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;

export function sanitizeString(input: string): string {
  if (typeof input !== 'string') {
    return String(input);
  }
  return input
    .replace(CONTROL_CHARS, '')
    .replace(UNICODE_CONTROL, '')
    .replace(PRIVATE_USE, '')
    .replace(TAG_CHARS, '')
    .replace(VARIATION_SELECTORS, '');
}

export function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[sanitizeString(key)] = sanitizeValue(val);
    }
    return sanitized;
  }
  return value;
}

export function sanitizeRows(rows: unknown[][]): unknown[][] {
  return rows.map(row => row.map(cell => {
    if (typeof cell === 'string') return sanitizeString(cell);
    return cell;
  }));
}

export function sanitizeColumns(columns: string[]): string[] {
  return columns.map(sanitizeString);
}

export function sanitizeResponseText(text: string): string {
  return sanitizeString(text);
}

export function detectSuspiciousPatterns(input: string): {
  isSuspicious: boolean;
  patterns: string[];
} {
  const patterns: string[] = [];
  if (input.includes('\x00')) patterns.push('null_byte');
  const controlCount = (input.match(CONTROL_CHARS) || []).length;
  if (controlCount > 10) patterns.push('excessive_control_chars');
  const hiddenCount = (input.match(UNICODE_CONTROL) || []).length;
  if (hiddenCount > 5) patterns.push('hidden_unicode');
  if (PRIVATE_USE.test(input)) patterns.push('private_use_chars');
  return { isSuspicious: patterns.length > 0, patterns };
}

export function truncateString(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return input.slice(0, maxLength - 20) + '\n... [truncated]';
}
