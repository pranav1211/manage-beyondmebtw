// REAL nginx validation/application tests against an ISOLATED nginx instance
// (own prefix, own config, loopback port). Never touches a system/production
// nginx. Requires NGINX_BIN (path to an nginx binary); skipped otherwise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createNginxRunner, prepareIsolatedPrefix, validateCandidate, applyCandidate } from '../../services/argus/nginx.js';
import { tmp } from '../helpers/argus-fixtures.js';

const BIN = process.env.NGINX_BIN;
const skip = !BIN || !existsSync(BIN) ? 'NGINX_BIN not set — real nginx validation not run' : false;

const PORT = 47180;
const FILE = 'fixture.conf';
const manifest = { nginx: [{ host: 'fixture.local', file: FILE, owner: 'node-ok' }] };
const site = (body) => `server {\n  listen 127.0.0.1:${PORT};\n  server_name fixture.local;\n  location / { return 200 "${body}"; }\n}\n`;
const INVALID = `server {\n  listen 127.0.0.1:${PORT};\n  this_is_not_a_directive on;\n}\n`;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prefix;
let runner;
let active;

before(() => {
  if (skip) return;
  prefix = prepareIsolatedPrefix({ prefix: join(tmp('nginx-'), 'prefix'), mimeTypesFrom: join(dirname(BIN), 'conf', 'mime.types') });
  runner = createNginxRunner({ bin: BIN, prefix });
  active = join(runner.sitesDir, FILE);
  writeFileSync(active, site('v1')); // the "active" known-good config
});

after(() => {
  if (skip || !runner) return;
  if (runner.isRunning()) {
    try { execFileSync(BIN, runner.args(['-s', 'stop'], 'conf/nginx.conf'), { cwd: prefix, stdio: 'ignore', timeout: 20_000 }); } catch { /* ignore */ }
  }
});

test('every nginx invocation is pinned to the isolated prefix and config', { skip }, () => {
  const args = runner.args(['-t'], 'conf/nginx.conf');
  assert.deepEqual(args.slice(0, 4), ['-p', runner.prefix, '-c', 'conf/nginx.conf']);
  assert.ok(runner.prefix.replace(/\\/g, '/').startsWith(prefix.replace(/\\/g, '/')));
});

test('valid candidate passes real nginx -t', { skip }, async () => {
  const r = await validateCandidate({ runner, manifest, file: FILE, content: site('v2') });
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /syntax is ok|test is successful/);
});

test('invalid candidate is rejected and the active config is byte-identical', { skip }, async () => {
  const before = sha(active);
  const r = await validateCandidate({ runner, manifest, file: FILE, content: INVALID });
  assert.equal(r.ok, false);
  assert.match(r.output, /unknown directive/);
  await assert.rejects(applyCandidate({ runner, manifest, file: FILE, content: INVALID }), (e) => e.code === 'NGINX_INVALID');
  assert.equal(sha(active), before, 'invalid candidate must not replace the active file');
});

test('unowned config files are refused', { skip }, async () => {
  await assert.rejects(validateCandidate({ runner, manifest, file: 'other.conf', content: site('x') }), (e) => e.code === 'NGINX_INVALID');
});

test('valid candidate is applied and reloaded on the running isolated instance', { skip }, async () => {
  const child = spawn(BIN, runner.args([], 'conf/nginx.conf'), { cwd: prefix, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40 && !runner.isRunning(); i++) await sleep(250);
  assert.ok(runner.isRunning(), 'isolated nginx started');
  let body = '';
  for (let i = 0; i < 20; i++) {
    try { body = await (await fetch(`http://127.0.0.1:${PORT}/`)).text(); if (body) break; } catch { await sleep(250); }
  }
  assert.equal(body, 'v1');

  const r = await applyCandidate({ runner, manifest, file: FILE, content: site('v2') });
  assert.equal(r.activated, true);
  assert.equal(r.reloaded, true);
  for (let i = 0; i < 20 && body !== 'v2'; i++) {
    await sleep(250);
    try { body = await (await fetch(`http://127.0.0.1:${PORT}/`)).text(); } catch { /* reloading */ }
  }
  assert.equal(body, 'v2', 'reloaded instance serves the newly applied config');
});
