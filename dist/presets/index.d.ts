/**
 * Schema Context Presets
 *
 * Loads custom user-provided context files for schema knowledge.
 *
 * Supported sources:
 * - SQL_CONTEXT_DIR: Local directory containing .md or .json files
 * - SQL_CONTEXT_FILE: Single local file path
 * - SQL_CONTEXT_S3: S3 URI (s3://bucket/prefix/) - loads all .md/.json files
 * - SQL_CONTEXT_URL: HTTP/HTTPS URL to a single context file
 */
export interface SchemaPreset {
    name: string;
    description: string;
    context: string;
    tables: Array<{
        name: string;
        description: string;
        key_columns: string[];
    }>;
}
export declare function listPresets(): string[];
export declare function listPresetsAsync(): Promise<string[]>;
export declare function getPreset(name: string): SchemaPreset | undefined;
export declare function getPresetAsync(name: string): Promise<SchemaPreset | undefined>;
export declare function reloadCustomPresets(): void;
//# sourceMappingURL=index.d.ts.map