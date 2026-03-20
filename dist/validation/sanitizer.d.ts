/**
 * Response Content Sanitizer
 *
 * Strips undesirable characters from response content to mitigate:
 * - Hidden character smuggling
 * - Injection attempts
 * - Control character attacks
 */
export declare function sanitizeString(input: string): string;
export declare function sanitizeValue(value: unknown): unknown;
export declare function sanitizeRows(rows: unknown[][]): unknown[][];
export declare function sanitizeColumns(columns: string[]): string[];
export declare function sanitizeResponseText(text: string): string;
export declare function detectSuspiciousPatterns(input: string): {
    isSuspicious: boolean;
    patterns: string[];
};
export declare function truncateString(input: string, maxLength: number): string;
//# sourceMappingURL=sanitizer.d.ts.map