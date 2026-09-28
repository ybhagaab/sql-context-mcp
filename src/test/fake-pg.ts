/**
 * In-memory stand-in for the `pg` module, used by tests via:
 *
 *   vi.mock('pg', async () => (await import('./test/fake-pg')).fakePgModule);
 *   import { fakeDb } from './test/fake-pg';
 *
 * It emulates the parts of node-postgres (and of Redshift/PostgreSQL behavior) that the server
 * relies on: pooled connections, promise and streaming (`Query` + row events) queries,
 * `rowMode: 'array'` and per-query `types`, transactions, DECLARE/FETCH/MOVE/CLOSE cursors,
 * `stv_active_cursors` totals, `select version()`, `stv_slices`, `pg_type` lookups,
 * `readyForQuery` transaction-status events, socket pause/resume backpressure, protocol and SQL
 * cancellation, execution delays, and injected faults. Real `pg-types` parsers are used so value
 * conversion matches production.
 */
import { EventEmitter } from 'events';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgTypes = require('pg-types');

export interface FakeColumn { name: string; oid: number }
export type FakeCell = string | null;

export interface FakeResultDef {
  /** Present for row-returning statements. */
  columns?: FakeColumn[];
  /** Rows as wire text, or a factory yielding rows lazily (for very large results). */
  rows?: FakeCell[][] | (() => Iterable<FakeCell[]>);
  /** Row count for lazy row factories, or rows affected for statements without rows. */
  rowCount?: number;
  /** Materialized size reported by stv_active_cursors (defaults to the JSON size of the rows). */
  byteCount?: number;
  /** Command tag (defaults to SELECT for rows, else the upper-cased first keyword). */
  command?: string;
  /** Execution delay before the first row / completion, in ms. */
  delayMs?: number;
  /** Extra delay for every FETCH from a cursor over this statement, in ms (cancellable). */
  fetchDelayMs?: number;
  /** Error raised when the statement executes. */
  error?: Error;
  /** DECLARE ... CURSOR FOR this statement is rejected (like SELECT ... INTO). */
  rejectDeclare?: boolean;
}

interface Fault { match: string | RegExp; error: Error; remaining: number }

export function dbError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

export function connectionError(message = 'Connection terminated unexpectedly'): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ECONNRESET' });
}

function cancelError(): Error {
  return dbError('57014', 'canceling statement due to user request');
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;+\s*$/, '').trim();
}

/** Minimal statement splitter for the fake (respects single quotes and $$ bodies). */
export function fakeSplit(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let inDollar = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inQuote && text.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i++;
      continue;
    }
    if (!inDollar && ch === "'") inQuote = !inQuote;
    if (ch === ';' && !inQuote && !inDollar) {
      if (cur.trim()) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function* iterateRows(def: FakeResultDef): Generator<FakeCell[]> {
  if (!def.rows) return;
  const source = typeof def.rows === 'function' ? def.rows() : def.rows;
  for (const row of source) yield row;
}

function totalRowsOf(def: FakeResultDef): number {
  if (typeof def.rows === 'function') return def.rowCount ?? 0;
  return def.rows ? def.rows.length : 0;
}

function totalBytesOf(def: FakeResultDef): number {
  if (def.byteCount !== undefined) return def.byteCount;
  if (Array.isArray(def.rows)) return def.rows.reduce((sum, r) => sum + JSON.stringify(r).length, 0);
  return totalRowsOf(def) * 32;
}

interface ExecConfig { text: string; values?: unknown[]; rowMode?: string; types?: { getTypeParser: (oid: number, format?: string) => (v: string) => unknown } }

function parserFor(oid: number, cfg: ExecConfig): (v: string) => unknown {
  return cfg.types ? cfg.types.getTypeParser(oid, 'text') : pgTypes.getTypeParser(oid, 'text');
}

function formatRow(raw: FakeCell[], columns: FakeColumn[], cfg: ExecConfig): unknown {
  const parsed = raw.map((cell, i) => (cell === null ? null : parserFor(columns[i].oid, cfg)(cell)));
  if (cfg.rowMode === 'array') return parsed;
  const obj: Record<string, unknown> = {};
  columns.forEach((c, i) => { obj[c.name] = parsed[i]; });
  return obj;
}

function fieldsOf(columns: FakeColumn[]): Array<{ name: string; dataTypeID: number; format: string }> {
  return columns.map((c) => ({ name: c.name, dataTypeID: c.oid, format: 'text' }));
}

interface FakeResult {
  command: string;
  rowCount: number | null;
  fields: Array<{ name: string; dataTypeID: number; format: string }>;
  rows: unknown[];
}

interface FakeCursor {
  name: string;
  def: FakeResultDef;
  iterator: Generator<FakeCell[]>;
  position: number;
  executed: boolean;
  scroll: boolean;
  exhausted: boolean;
}

export class FakeDb {
  results = new Map<string, FakeResultDef>();
  engine: 'redshift' | 'postgres' = 'redshift';
  nodes = 12;
  stvAllowed = true;
  typeNames: Record<number, string> = { 4000: 'super', 3000: 'geometry' };
  log: string[] = [];
  faults: Fault[] = [];
  clients: FakeClient[] = [];
  pools: FakePool[] = [];
  cancelRequests: Array<{ pid: number; via: 'protocol' | 'sql' }> = [];
  /** When false, protocol-level cancel requests are ignored (to exercise the SQL fallback). */
  protocolCancelWorks = true;

  define(sql: string, def: FakeResultDef): void {
    this.results.set(normalizeSql(sql), def);
  }

  resolve(sql: string): FakeResultDef | undefined {
    return this.results.get(normalizeSql(sql));
  }

  failWhen(match: string | RegExp, error: Error, times = 1): void {
    this.faults.push({ match, error, remaining: times });
  }

  takeFault(statement: string): Error | null {
    const norm = normalizeSql(statement).toLowerCase();
    for (const fault of this.faults) {
      if (fault.remaining <= 0) continue;
      const hit = typeof fault.match === 'string' ? norm.includes(fault.match.toLowerCase()) : fault.match.test(statement);
      if (hit) {
        fault.remaining--;
        return fault.error;
      }
    }
    return null;
  }

  openCursors(): number {
    return this.clients.filter((c) => c.cursor !== null && !c.destroyed).length;
  }

  statementsMatching(pattern: RegExp): string[] {
    return this.log.filter((s) => pattern.test(s));
  }

  /** Pooled idle clients that were returned while still inside a transaction (a hygiene bug). */
  leakedTransactions(): FakeClient[] {
    return this.pools.flatMap((p) => p.idle.filter((c) => c.inTx));
  }

  /** Pooled idle clients that carry session settings from an earlier SET (a hygiene bug). */
  leakedSessionState(): FakeClient[] {
    return this.pools.flatMap((p) => p.idle.filter((c) => Object.keys(c.sessionSettings).length > 0));
  }

  reset(): void {
    this.results.clear();
    this.engine = 'redshift';
    this.nodes = 12;
    this.stvAllowed = true;
    this.typeNames = { 4000: 'super', 3000: 'geometry' };
    this.log = [];
    this.faults = [];
    this.clients = [];
    this.pools = [];
    this.cancelRequests = [];
    this.protocolCancelWorks = true;
  }
}

export const fakeDb = new FakeDb();

class FakeStream extends EventEmitter {
  paused = false;
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.emit('resume'); }
}

class FakeConnection extends EventEmitter {
  stream = new FakeStream();
}

export class FakeQuery extends EventEmitter {
  text: string;
  values?: unknown[];
  rowMode?: string;
  types?: ExecConfig['types'];
  constructor(config: string | ExecConfig, values?: unknown[]) {
    super();
    const cfg = typeof config === 'string' ? { text: config, values } : config;
    this.text = cfg.text;
    this.values = cfg.values;
    this.rowMode = cfg.rowMode;
    this.types = cfg.types;
  }
}

let nextPid = 5000;

export class FakeClient extends EventEmitter {
  processID: number;
  secretKey = 7;
  connection = new FakeConnection();
  config: unknown;
  inTx = false;
  txFailed = false;
  cursor: FakeCursor | null = null;
  pool: FakePool | null = null;
  destroyed = false;
  broken = false;
  checkedOut = false;
  sessionSettings: Record<string, string> = {};
  queryCount = 0;
  private activeToken: object | null = null;
  private cancelHook: (() => void) | null = null;
  private pendingCancel = false;

  constructor(config?: unknown) {
    super();
    this.config = config;
    this.processID = nextPid++;
    fakeDb.clients.push(this);
  }

  get activeQuery(): object | null {
    return this.activeToken;
  }

  async connect(): Promise<void> {
    const fault = fakeDb.takeFault('connect');
    if (fault) throw fault;
  }

  async end(): Promise<void> {
    this.destroyed = true;
  }

  release(destroy?: unknown): void {
    if (this.pool) this.pool._release(this, Boolean(destroy));
  }

  /** Protocol-level CancelRequest: `new Client(cfg).cancel(target, target.activeQuery)`. */
  cancel(target: FakeClient, _query: unknown): void {
    fakeDb.cancelRequests.push({ pid: target.processID, via: 'protocol' });
    if (fakeDb.protocolCancelWorks) target._cancelActive();
  }

  _cancelActive(): void {
    if (this.cancelHook) {
      const hook = this.cancelHook;
      this.cancelHook = null;
      hook();
    } else if (this.activeToken) {
      this.pendingCancel = true;
    }
  }

  query(arg: unknown, values?: unknown, callback?: unknown): unknown {
    void callback;
    if (arg instanceof FakeQuery) {
      void this.runStreaming(arg);
      return arg;
    }
    const cfg: ExecConfig = typeof arg === 'string'
      ? { text: arg, values: values as unknown[] | undefined }
      : { ...(arg as ExecConfig), values: (arg as ExecConfig).values ?? (values as unknown[] | undefined) };
    return this.runPromise(cfg);
  }

  private emitReady(): void {
    const status = this.inTx ? (this.txFailed ? 'E' : 'T') : 'I';
    this.connection.emit('readyForQuery', { name: 'readyForQuery', status });
  }

  private delay(ms: number): Promise<void> {
    if (this.pendingCancel) {
      this.pendingCancel = false;
      return Promise.reject(cancelError());
    }
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelHook = null;
        resolve();
      }, ms);
      this.cancelHook = () => {
        clearTimeout(timer);
        reject(cancelError());
      };
    });
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.connection.stream.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onResume = () => {
        this.cancelHook = null;
        resolve();
      };
      this.connection.stream.once('resume', onResume);
      this.cancelHook = () => {
        this.connection.stream.off('resume', onResume);
        reject(cancelError());
      };
    });
  }

  private checkCancelled(): void {
    if (this.pendingCancel) {
      this.pendingCancel = false;
      throw cancelError();
    }
  }

  private async runPromise(cfg: ExecConfig): Promise<unknown> {
    if (this.broken || this.destroyed) {
      throw Object.assign(new Error('Client has encountered a connection error and is not queryable'), { code: undefined });
    }
    this.activeToken = {};
    this.queryCount++;
    try {
      const statements = cfg.values && cfg.values.length ? [cfg.text] : fakeSplit(cfg.text);
      const results: FakeResult[] = [];
      for (const stmt of statements) results.push(await this.execOne(stmt, cfg));
      return results.length === 1 ? results[0] : results;
    } finally {
      this.activeToken = null;
      this.pendingCancel = false;
      this.emitReady();
    }
  }

  private async runStreaming(q: FakeQuery): Promise<void> {
    if (this.broken || this.destroyed) {
      setImmediate(() => q.emit('error', new Error('Client has encountered a connection error and is not queryable')));
      return;
    }
    this.activeToken = q;
    this.queryCount++;
    const cfg: ExecConfig = { text: q.text, values: q.values, rowMode: q.rowMode, types: q.types };
    const results: Array<FakeResult & { fields: FakeResult['fields'] }> = [];
    try {
      await Promise.resolve();
      const statements = fakeSplit(q.text);
      for (const stmt of statements) {
        const def = this.userDef(stmt);
        if (!def || !def.columns) {
          results.push(await this.execOne(stmt, cfg));
          continue;
        }
        fakeDb.log.push(normalizeSql(stmt));
        const fault = fakeDb.takeFault(stmt);
        if (fault) throw this.applyFault(fault);
        if (def.error) throw def.error;
        await this.delay(def.delayMs ?? 0);
        const result = { command: def.command ?? 'SELECT', rowCount: null as number | null, fields: fieldsOf(def.columns), rows: [] as unknown[] };
        results.push(result);
        let n = 0;
        for (const raw of iterateRows(def)) {
          this.checkCancelled();
          await this.waitWhilePaused();
          q.emit('row', formatRow(raw, def.columns, cfg), result);
          n++;
          if (n % 256 === 0) await new Promise((r) => setImmediate(r));
          const midFault = fakeDb.takeFault(`__row_${n}__ ${stmt}`);
          if (midFault) throw this.applyFault(midFault);
        }
        result.rowCount = fakeDb.engine === 'redshift' ? null : n;
      }
      this.activeToken = null;
      this.pendingCancel = false;
      this.emitReady();
      q.emit('end', results.length === 1 ? results[0] : results);
    } catch (err) {
      if (this.inTx) this.txFailed = true;
      this.activeToken = null;
      this.pendingCancel = false;
      this.emitReady();
      q.emit('error', err);
    }
  }

  private applyFault(fault: Error): Error {
    if ((fault as { code?: string }).code === 'ECONNRESET' || /terminated/i.test(fault.message)) this.broken = true;
    return fault;
  }

  private userDef(stmt: string): FakeResultDef | undefined {
    return fakeDb.resolve(stmt);
  }

  private async execOne(stmt: string, cfg: ExecConfig): Promise<FakeResult> {
    const norm = normalizeSql(stmt);
    fakeDb.log.push(norm);
    const fault = fakeDb.takeFault(stmt);
    if (fault) {
      if (this.inTx) this.txFailed = true;
      throw this.applyFault(fault);
    }
    const lower = norm.toLowerCase();
    const isTxEnd = /^(end|commit|rollback|abort)\b/.test(lower);
    if (this.inTx && this.txFailed && !isTxEnd) {
      throw dbError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    }
    try {
      return await this.dispatch(norm, lower, cfg);
    } catch (err) {
      if (this.inTx && !isTxEnd) this.txFailed = true;
      throw err;
    }
  }

  private async dispatch(norm: string, lower: string, cfg: ExecConfig): Promise<FakeResult> {
    const none = (command: string, rowCount: number | null = null): FakeResult => ({ command, rowCount, fields: [], rows: [] });
    const rowsResult = (columns: FakeColumn[], raw: FakeCell[][], command = 'SELECT'): FakeResult => ({
      command,
      rowCount: fakeDb.engine === 'redshift' && command === 'SELECT' ? null : raw.length,
      fields: fieldsOf(columns),
      rows: raw.map((r) => formatRow(r, columns, cfg)),
    });

    if (/^(begin|start transaction)\b/.test(lower)) { this.inTx = true; this.txFailed = false; return none('BEGIN'); }
    if (/^(end|commit)\b/.test(lower)) { this.inTx = false; this.txFailed = false; this.cursor = null; return none('COMMIT'); }
    if (/^(rollback|abort)\b/.test(lower)) { this.inTx = false; this.txFailed = false; this.cursor = null; return none('ROLLBACK'); }

    const declare = /^declare (\w+) (scroll )?cursor for ([\s\S]+)$/i.exec(norm);
    if (declare) {
      if (!this.inTx) throw dbError('25P01', 'DECLARE CURSOR can only be used in transaction blocks');
      if (this.cursor) throw dbError('42P03', 'cursor already open in this session');
      const def = fakeDb.resolve(declare[3]);
      if (!def) throw dbError('42P01', `relation does not exist for: ${declare[3].slice(0, 60)}`);
      if (def.rejectDeclare) throw dbError('0A000', 'this statement cannot be used in a cursor');
      if (!def.columns) throw dbError('42601', 'cursor query must return rows');
      this.cursor = { name: declare[1], def, iterator: iterateRows(def), position: 0, executed: false, scroll: Boolean(declare[2]), exhausted: false };
      return none('DECLARE CURSOR');
    }

    const fetch = /^fetch forward (\d+|all) from (\w+)$/i.exec(norm);
    if (fetch) {
      const cur = this.requireCursor(fetch[2]);
      await this.executeCursor(cur);
      if (cur.def.fetchDelayMs) await this.delay(cur.def.fetchDelayMs);
      const want = fetch[1].toLowerCase() === 'all' ? Infinity : parseInt(fetch[1], 10);
      if (fakeDb.engine === 'redshift' && fakeDb.nodes === 1 && want > 1000) throw dbError('0A000', 'FETCH count must be at most 1000 on single-node clusters');
      const out: FakeCell[][] = [];
      while (out.length < want) {
        const next = cur.iterator.next();
        if (next.done) { cur.exhausted = true; break; }
        out.push(next.value);
      }
      cur.position += out.length;
      return rowsResult(cur.def.columns as FakeColumn[], out, 'FETCH');
    }

    const moveAll = /^move forward all in (\w+)$/i.exec(norm);
    if (moveAll) {
      const cur = this.requireCursor(moveAll[1]);
      if (!cur.scroll && fakeDb.engine === 'redshift') throw dbError('42601', 'MOVE is not supported');
      await this.executeCursor(cur);
      let n = 0;
      while (!cur.iterator.next().done) n++;
      cur.position += n;
      cur.exhausted = true;
      return none('MOVE', n);
    }

    const moveAbs = /^move absolute (\d+) in (\w+)$/i.exec(norm);
    if (moveAbs) {
      const cur = this.requireCursor(moveAbs[2]);
      if (!cur.scroll) throw dbError('55000', 'cursor can only scan forward');
      const k = parseInt(moveAbs[1], 10);
      cur.iterator = iterateRows(cur.def);
      for (let i = 0; i < k; i++) if (cur.iterator.next().done) break;
      cur.position = k;
      cur.exhausted = false;
      return none('MOVE', 1);
    }

    const close = /^close (\w+)$/i.exec(norm);
    if (close) { this.cursor = null; return none('CLOSE CURSOR'); }

    if (lower === 'select version()') {
      const text = fakeDb.engine === 'redshift'
        ? 'PostgreSQL 8.0.2 on i686-pc-linux-gnu, compiled by GCC gcc (GCC) 3.4.2 20041017 (Red Hat 3.4.2-6.fc3), Redshift 1.0.99999'
        : 'PostgreSQL 16.1 on x86_64-pc-linux-gnu';
      return rowsResult([{ name: 'version', oid: 25 }], [[text]]);
    }
    if (lower === 'select count(distinct node) as nodes from stv_slices') {
      if (fakeDb.engine !== 'redshift') throw dbError('42P01', 'relation "stv_slices" does not exist');
      return rowsResult([{ name: 'nodes', oid: 20 }], [[String(fakeDb.nodes)]]);
    }
    if (lower === 'select 1 from stv_active_cursors limit 0') {
      if (fakeDb.engine !== 'redshift') throw dbError('42P01', 'relation "stv_active_cursors" does not exist');
      if (!fakeDb.stvAllowed) throw dbError('42501', 'permission denied for relation stv_active_cursors');
      return rowsResult([{ name: '?column?', oid: 23 }], []);
    }
    if (lower === 'select row_count, byte_count from stv_active_cursors where pid = pg_backend_pid()') {
      if (fakeDb.engine !== 'redshift') throw dbError('42P01', 'relation "stv_active_cursors" does not exist');
      if (!fakeDb.stvAllowed) throw dbError('42501', 'permission denied for relation stv_active_cursors');
      if (!this.cursor || !this.cursor.executed) return rowsResult([{ name: 'row_count', oid: 20 }, { name: 'byte_count', oid: 20 }], []);
      return rowsResult(
        [{ name: 'row_count', oid: 20 }, { name: 'byte_count', oid: 20 }],
        [[String(totalRowsOf(this.cursor.def)), String(totalBytesOf(this.cursor.def))]],
      );
    }
    if (lower === 'select pg_cancel_backend($1)') {
      const pid = Number(cfg.values?.[0]);
      fakeDb.cancelRequests.push({ pid, via: 'sql' });
      const target = fakeDb.clients.find((c) => c.processID === pid);
      target?._cancelActive();
      return rowsResult([{ name: 'pg_cancel_backend', oid: 16 }], [[target ? 't' : 'f']]);
    }
    const typeLookup = /^select oid, typname from pg_type where oid in \(([\d, ]+)\)$/i.exec(norm);
    if (typeLookup) {
      const oids = typeLookup[1].split(',').map((s) => parseInt(s.trim(), 10));
      const rows = oids.filter((o) => fakeDb.typeNames[o]).map((o) => [String(o), fakeDb.typeNames[o]]);
      return rowsResult([{ name: 'oid', oid: 26 }, { name: 'typname', oid: 19 }], rows);
    }
    if (lower === 'select 1') return rowsResult([{ name: '?column?', oid: 23 }], [['1']]);
    if (/^set\b/.test(lower)) {
      const m = /^set (\w+) (?:to|=) (.+)$/i.exec(norm);
      if (m) this.sessionSettings[m[1].toLowerCase()] = m[2];
      return none('SET');
    }
    if (/^reset\b/.test(lower)) return none('RESET');

    const def = fakeDb.resolve(norm);
    if (!def) throw dbError('42P01', `relation does not exist for: ${norm.slice(0, 80)}`);
    if (def.error) throw def.error;
    await this.delay(def.delayMs ?? 0);
    if (def.columns) {
      const raw = Array.from(iterateRows(def));
      return rowsResult(def.columns, raw, def.command ?? 'SELECT');
    }
    const command = def.command ?? lower.split(/\s+/)[0].toUpperCase();
    return none(command, def.rowCount ?? 0);
  }

  private requireCursor(name: string): FakeCursor {
    if (!this.cursor || this.cursor.name !== name) throw dbError('34000', `cursor "${name}" does not exist`);
    return this.cursor;
  }

  private async executeCursor(cur: FakeCursor): Promise<void> {
    if (cur.executed) return;
    await this.delay(cur.def.delayMs ?? 0);
    if (cur.def.error) throw cur.def.error;
    cur.executed = true;
  }
}

export class FakePool extends EventEmitter {
  options: { max: number; [key: string]: unknown };
  all: FakeClient[] = [];
  idle: FakeClient[] = [];
  waiters: Array<{ resolve: (c: FakeClient) => void; reject: (e: Error) => void }> = [];
  ended = false;
  endCalls = 0;

  constructor(options?: Record<string, unknown>) {
    super();
    this.options = { max: 10, ...(options ?? {}) } as FakePool['options'];
    fakeDb.pools.push(this);
  }

  get totalCount(): number { return this.all.length; }
  get idleCount(): number { return this.idle.length; }
  get waitingCount(): number { return this.waiters.length; }
  get checkedOutCount(): number { return this.all.filter((c) => c.checkedOut).length; }

  async connect(): Promise<FakeClient> {
    if (this.ended) throw new Error('Cannot use a pool after calling end on the pool');
    const fault = fakeDb.takeFault('connect');
    if (fault) throw fault;
    const idle = this.idle.pop();
    if (idle) {
      idle.checkedOut = true;
      return idle;
    }
    if (this.all.length < this.options.max) return this.newClient();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private newClient(): FakeClient {
    const client = new FakeClient(this.options);
    client.pool = this;
    client.checkedOut = true;
    this.all.push(client);
    return client;
  }

  async query(arg: unknown, values?: unknown): Promise<unknown> {
    const client = await this.connect();
    try {
      const result = await client.query(arg, values);
      client.release();
      return result;
    } catch (err) {
      client.release(err);
      throw err;
    }
  }

  _release(client: FakeClient, destroy: boolean): void {
    client.checkedOut = false;
    // Like pg-pool, a client released without `destroy` goes back to the pool even if it is still
    // inside a transaction; tests detect such leaks with `fakeDb.leakedTransactions()`.
    if (destroy || client.broken || this.ended) {
      this.all = this.all.filter((c) => c !== client);
      client.destroyed = true;
      client.cursor = null;
      const waiter = this.waiters.shift();
      if (waiter && !this.ended) waiter.resolve(this.newClient());
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      client.checkedOut = true;
      waiter.resolve(client);
      return;
    }
    this.idle.push(client);
  }

  async end(): Promise<void> {
    this.endCalls++;
    if (this.ended) throw new Error('Called end on pool more than once');
    this.ended = true;
    for (const c of this.idle) c.destroyed = true;
    this.idle = [];
    for (const w of this.waiters) w.reject(new Error('Cannot use a pool after calling end on the pool'));
    this.waiters = [];
  }
}

export const fakePgModule = {
  Pool: FakePool,
  Client: FakeClient,
  Query: FakeQuery,
  types: pgTypes,
  default: { Pool: FakePool, Client: FakeClient, Query: FakeQuery, types: pgTypes },
};
