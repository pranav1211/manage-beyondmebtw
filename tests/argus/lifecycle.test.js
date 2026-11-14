// REAL end-to-end lifecycle tests: real Git (local bare origins), real Config
// Repo commits/pushes, real PM2 daemon (isolated PM2_HOME), real HTTP health.
// Fixture apps only; isolated projects root; dummy secrets.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { loadConfig } from '../../shared/config/index.js';
import { createApp } from '../../services/argus/argus.js';
import { describe as pm2Describe, deleteProcesses, disconnectPm2, startRaw, envKeysOf } from '../../services/argus/pm2.js';
import {
  tmp, git, makeRepo, makeConfigRepo, commitAndPush, nodeAppSource, registryEntry, declarationFor,
  writeRegistry, signedPush, serve, waitForOp, killPm2Daemon
} from '../helpers/argus-fixtures.js';

const TOKEN = 'lifecycle-internal-token-value';
const SECRET = 'lifecycle-webhook-secret-value';
const DEFAULT_SECRET = 'lifecycle-default-secret-value';

const root = tmp('life-');
process.env.PM2_HOME = join(root, 'pm2'); // must be set before PM2 is first loaded
const projects = join(root, 'projects');
mkdirSync(projects, { recursive: true });

const eOk = registryEntry('node-ok', { secretRef: 'ARGUS_WEBHOOK_SECRET_NODE_OK' });
const eBad = registryEntry('node-bad-health');
const eTwo = registryEntry('node-two');
const eStatic = registryEntry('static-ok', { type: 'static' });

const repos = {
  'node-ok': makeRepo({ 'server.js': nodeAppSource(), 'argus.deploy.json': JSON.stringify(declarationFor(eOk, { script: 'server.js', port: 47101, healthPath: '/health' }), null, 2) }),
  'node-bad-health': makeRepo({ 'server.js': nodeAppSource(), 'argus.deploy.json': JSON.stringify(declarationFor(eBad, { script: 'server.js', port: 47102, healthPath: '/nope' }), null, 2) }),
  'node-two': makeRepo({ 'server.js': nodeAppSource(), 'argus.deploy.json': JSON.stringify(declarationFor(eTwo, { script: 'server.js', port: 47103, healthPath: '/health' }), null, 2) }),
  'static-ok': makeRepo({ 'index.html': '<!doctype html><h1>static ok</h1>\n', 'argus.deploy.json': JSON.stringify(declarationFor(eStatic), null, 2) })
};
const cfgRepo = makeConfigRepo();
const registryPath = writeRegistry(root, [eOk, eBad, eTwo, eStatic]);
const NAMES = ['node-ok', 'node-bad-health', 'node-two', 'stranger'];

// Stand-in for nginx serving static deployments: maps /<app>/<file> -> projects/<app>/<file>.
const staticServer = http.createServer((req, res) => {
  const p = join(projects, decodeURIComponent(req.url.split('?')[0]));
  if (p.startsWith(projects) && existsSync(p)) { res.writeHead(200); return res.end(readFileSync(p)); }
  res.writeHead(404); res.end();
});

let s;
let staticBase;
const auth = { authorization: `Bearer ${TOKEN}` };

// Make this process look like Argus running UNDER PM2 (as on the VM): PM2
// injects its internals into the managed process env, and Argus's own
// credentials sit in process.env via --env-file. None of it may reach a managed
// app — in particular pm_exec_path must not make the new app run Argus's script.
const POISON_SCRIPT = join(root, 'poison-argus.js');
writeFileSync(POISON_SCRIPT, 'process.exit(1);\n');
const POISON_ENV = {
  pm_id: '99',
  name: 'argus',
  pm_exec_path: POISON_SCRIPT,
  pm_cwd: root,
  pm_out_log_path: join(root, 'poison-out.log'),
  pm_err_log_path: join(root, 'poison-err.log'),
  ARGUS_INTERNAL_TOKEN: TOKEN,
  CALLER_ONLY_SENTINEL: 'must-not-leak'
};
const savedEnv = {};
for (const [k, v] of Object.entries(POISON_ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }

before(async () => {
  await new Promise((r) => staticServer.listen(0, '127.0.0.1', r));
  staticBase = `http://127.0.0.1:${staticServer.address().port}`;
  const config = loadConfig({
    env: {
      ARGUS_EXECUTION_ENABLED: 'true',
      ARGUS_MODE: 'isolated-test',
      PROJECTS_ROOT: projects,
      ARGUS_STATE_ROOT: join(root, 'state'),
      REGISTRY_PATH: registryPath,
      CONFIG_REPO_ROOT: cfgRepo.checkout
    }
  });
  const app = createApp(config, {
    env: { ARGUS_INTERNAL_TOKEN: TOKEN, ARGUS_WEBHOOK_SECRET_NODE_OK: SECRET, WEBHOOK_DEFAULT_SECRET: DEFAULT_SECRET },
    resolveRemote: (e) => repos[e.application].bare,
    configRepo: { root: cfgRepo.checkout, branch: 'main', expectedRemote: cfgRepo.bare },
    staticHealthUrl: (e) => `${staticBase}/${e.application}/index.html`,
    healthOpts: { attempts: 6, intervalMs: 300 },
    pm2SettleMs: 1500
  });
  s = await serve(app);
  s.app = app;
});

after(async () => {
  const step = async (label, fn) => {
    const t = Date.now();
    try { await fn(); } catch (e) { console.log(`[teardown] ${label} failed: ${e.message}`); }
    console.log(`[teardown] ${label} ${Date.now() - t}ms`);
  };
  await step('delete test processes', () => deleteProcesses(NAMES));
  await step('disconnect pm2 client', () => disconnectPm2());
  await step('stop test pm2 daemon', async () => killPm2Daemon(process.env.PM2_HOME));
  await step('close argus', () => s.close());
  await step('close static', () => { staticServer.closeAllConnections(); return new Promise((r) => staticServer.close(r)); });
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function webhook(application, commit, secret = SECRET) {
  const { body, sig } = signedPush({ fullName: `fixture/${application}`, after: commit, secret });
  const res = await fetch(`${s.base}/webhook`, { method: 'POST', headers: { 'x-github-event': 'push', 'x-hub-signature-256': sig }, body });
  return { status: res.status, body: await res.json() };
}

async function op(operation, application, params) {
  const res = await fetch(`${s.base}/operations`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, operation, application, ...(params ? { params } : {}) })
  });
  assert.equal(res.status, 202);
  return (await res.json()).operationId;
}

const pm2File = (app) => `infrastructure/config/pm2/${app}.config.js`;

test('node deploy via signed webhook: generate → commit/push → read-back → PM2 → health', async () => {
  const head = repos['node-ok'].head;
  const r = await webhook('node-ok', head);
  assert.equal(r.status, 202);
  const rec = await waitForOp(s.base, TOKEN, r.body.operationId);
  assert.equal(rec.status, 'succeeded', JSON.stringify(rec.error));
  assert.equal(rec.result.revision, head);
  assert.equal(rec.result.generatedConfig.path, pm2File('node-ok'));
  assert.equal(rec.result.generatedConfig.pushed, true);
  assert.equal(rec.result.generatedConfig.readBackVerified, true);
  assert.equal(rec.result.declaration.match, true);
  assert.equal(rec.result.pm2.actual[0].status, 'online');
  assert.equal(rec.result.health.status, 200);

  // Config Repo commit is scoped to the generated file + manifest only.
  const paths = git(cfgRepo.bare, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
  assert.deepEqual(paths, ['infrastructure/config/manifest.json', pm2File('node-ok')].sort());
  const generated = git(cfgRepo.bare, ['show', `HEAD:${pm2File('node-ok')}`]);
  for (const secret of [TOKEN, SECRET, DEFAULT_SECRET]) assert.ok(!generated.includes(secret), 'no secret values in generated config');
  const manifest = JSON.parse(git(cfgRepo.bare, ['show', 'HEAD:infrastructure/config/manifest.json']));
  assert.equal(manifest.pm2.find((p) => p.application === 'node-ok').status, 'generated');

  // Argus's own credentials never reach the managed process environment.
  const keys = await envKeysOf('node-ok');
  assert.ok(!keys.includes('ARGUS_INTERNAL_TOKEN'));
  assert.ok(!keys.some((k) => k.startsWith('ARGUS_WEBHOOK_SECRET')));
  assert.ok(!keys.includes('CALLER_ONLY_SENTINEL'), 'nothing from the caller env is inherited');
  const [proc] = await pm2Describe(['node-ok']);
  assert.ok(!JSON.stringify(proc).includes(POISON_SCRIPT), 'Argus\'s own PM2 internals never reach the app');
  assert.equal((await fetch('http://127.0.0.1:47101/health')).status, 200);
});

test('repeat delivery of the deployed commit is idempotent (no side effect)', async () => {
  const cfgHead = git(cfgRepo.bare, ['rev-parse', 'HEAD']);
  const [before] = await pm2Describe(['node-ok']);
  const r = await webhook('node-ok', repos['node-ok'].head);
  const rec = await waitForOp(s.base, TOKEN, r.body.operationId);
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.result.noop, true);
  assert.equal(rec.result.reason, 'already-deployed');
  assert.equal(git(cfgRepo.bare, ['rev-parse', 'HEAD']), cfgHead, 'no Config Repo commit');
  const [afterProc] = await pm2Describe(['node-ok']);
  assert.equal(afterProc.pid, before.pid, 'process untouched');
});

test('new code commit redeploys; unchanged PM2 config makes no Config Repo commit', async () => {
  const cfgHead = git(cfgRepo.bare, ['rev-parse', 'HEAD']);
  const head = commitAndPush(repos['node-ok'], { 'README.md': 'v2\n' }, 'code change');
  const rec = await waitForOp(s.base, TOKEN, (await webhook('node-ok', head)).body.operationId);
  assert.equal(rec.status, 'succeeded', JSON.stringify(rec.error));
  assert.equal(rec.result.revision, head);
  assert.equal(rec.result.generatedConfig.changed, false);
  assert.equal(rec.result.pm2.actions[0].action, 'recreated');
  assert.equal(git(cfgRepo.bare, ['rev-parse', 'HEAD']), cfgHead);
});

test('declaration mismatch is surfaced and the registry stays authoritative', async () => {
  const decl = declarationFor(eOk, { script: 'server.js', port: 47101, healthPath: '/health' });
  const head = commitAndPush(repos['node-ok'], { 'argus.deploy.json': JSON.stringify({ ...decl, domain: 'tampered.example' }, null, 2) });
  const rec = await waitForOp(s.base, TOKEN, (await webhook('node-ok', head)).body.operationId);
  assert.equal(rec.status, 'succeeded', JSON.stringify(rec.error));
  assert.equal(rec.result.declaration.match, false);
  const m = rec.result.declaration.mismatches.find((x) => x.field === 'domain');
  assert.deepEqual(m, { field: 'domain', registry: 'node-ok.local', declaration: 'tampered.example' });
});

test('failed health check stops the operation, is recorded, and does not roll back', async () => {
  const rec = await waitForOp(s.base, TOKEN, await op('deploy', 'node-bad-health'));
  assert.equal(rec.status, 'failed');
  assert.equal(rec.stage, 'health-check');
  assert.equal(rec.error.code, 'HEALTH_CHECK_FAILED');
  assert.equal(rec.error.details.status, 404);
  const [proc] = await pm2Describe(['node-bad-health']);
  assert.equal(proc.status, 'online', 'no rollback: process left in place for diagnosis');
  // The app lock was released: a follow-up operation on the same app runs.
  const stop = await waitForOp(s.base, TOKEN, await op('pm2.stop', 'node-bad-health'));
  assert.equal(stop.status, 'succeeded');
});

test('static deploy passes the index.html health check without PM2', async () => {
  const rec = await waitForOp(s.base, TOKEN, await op('deploy', 'static-ok'));
  assert.equal(rec.status, 'succeeded', JSON.stringify(rec.error));
  assert.equal(rec.result.health.status, 200);
  assert.equal(rec.result.generatedConfig, undefined);
  assert.equal((await pm2Describe(['static-ok'])).length, 0);
});

test('unknown PM2 processes are reported, never deleted', async () => {
  writeFileSync(join(root, 'stranger.js'), 'setInterval(() => {}, 1000);\n');
  // Simulates a process an operator started by hand (not in the registry).
  await startRaw({ name: 'stranger', script: join(root, 'stranger.js'), cwd: root, interpreter: process.execPath });
  const rec = await waitForOp(s.base, TOKEN, await op('pm2.reconcile', 'node-ok'));
  assert.equal(rec.status, 'succeeded', JSON.stringify(rec.error));
  assert.ok(rec.result.unmanaged.some((p) => p.name === 'stranger'));
  assert.ok(rec.result.actions.every((a) => a.name === 'node-ok'), 'reconcile touched only its own app');
  const [stranger] = await pm2Describe(['stranger']);
  assert.equal(stranger.status, 'online');
});

test('same-app operations serialize; queued commits collapse to the latest', async () => {
  const ids = [await op('build', 'node-two'), await op('build', 'node-two'), await op('build', 'node-two')];
  await s.app.locals.argus.scheduler.idle('node-two');
  const [r1, r2, r3] = await Promise.all(ids.map((id) => waitForOp(s.base, TOKEN, id)));
  assert.equal(r1.status, 'succeeded', JSON.stringify(r1.error));
  assert.equal(r2.status, 'blocked');
  assert.equal(r2.error.code, 'SUPERSEDED');
  assert.equal(r3.status, 'succeeded', JSON.stringify(r3.error));
  assert.ok(r3.finishedAt > r1.finishedAt, 'latest pending ran after the active one finished');
});

test('different applications deploy concurrently', async () => {
  const [a, b] = await Promise.all([op('build', 'node-ok'), op('build', 'node-two')]);
  const [ra, rb] = await Promise.all([waitForOp(s.base, TOKEN, a), waitForOp(s.base, TOKEN, b)]);
  assert.equal(ra.status, 'succeeded', JSON.stringify(ra.error));
  assert.equal(rb.status, 'succeeded', JSON.stringify(rb.error));
});
