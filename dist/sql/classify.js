"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmptySqlError = void 0;
exports.classifyStatement = classifyStatement;
exports.planScript = planScript;
/**
 * Statement classification (design Component 3).
 *
 * | First keyword                                         | Kind        |
 * |-------------------------------------------------------|-------------|
 * | select, with                                          | rows        |
 * | begin, start, commit, end, rollback, abort, and user  | transaction |
 * |   cursor statements (declare, fetch, move, close)     |             |
 * | set, reset, create temp/temporary                     | session     |
 * | anything else                                         | other       |
 */
const split_1 = require("./split");
const TRANSACTION_KEYWORDS = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort', 'declare', 'fetch', 'move', 'close']);
const SESSION_KEYWORDS = new Set(['set', 'reset']);
function leadingKeywords(text, count) {
    let rest = (0, split_1.stripLeadingNoise)(text);
    while (rest.startsWith('('))
        rest = (0, split_1.stripLeadingNoise)(rest.slice(1));
    const words = rest.match(/^[A-Za-z_]+(?:\s+[A-Za-z_]+){0,3}/);
    return words ? words[0].toLowerCase().split(/\s+/).slice(0, count) : [];
}
function classifyStatement(text) {
    const words = leadingKeywords(text, 4);
    const keyword = words[0] ?? '';
    let kind = 'other';
    let changesSession = false;
    if (keyword === 'select' || keyword === 'with') {
        kind = 'rows';
        changesSession = /\binto\s+(?:temp|temporary)\b/i.test(text);
    }
    else if (TRANSACTION_KEYWORDS.has(keyword)) {
        kind = 'transaction';
        changesSession = true;
    }
    else if (SESSION_KEYWORDS.has(keyword)) {
        kind = 'session';
        changesSession = true;
    }
    else if (keyword === 'create') {
        const second = words[1] === 'local' ? words[2] : words[1];
        if (second === 'temp' || second === 'temporary') {
            kind = 'session';
            changesSession = true;
        }
    }
    return { text, keyword, kind, changesSession };
}
class EmptySqlError extends Error {
    constructor() {
        super('No SQL statement to run: the text contains only comments or semicolons.');
        this.name = 'EmptySqlError';
    }
}
exports.EmptySqlError = EmptySqlError;
function planScript(sql) {
    const split = (0, split_1.splitStatements)(sql);
    const statements = split.complete
        ? split.statements.map(classifyStatement)
        : [classifyStatement(sql.trim())];
    const isScript = statements.length > 1;
    const hasTransactionControl = statements.some((s) => s.kind === 'transaction');
    const changesSession = isScript || statements.some((s) => s.changesSession);
    const last = statements.length ? statements[statements.length - 1] : null;
    return {
        statements,
        complete: split.complete,
        isScript,
        hasTransactionControl,
        changesSession,
        last,
        prefix: statements.slice(0, -1),
    };
}
