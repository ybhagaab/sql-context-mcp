/**
 * Value conversion and type names (design Component 6).
 *
 * The execution paths fetch every value as the database's raw wire text (see RAW_TYPES) and
 * convert only when rendering:
 * - exact conversion (json, csv, exports): lossless, typed where safe;
 * - legacy conversion (table): today's look, via pg's default parsers.
 */
export interface ColumnInfo {
    name: string;
    oid: number;
    type: string;
}
export type ExactValue = string | number | boolean | null;
/** Per-query type parser that returns the wire text for every type (null stays null). */
export declare const RAW_TYPES: {
    getTypeParser: (_oid: number, _format?: string) => (value: string) => string;
};
/** Exact conversion of a raw wire value, per the design's table. */
export declare function toExact(raw: unknown, oid: number): ExactValue;
/** The text used for a value in CSV: the wire text, with booleans as true/false. */
export declare function toCsvText(raw: unknown, oid: number): string | null;
/**
 * Legacy table display: pg's default parser, then String(), exactly as today. Types the driver
 * parses into non-date objects (interval, bytea, json, arrays) show their wire text instead of
 * "[object Object]".
 */
export declare function toLegacyDisplay(raw: unknown, oid: number): string;
export declare function builtinTypeName(oid: number): string | undefined;
/** The type name for an OID: builtin, then registered (from pg_type), else the OID as a string. */
export declare function typeName(oid: number): string;
export declare function registerTypeNames(names: Record<number, string>): void;
/** OIDs with no known name yet (deduplicated). */
export declare function unknownOids(oids: number[]): number[];
export declare function columnsFromFields(fields: Array<{
    name: string;
    dataTypeID: number;
}>): ColumnInfo[];
//# sourceMappingURL=values.d.ts.map