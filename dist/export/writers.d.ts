import { ColumnInfo } from '../results/values';
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
export declare function csvLine(row: unknown[], columns: ColumnInfo[]): string;
export declare function jsonlLine(row: unknown[], columns: ColumnInfo[]): string;
export declare class FileRowWriter implements RowWriter {
    private readonly stream;
    readonly format: ExportFormat;
    private columns;
    private chunk;
    private chunkChars;
    private written;
    private error;
    private closed;
    private constructor();
    static open(file: string, format: ExportFormat): Promise<FileRowWriter>;
    get bytes(): number;
    begin(columns: ColumnInfo[]): void;
    encode(row: unknown[]): string;
    writeLine(line: string): boolean;
    private flushChunk;
    drain(): Promise<void>;
    finish(): Promise<void>;
    destroy(): Promise<void>;
}
//# sourceMappingURL=writers.d.ts.map