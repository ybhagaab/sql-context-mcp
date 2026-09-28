"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileRowWriter = void 0;
exports.csvLine = csvLine;
exports.jsonlLine = jsonlLine;
const store_1 = require("../files/store");
const values_1 = require("../results/values");
const page_1 = require("../results/page");
function csvLine(row, columns) {
    let line = '';
    for (let i = 0; i < columns.length; i++) {
        if (i > 0)
            line += ',';
        const text = (0, values_1.toCsvText)(row[i], columns[i].oid);
        if (text !== null)
            line += (0, page_1.quoteCsv)(text);
    }
    return `${line}\n`;
}
function jsonlLine(row, columns) {
    const values = new Array(columns.length);
    for (let i = 0; i < columns.length; i++)
        values[i] = (0, values_1.toExact)(row[i], columns[i].oid);
    return `${JSON.stringify(values)}\n`;
}
const CHUNK_CHARS = 64 * 1024;
class FileRowWriter {
    constructor(stream, format) {
        this.stream = stream;
        this.format = format;
        this.columns = [];
        this.chunk = [];
        this.chunkChars = 0;
        this.written = 0;
        this.error = null;
        this.closed = false;
        stream.on('error', (err) => {
            this.error = err;
        });
    }
    static async open(file, format) {
        return new FileRowWriter(await (0, store_1.openPrivateWriteStream)(file), format);
    }
    get bytes() {
        return this.written;
    }
    begin(columns) {
        this.columns = columns;
        if (this.format === 'csv')
            this.writeLine(`${columns.map((c) => (0, page_1.quoteCsv)(c.name)).join(',')}\n`);
    }
    encode(row) {
        return this.format === 'csv' ? csvLine(row, this.columns) : jsonlLine(row, this.columns);
    }
    writeLine(line) {
        if (this.error)
            throw this.error;
        this.chunk.push(line);
        this.chunkChars += line.length;
        this.written += Buffer.byteLength(line);
        if (this.chunkChars < CHUNK_CHARS)
            return true;
        return this.flushChunk();
    }
    flushChunk() {
        if (this.chunk.length === 0)
            return !this.stream.writableNeedDrain;
        const data = this.chunk.join('');
        this.chunk = [];
        this.chunkChars = 0;
        return this.stream.write(data);
    }
    drain() {
        if (this.error)
            return Promise.reject(this.error);
        if (!this.stream.writableNeedDrain)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const onClose = () => {
                cleanup();
                if (this.error)
                    reject(this.error);
                else
                    resolve();
            };
            const cleanup = () => {
                this.stream.off('drain', onDrain);
                this.stream.off('error', onError);
                this.stream.off('close', onClose);
            };
            this.stream.on('drain', onDrain);
            this.stream.on('error', onError);
            this.stream.on('close', onClose);
        });
    }
    finish() {
        if (this.error)
            return Promise.reject(this.error);
        if (this.closed)
            return Promise.resolve();
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
    destroy() {
        this.chunk = [];
        this.chunkChars = 0;
        if (this.stream.destroyed)
            return Promise.resolve();
        this.closed = true;
        return new Promise((resolve) => {
            this.stream.once('close', () => resolve());
            this.stream.destroy();
        });
    }
}
exports.FileRowWriter = FileRowWriter;
