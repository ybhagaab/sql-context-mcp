"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPresets = listPresets;
exports.listPresetsAsync = listPresetsAsync;
exports.getPreset = getPreset;
exports.getPresetAsync = getPresetAsync;
exports.reloadCustomPresets = reloadCustomPresets;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const client_s3_1 = require("@aws-sdk/client-s3");
// Cache for custom presets
let customPresetsCache = null;
let presetsInitialized = false;
/**
 * Initialize and load all presets (async)
 */
async function initializePresets() {
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
async function loadFromLocalDir(contextDir) {
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
    }
    catch (error) {
        console.error(`Error loading context directory: ${error}`);
    }
}
/**
 * Load presets from S3 bucket/prefix
 * Format: s3://bucket-name/optional/prefix/
 */
async function loadFromS3(s3Uri) {
    try {
        const match = s3Uri.match(/^s3:\/\/([^\/]+)\/?(.*)$/);
        if (!match) {
            console.error(`Invalid S3 URI format: ${s3Uri}`);
            return;
        }
        const bucket = match[1];
        const prefix = match[2] || '';
        const region = process.env.SQL_AWS_REGION || 'us-east-1';
        const s3Client = new client_s3_1.S3Client({ region });
        const listCommand = new client_s3_1.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
        });
        const listResponse = await s3Client.send(listCommand);
        const objects = listResponse.Contents || [];
        for (const obj of objects) {
            const key = obj.Key;
            if (!key)
                continue;
            if (!key.endsWith('.md') && !key.endsWith('.json'))
                continue;
            const getCommand = new client_s3_1.GetObjectCommand({
                Bucket: bucket,
                Key: key,
            });
            const getResponse = await s3Client.send(getCommand);
            const content = await getResponse.Body?.transformToString();
            if (content) {
                const preset = parsePresetContent(content, key);
                if (preset) {
                    const name = path.basename(key, path.extname(key)).toLowerCase();
                    customPresetsCache[name] = preset;
                }
            }
        }
        console.error(`Loaded ${Object.keys(customPresetsCache).length} presets from S3: ${s3Uri}`);
    }
    catch (error) {
        console.error(`Error loading from S3: ${error}`);
    }
}
/**
 * Load a single preset from HTTP/HTTPS URL
 */
async function loadFromUrl(url) {
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
            customPresetsCache[name] = preset;
            console.error(`Loaded preset '${name}' from URL: ${url}`);
        }
    }
    catch (error) {
        console.error(`Error loading from URL: ${error}`);
    }
}
/**
 * Parse preset content based on file extension
 */
function parsePresetContent(content, filename) {
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
        }
        else if (ext === '.md') {
            const lines = content.split('\n');
            let description = `Custom context from ${name}`;
            if (lines[0]?.startsWith('# ')) {
                description = lines[0].substring(2).trim();
            }
            return { name, description, context: content, tables: [] };
        }
    }
    catch (error) {
        console.error(`Error parsing preset from ${filename}: ${error}`);
    }
    return null;
}
/**
 * Load a preset from a local file (supports .md and .json)
 */
function loadPresetFromFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return parsePresetContent(content, filePath);
    }
    catch (error) {
        console.error(`Error loading preset from ${filePath}: ${error}`);
    }
    return null;
}
/**
 * Synchronous wrapper for backward compatibility
 */
function loadCustomPresets() {
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
        }
        catch (error) {
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
function listPresets() {
    return Object.keys(loadCustomPresets());
}
async function listPresetsAsync() {
    const presets = await initializePresets();
    return Object.keys(presets);
}
function getPreset(name) {
    return loadCustomPresets()[name.toLowerCase()];
}
async function getPresetAsync(name) {
    const presets = await initializePresets();
    return presets[name.toLowerCase()];
}
function reloadCustomPresets() {
    customPresetsCache = null;
    presetsInitialized = false;
}
