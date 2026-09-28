#!/usr/bin/env node
/**
 * Runs the opt-in live tests (src/live) against a real database.
 *
 * Connection settings come from the environment (SQL_HOST, SQL_DATABASE, ...). If SQL_HOST is not
 * set, they are loaded from an MCP client config file: SQL_LIVE_MCP_CONFIG (default:
 * ~/.kiro/settings/mcp.json), server key SQL_LIVE_MCP_SERVER (default: sql-context-presets).
 * Credentials are never printed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const env = { ...process.env, SQL_LIVE_TESTS: '1' };
if (!env.SQL_HOST) {
  const configPath = env.SQL_LIVE_MCP_CONFIG || path.join(os.homedir(), '.kiro', 'settings', 'mcp.json');
  const serverKey = env.SQL_LIVE_MCP_SERVER || 'sql-context-presets';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const serverEnv = (config.mcpServers && config.mcpServers[serverKey] && config.mcpServers[serverKey].env) || {};
  Object.assign(env, serverEnv, { SQL_LIVE_TESTS: '1' });
  console.log(`Loaded connection settings for "${serverKey}" from ${configPath}`);
}

// Extra arguments are passed to vitest, e.g. `npm run test:live -- -t cancel`.
const result = spawnSync('npx', ['vitest', 'run', 'src/live', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: path.join(__dirname, '..'),
  shell: process.platform === 'win32',
});
process.exit(result.status === null ? 1 : result.status);
