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

import * as fs from 'fs';
import * as path from 'path';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

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

// Cache for custom presets
let customPresetsCache: Record<string, SchemaPreset> | null = null;
let presetsInitialized = false;

/**
 * Initialize and load all presets (async)
 */
async function initializePresets(): Promise<Record<string, SchemaPreset>> {
  if (presetsInitialized && customPresetsCache !== null) {
    return customPresetsCache;
  }

  customPresetsCache = {};

  // Load from local directory
  const contextDir = process.env.SQL_CONTEXT_DIR;
  if (contextDir && fs.existsSync(contextDir)) {
    await loadFromLocalDir(contextDir);
  }

  // Load from single local file
  const contextFile = process.env.SQL_CONTEXT_FILE;
  if (contextFile && fs.existsSync(contextFile)) {
    const preset = loadPresetFromFile(contextFile);
    if (preset) {
      const name = path.basename(contextFile, path.extname(contextFile)).toLowerCase();
      customPresetsCache[name] = preset;
    }
  }

  // Load from S3
  const s3Uri = process.env.SQL_CONTEXT_S3;
  if (s3Uri) {
    await loadFromS3(s3Uri);
  }

  // Load from HTTP URL
  const httpUrl = process.env.SQL_CONTEXT_URL;
  if (httpUrl) {
    await loadFromUrl(httpUrl);
  }

  presetsInitialized = true;
  return customPresetsCache;
}

/**
 * Load presets from local directory
 */
async function loadFromLocalDir(contextDir: string): Promise<void> {
  try {
    const files = fs.readdirSync(contextDir);
    for (const file of files) {
      if (file.endsWith('.md') || file.endsWith('.json')) {
        const filePath = path.join(contextDir, file);
        const preset = loadPresetFromFile(filePath);
        if (preset) {
          const name = path.basename(file, path.extname(file)).toLowerCase();
          customPresetsCache![name] = preset;
        }
      }
    }
  } catch (error) {
    console.error(`Error loading context directory: ${error}`);
  }
}

/**
 * Load presets from S3 bucket/prefix
 * Format: s3://bucket-name/optional/prefix/
 */
async function loadFromS3(s3Uri: string): Promise<void> {
  try {
    const match = s3Uri.match(/^s3:\/\/([^\/]+)\/?(.*)$/);
    if (!match) {
      console.error(`Invalid S3 URI format: ${s3Uri}`);
      return;
    }

    const bucket = match[1];
    const prefix = match[2] || '';
    const region = process.env.SQL_AWS_REGION || 'us-east-1';

    const s3Client = new S3Client({ region });

    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    });

    const listResponse = await s3Client.send(listCommand);
    const objects = listResponse.Contents || [];

    for (const obj of objects) {
      const key = obj.Key;
      if (!key) continue;

      if (!key.endsWith('.md') && !key.endsWith('.json')) continue;

      const getCommand = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const getResponse = await s3Client.send(getCommand);
      const content = await getResponse.Body?.transformToString();

      if (content) {
        const preset = parsePresetContent(content, key);
        if (preset) {
          const name = path.basename(key, path.extname(key)).toLowerCase();
          customPresetsCache![name] = preset;
        }
      }
    }

    console.error(`Loaded ${Object.keys(customPresetsCache!).length} presets from S3: ${s3Uri}`);
  } catch (error) {
    console.error(`Error loading from S3: ${error}`);
  }
}

/**
 * Load a single preset from HTTP/HTTPS URL
 */
async function loadFromUrl(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch URL ${url}: ${response.status}`);
      return;
    }

    const content = await response.text();
    const preset = parsePresetContent(content, url);

    if (preset) {
      const urlPath = new URL(url).pathname;
      const name = path.basename(urlPath, path.extname(urlPath)).toLowerCase();
      customPresetsCache![name] = preset;
      console.error(`Loaded preset '${name}' from URL: ${url}`);
    }
  } catch (error) {
    console.error(`Error loading from URL: ${error}`);
  }
}

/**
 * Parse preset content based on file extension
 */
function parsePresetContent(content: string, filename: string): SchemaPreset | null {
  try {
    const ext = path.extname(filename).toLowerCase();
    const name = path.basename(filename, ext);

    if (ext === '.json') {
      const data = JSON.parse(content);
      return {
        name: data.name || name,
        description: data.description || `Custom context from ${name}`,
        context: data.context || '',
        tables: data.tables || [],
      };
    } else if (ext === '.md') {
      const lines = content.split('\n');
      let description = `Custom context from ${name}`;
      if (lines[0]?.startsWith('# ')) {
        description = lines[0].substring(2).trim();
      }
      return { name, description, context: content, tables: [] };
    }
  } catch (error) {
    console.error(`Error parsing preset from ${filename}: ${error}`);
  }
  return null;
}

/**
 * Load a preset from a local file (supports .md and .json)
 */
function loadPresetFromFile(filePath: string): SchemaPreset | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parsePresetContent(content, filePath);
  } catch (error) {
    console.error(`Error loading preset from ${filePath}: ${error}`);
  }
  return null;
}

/**
 * Synchronous wrapper for backward compatibility
 */
function loadCustomPresets(): Record<string, SchemaPreset> {
  if (customPresetsCache !== null) {
    return customPresetsCache;
  }

  customPresetsCache = {};

  const contextDir = process.env.SQL_CONTEXT_DIR;
  if (contextDir && fs.existsSync(contextDir)) {
    try {
      const files = fs.readdirSync(contextDir);
      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.json')) {
          const filePath = path.join(contextDir, file);
          const preset = loadPresetFromFile(filePath);
          if (preset) {
            const name = path.basename(file, path.extname(file)).toLowerCase();
            customPresetsCache[name] = preset;
          }
        }
      }
    } catch (error) {
      console.error(`Error loading context directory: ${error}`);
    }
  }

  const contextFile = process.env.SQL_CONTEXT_FILE;
  if (contextFile && fs.existsSync(contextFile)) {
    const preset = loadPresetFromFile(contextFile);
    if (preset) {
      const name = path.basename(contextFile, path.extname(contextFile)).toLowerCase();
      customPresetsCache[name] = preset;
    }
  }

  // Trigger async loading in background
  initializePresets().catch(err => console.error('Error initializing presets:', err));

  return customPresetsCache;
}

export function listPresets(): string[] {
  return Object.keys(loadCustomPresets());
}

export async function listPresetsAsync(): Promise<string[]> {
  const presets = await initializePresets();
  return Object.keys(presets);
}

export function getPreset(name: string): SchemaPreset | undefined {
  return loadCustomPresets()[name.toLowerCase()];
}

export async function getPresetAsync(name: string): Promise<SchemaPreset | undefined> {
  const presets = await initializePresets();
  return presets[name.toLowerCase()];
}

export function reloadCustomPresets(): void {
  customPresetsCache = null;
  presetsInitialized = false;
}
