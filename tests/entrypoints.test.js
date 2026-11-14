// Process entry points must start their server even when loaded by another
// script — the way PM2 (fork mode) loads them, where process.argv[1] is PM2's
// container and never the entry file. Regression for the Stage 5 VM bootstrap,
// where an argv-based "is main module" guard left Argus running but not listening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashPassword } from '../services/manage-api/auth.js';
import { tmp } from './helpers/argus-fixtures.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

// Import the entry from an inline module, so argv[1] is NOT the entry file.
async function startIndirect(entry, env, port) {
  const url = pathToFileURL(join(ROOT, entry)).href;
  const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
    cwd: ROOT, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        return { child, status: res.status, output };
      } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    throw new Error(`${entry} never listened on ${port} (exit=${child.exitCode}): ${output}`);
  } catch (err) {
    child.kill();
    throw err;
  }
}

test('services/argus/main.js starts Argus when imported indirectly (PM2 fork mode)', async () => {
  const port = await freePort();
  const root = tmp('entry-argus-');
  const { child, status } = await startIndirect('services/argus/main.js', {
    ARGUS_INTERNAL_TOKEN: 'entry-test-token',
    ARGUS_PORT: String(port),
    ARGUS_STATE_ROOT: join(root, 'state'),
    LOGS_ROOT: join(root, 'logs')
  }, port);
  child.kill();
  assert.equal(status, 200);
});

test('services/manage-api/main.js starts Manage when imported indirectly (PM2 fork mode)', async () => {
  const port = await freePort();
  const root = tmp('entry-manage-');
  const { child, status } = await startIndirect('services/manage-api/main.js', {
    ARGUS_INTERNAL_TOKEN: 'entry-test-token',
    MANAGE_SESSION_SECRET: 'entry-test-session-secret-entry-test',
    MANAGE_ADMIN_PASSWORD_HASH: hashPassword('entry-test-password'),
    MANAGE_API_PORT: String(port),
    LOGS_ROOT: join(root, 'logs'),
    DATA_REPO_ROOT: join(root, 'bmb-data')
  }, port);
  child.kill();
  assert.equal(status, 200);
});
