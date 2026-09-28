"use strict";
/**
 * Value conversion and type names (design Component 6).
 *
 * The execution paths fetch every value as the database's raw wire text (see RAW_TYPES) and
 * convert only when rendering:
 * - exact conversion (json, csv, exports): lossless, typed where safe;
 * - legacy conversion (table): today's look, via pg's default parsers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RAW_TYPES = void 0;
exports.toExact = toExact;
exports.toCsvText = toCsvText;
exports.toLegacyDisplay = toLegacyDisplay;
exports.builtinTypeName = builtinTypeName;
exports.typeName = typeName;
exports.registerTypeNames = registerTypeNames;
exports.unknownOids = unknownOids;
exports.columnsFromFields = columnsFromFields;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgTypes = require('pg-types');
/** Per-query type parser that returns the wire text for every type (null stays null). */
exports.RAW_TYPES = {
    getTypeParser: (_oid, _format) => (value) => value,
};
const OID_BOOL = 16;
const OID_INT2 = 21;
const OID_INT4 = 23;
const OID_OID = 26;
const OID_FLOAT4 = 700;
const OID_FLOAT8 = 701;
const INTEGER_TEXT = /^-?\d+$/;
/** Exact conversion of a raw wire value, per the design's table. */
function toExact(raw, oid) {
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw === 'number' || typeof raw === 'boolean')
        return raw;
    const text = typeof raw === 'string' ? raw : String(raw);
    switch (oid) {
        case OID_INT2:
        case OID_INT4:
        case OID_OID:
            return INTEGER_TEXT.test(text) ? Number(text) : text;
        case OID_FLOAT4:
        case OID_FLOAT8: {
            const n = Number(text);
            return text.trim() !== '' && Number.isFinite(n) ? n : text;
        }
        case OID_BOOL:
            if (text === 't' || text === 'true')
                return true;
            if (text === 'f' || text === 'false')
                return false;
            return text;
        default:
            return text;
    }
}
/** The text used for a value in CSV: the wire text, with booleans as true/false. */
function toCsvText(raw, oid) {
    if (raw === null || raw === undefined)
        return null;
    if (oid === OID_BOOL && (raw === 't' || raw === 'f'))
        return raw === 't' ? 'true' : 'false';
    return typeof raw === 'string' ? raw : String(raw);
}
/**
 * Legacy table display: pg's default parser, then String(), exactly as today. Types the driver
 * parses into non-date objects (interval, bytea, json, arrays) show their wire text instead of
 * "[object Object]".
 */
function toLegacyDisplay(raw, oid) {
    if (raw === null || raw === undefined)
        return 'NULL';
    if (typeof raw !== 'string')
        return String(raw);
    const parsed = pgTypes.getTypeParser(oid, 'text')(raw);
    if (parsed === null || parsed === undefined)
        return 'NULL';
    if (parsed instanceof Date)
        return String(parsed);
    if (typeof parsed === 'object')
        return raw;
    return String(parsed);
}
const BUILTIN_NAMES = new Map(Object.entries(pgTypes.builtins).map(([name, oid]) => [oid, name.toLowerCase()]));
const registeredNames = new Map();
function builtinTypeName(oid) {
    return BUILTIN_NAMES.get(oid);
}
/** The type name for an OID: builtin, then registered (from pg_type), else the OID as a string. */
function typeName(oid) {
    return BUILTIN_NAMES.get(oid) ?? registeredNames.get(oid) ?? String(oid);
}
function registerTypeNames(names) {
    for (const [oid, name] of Object.entries(names))
        registeredNames.set(Number(oid), name);
}
/** OIDs with no known name yet (deduplicated). */
function unknownOids(oids) {
    return [...new Set(oids)].filter((oid) => !BUILTIN_NAMES.has(oid) && !registeredNames.has(oid));
}
function columnsFromFields(fields) {
    return fields.map((f) => ({ name: f.name, oid: f.dataTypeID, type: typeName(f.dataTypeID) }));
}
