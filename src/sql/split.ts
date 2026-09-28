/**
 * SQL statement splitter (design Component 3).
 *
 * A single pass that splits on `;` only in normal text. It understands single-quoted strings
 * (with `''` and backslash escapes, matching Redshift), double-quoted identifiers (with `""`),
 * line comments, nested block comments, and dollar-quoted bodies (`$tag$ … $tag$`). Empty and
 * comment-only statements are dropped. `complete: false` means the text ended inside a quote or
 * comment; callers then run the whole text as written and let the database report any error.
 *
 * The splitter only routes execution. It never authorizes SQL.
 */

export interface SplitResult {
  statements: string[];
  complete: boolean;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Returns `stmt` with leading whitespace and comments removed. */
export function stripLeadingNoise(stmt: string): string {
  let i = 0;
  while (i < stmt.length) {
    const ch = stmt[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (stmt.startsWith('--', i)) {
      const nl = stmt.indexOf('\n', i);
      i = nl === -1 ? stmt.length : nl + 1;
      continue;
    }
    if (stmt.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < stmt.length && depth > 0) {
        if (stmt.startsWith('/*', i)) { depth++; i += 2; }
        else if (stmt.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    break;
  }
  return stmt.slice(i);
}

/** True if the statement contains anything other than whitespace and comments. */
function hasContent(stmt: string): boolean {
  return stripLeadingNoise(stmt).length > 0;
}

export function splitStatements(sql: string): SplitResult {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  const push = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (text && hasContent(text)) statements.push(text);
  };

  while (i < n) {
    const ch = sql[i];

    // Line comment.
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    // Block comment (nested).
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) return { statements: [], complete: false };
      continue;
    }

    // Single-quoted string: '' and backslash escapes.
    if (ch === "'") {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { statements: [], complete: false };
      continue;
    }

    // Double-quoted identifier: "" escapes.
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { statements: [], complete: false };
      continue;
    }

    // Dollar-quoted body. `$1` placeholders and identifiers containing `$` are not quotes.
    if (ch === '$' && (i === 0 || !IDENT_CHAR.test(sql[i - 1]))) {
      const match = DOLLAR_TAG.exec(sql.slice(i, i + 66));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) return { statements: [], complete: false };
        i = close + tag.length;
        continue;
      }
    }

    if (ch === ';') {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(n);
  return { statements, complete: true };
}
