#!/usr/bin/env node
/**
 * Runs the full memory-bound check: 5,000,000 fake rows through export_query, run_query (spooled,
 * open-cursor and streaming paths) and fetch_rows, with the garbage collector exposed so retained
 * memory is measured exactly. The default `npm test` runs a smaller version of the same tests.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const env = {
  ...process.env,
  SQL_MEMORY_TESTS: '1',
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--expose-gc`,
};
const args = ['vitest', 'run', 'src/memory.test.ts', '--pool=forks'];
const result = spawnSync('npx', args, {
  stdio: 'inherit',
  env,
  cwd: path.join(__dirname, '..'),
  shell: process.platform === 'win32',
});
process.exit(result.status === null ? 1 : result.status);
