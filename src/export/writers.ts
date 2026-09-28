/**
 * Export file writers (design Component 9): CSV and JSONL with exact values and no sanitization.
 *
 * - csv:   RFC 4180, header row, LF line endings, the wire text of every value, booleans as
 *          true/false, NULL as an empty unquoted field, '' as "".
 * - jsonl: one JSON array of exact values per line (numbers for int2/int4/oid and finite floats,
 *          booleans, everything else as the database's text, null for NULL).
 *
 * Lines are buffered into 64 KB chunks before they are handed to the file stream. `writeLine`
 * returns false when the stream wants the caller to wait for `drain()`, which is how exports apply
 * backpressure to the database socket.
 */
import type { WriteStream } from 'fs';
import { openPrivateWriteStream } from '../files/store';
import { ColumnInfo, toCsvText, toExact } from '../results/values';
import { quoteCsv } from '../results/page';

export type ExportFormat = 'csv' | 'jsonl';

export interface RowWriter {
  /** Bytes accepted so far (header included). */
  readonly bytes: number;
  /** Starts the file for a result set: writes the CSV header. */
  begin(columns: ColumnInfo[]): void;
  /** The encoded line (with its newline) for a raw row. */
  encode(row: unknown[]): string;
  /** Appends an encoded line. Returns false when the caller should wait for drain(). */
  writeLine(line: string): boolean;
  drain(): Promise<void>;
  /** Flushes and closes the file. */
  finish(): Promise<void>;
  /** Closes the file without flushing (the caller deletes it). */
  destroy(): Promise<void>;
}

export function csvLine(row: unknown[], columns: ColumnInfo[]): string {
  let line = '';
  for (let i = 0; i < columns.length; i++) {
    if (i > 0) line += ',';
    const text = toCsvText(row[i], columns[i].oid);
    if (text !== null) line += quoteCsv(text);
  }
  return `${line}\n`;
}

export function jsonlLine(row: unknown[], columns: ColumnInfo[]): string {
  const values = new Array(columns.length);
  for (let i = 0; i < columns.length; i++) values[i] = toExact(row[i], columns[i].oid);
  return `${JSON.stringify(values)}\n`;
}

const CHUNK_CHARS = 64 * 1024;

export class FileRowWriter implements RowWriter {
  private columns: ColumnInfo[] = [];
  private chunk: string[] = [];
  private chunkChars = 0;
  private written = 0;
  private error: Error | null = null;
  private closed = false;

  private constructor(private readonly stream: WriteStream, readonly format: ExportFormat) {
    stream.on('error', (err) => {
      this.error = err;
    });
  }

  static async open(file: string, format: ExportFormat): Promise<FileRowWriter> {
    return new FileRowWriter(await openPrivateWriteStream(file), format);
  }

  get bytes(): number {
    return this.written;
  }

  begin(columns: ColumnInfo[]): void {
    this.columns = columns;
    if (this.format === 'csv') this.writeLine(`${columns.map((c) => quoteCsv(c.name)).join(',')}\n`);
  }

  encode(row: unknown[]): string {
    return this.format === 'csv' ? csvLine(row, this.columns) : jsonlLine(row, this.columns);
  }

  writeLine(line: string): boolean {
    if (this.error) throw this.error;
    this.chunk.push(line);
    this.chunkChars += line.length;
    this.written += Buffer.byteLength(line);
    if (this.chunkChars < CHUNK_CHARS) return true;
    return this.flushChunk();
  }

  private flushChunk(): boolean {
    if (this.chunk.length === 0) return !this.stream.writableNeedDrain;
    const data = this.chunk.join('');
    this.chunk = [];
    this.chunkChars = 0;
    return this.stream.write(data);
  }

  drain(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (!this.stream.writableNeedDrain) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        if (this.error) reject(this.error);
        else resolve();
      };
      const cleanup = (): void => {
        this.stream.off('drain', onDrain);
        this.stream.off('error', onError);
        this.stream.off('close', onClose);
      };
      this.stream.on('drain', onDrain);
      this.stream.on('error', onError);
      this.stream.on('close', onClose);
    });
  }

  finish(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const data = this.chunk.join('');
    this.chunk = [];
    this.chunkChars = 0;
    return new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.once('close', () => (this.error ? reject(this.error) : resolve()));
      this.stream.end(data);
    });
  }

  destroy(): Promise<void> {
    this.chunk = [];
    this.chunkChars = 0;
    if (this.stream.destroyed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => {
      this.stream.once('close', () => resolve());
      this.stream.destroy();
    });
  }
}
