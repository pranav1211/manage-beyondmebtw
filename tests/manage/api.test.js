// Manage API integration: real Manage app + real Argus app (isolated-test),
// real local Git for bmb-data. No PM2 daemon is needed: the operations used
// here fail or no-op before any PM2 call.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { loadConfig } from '../../shared/config/index.js';
import { createApp as createManage } from '../../services/manage-api/index.js';
import { createApp as createArgus } from '../../services/argus/argus.js';
import { createArgusClient } from '../../services/manage-api/argus-client.js';
import { createRegistryStore } from '../../services/manage-api/registry-store.js';
import { hashPassword, LoginLimiter } from '../../services/manage-api/auth.js';
import { GLOBAL_RECONCILE_CONFIRMATION } from '../../services/manage-api/routes/v1.js';
import { tmp, makeEmptyDataRepo, makeConfigRepo, registryEntry, serve, waitForOp } from '../helpers/argus-fixtures.js';

const PASSWORD = 'manage-test-password-123';
const TOKEN = 'manage-api-test-internal-token';
const root = tmp('mapi-');
const projects = join(root, 'projects');
mkdirSync(projects, { recursive: true });
const dataRepo = makeEmptyDataRepo();
const cfgRepo = makeConfigRepo();
const registryPath = join(dataRepo.checkout, 'registry', 'applications.json');
const registry = createRegistryStore({ root: dataRepo.checkout, branch: 'main', expectedRemote: dataRepo.bare });
const servers = [];

let argusBase;
let manage;

function argusApp(extraEnv = {}) {
  const config = loadConfig({
    service: 'argus',
    env: {
      ARGUS_EXECUTION_ENABLED: 'true',
      ARGUS_MODE: 'isolated-test',
      PROJECTS_ROOT: projects,
      ARGUS_STATE_ROOT: join(root, `state-${Object.keys(extraEnv).length}`),
      REGISTRY_PATH: registryPath,
      CONFIG_REPO_ROOT: cfgRepo.checkout,
      ...extraEnv
    }
  });
  return createArgus(config, {
    env: { ARGUS_INTERNAL_TOKEN: TOKEN },
    configRepo: { root: cfgRepo.checkout, branch: 'main', expectedRemote: cfgRepo.bare }
  });
}

async function manageWith(argusClient, limiterMax = 3) {
  const s = await serve(
    createManage(loadConfig({ env: {} }), {
      env: { MANAGE_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), MANAGE_SESSION_SECRET: 'test-session-secret' },
      argus: argusClient,
      registry,
      limiter: new LoginLimiter({ max: limiterMax })
    })
  );
  servers.push(s);
  return s;
}

async function login(base, password = PASSWORD) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password })
  });
  const body = await res.json();
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, body, cookie, csrf: body.csrfToken };
}

function client(base, sess) {
  const h = (extra = {}) => ({ cookie: sess.cookie, 'x-csrf-token': sess.csrf, 'content-type': 'application/json', ...extra });
  return {
    get: (p) => fetch(`${base}/api/v1${p}`, { headers: { cookie: sess.cookie } }),
    send: (method, p, body, extra) => fetch(`${base}/api/v1${p}`, { method, headers: h(extra), body: JSON.stringify(body ?? {}) })
  };
}

before(async () => {
  // Seed bmb-data: the first write creates main on the empty repo.
  await registry.create(registryEntry('node-a'));
  await registry.create(registryEntry('node-off', { enabled: false }));
  await registry.create(registryEntry('static-s', { type: 'static' }));
  await registry.create({ ...registryEntry('test-t'), environment: 'test' });
  const a = await serve(argusApp());
  servers.push(a);
  argusBase = a.base;
  manage = await manageWith(createArgusClient({ baseUrl: argusBase, token: TOKEN }));
});

after(async () => { for (const s of servers) await s.close(); });

test('unauthenticated requests are denied server-side', async () => {
  for (const p of ['/status', '/registry', '/operations', '/registry/node-a']) {
    assert.equal((await fetch(`${manage.base}/api/v1${p}`)).status, 401, p);
  }
  const post = await fetch(`${manage.base}/api/v1/operations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operation":"deploy","application":"node-a"}'
  });
  assert.equal(post.status, 401);
});

test('wrong password is rejected; repeated failures are rate-limited', async () => {
  const m = await manageWith(createArgusClient({ baseUrl: argusBase, token: TOKEN }), 2);
  assert.equal((await login(m.base, 'nope')).res.status, 401);
  assert.equal((await login(m.base, 'nope')).res.status, 401);
  assert.equal((await login(m.base, PASSWORD)).res.status, 429, 'locked out even with the right password');
});

test('login issues a session; mutations need the CSRF token; logout ends it', async () => {
  const sess = await login(manage.base);
  assert.equal(sess.res.status, 200);
  assert.match(sess.res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.ok(!JSON.stringify(sess.body).includes('scrypt'), 'no hash in responses');
  const c = client(manage.base, sess);
  assert.equal((await c.get('/status')).status, 200);
  const noCsrf = await fetch(`${manage.base}/api/v1/registry/node-a/enabled`, {
    method: 'PATCH', headers: { cookie: sess.cookie, 'content-type': 'application/json' }, body: '{"enabled":true}'
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await c.send('POST', '/auth/logout')).status, 200);
  assert.equal((await c.get('/status')).status, 401);
});

test('status reports Argus reachability and registry counts (no secrets)', async () => {
  const c = client(manage.base, await login(manage.base));
  const s = await (await c.get('/status')).json();
  assert.equal(s.argus.reachable, true);
  assert.equal(s.argus.executionEnabled, true);
  assert.equal(s.registry.applications, 4);
  assert.ok(!JSON.stringify(s).includes(TOKEN));
  assert.ok(!JSON.stringify(s).includes('6040') && !JSON.stringify(s).includes(argusBase), 'no Argus address leaked');
});

test('registry CRUD validates, rejects duplicates, and pushes to bmb-data', async () => {
  const c = client(manage.base, await login(manage.base));
  const created = await c.send('POST', '/registry', registryEntry('new-app'));
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.persistence.pushed, true);
  assert.equal((await c.send('POST', '/registry', registryEntry('new-app'))).status, 409);
  assert.equal((await c.send('POST', '/registry', { ...registryEntry('x'), extra: 1 })).status, 400);
  assert.equal((await c.send('POST', '/registry', { ...registryEntry('y'), deploymentPath: 'relative/path' })).status, 400);
  const off = await c.send('PATCH', '/registry/new-app/enabled', { enabled: false });
  assert.equal((await off.json()).entry.enabled, false);
  const list = await (await c.get('/registry')).json();
  assert.equal(list.source.path, 'registry/applications.json');
  assert.ok(list.applications.some((e) => e.application === 'new-app'));
});

test('operations: pre-checks, async acceptance, and a sanitized final result', async () => {
  const c = client(manage.base, await login(manage.base));
  assert.equal((await c.send('POST', '/operations', { operation: 'deploy', application: 'node-off' })).status, 409);
  assert.equal((await c.send('POST', '/operations', { operation: 'deploy', application: 'ghost' })).status, 404);
  assert.equal((await c.send('POST', '/operations', { operation: 'rm -rf', application: 'node-a' })).status, 400);
  assert.equal((await c.send('POST', '/operations', { operation: 'health', application: 'node-a', shell: 'x' })).status, 400);

  const acc = await c.send('POST', '/operations', { operation: 'health', application: 'node-a' });
  assert.equal(acc.status, 202);
  const { operationId, accepted } = await acc.json();
  assert.equal(accepted, true);
  // Follow it through Manage (never Argus) until terminal.
  let rec;
  for (let i = 0; i < 50; i++) {
    rec = await (await c.get(`/operations/${operationId}`)).json();
    if (['succeeded', 'failed', 'blocked'].includes(rec.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(rec.status, 'failed', 'never deployed → health cannot pass; accepted ≠ succeeded');
  assert.equal(rec.error.code, 'RESOURCE_NOT_FOUND');
  assert.ok(!JSON.stringify(rec).includes('stack'));
  const hist = await (await c.get('/operations?application=node-a')).json();
  assert.ok(hist.operations.some((o) => o.operationId === operationId), 'history survives (server-side)');
});

test('global reconcile needs confirmation and reports independent per-app results', async () => {
  const c = client(manage.base, await login(manage.base));
  assert.equal((await c.send('POST', '/reconcile', {})).status, 400);
  const r = await (await c.send('POST', '/reconcile', { confirm: GLOBAL_RECONCILE_CONFIRMATION })).json();
  const byApp = Object.fromEntries([...r.results, ...r.skipped].map((x) => [x.application, x]));
  assert.ok(byApp['node-a'].operationId, 'eligible app gets its own operation');
  assert.equal(byApp['node-off'].reason, 'disabled');
  assert.equal(byApp['static-s'].reason, 'static (no PM2)');
  assert.equal(byApp['test-t'].reason, 'test entry');
  assert.equal((await c.send('POST', '/reconcile/static-s')).status, 400);
  const rec = await waitForOp(argusBase, TOKEN, byApp['node-a'].operationId);
  assert.equal(rec.status, 'failed', 'no generated config yet → reported, never faked');
});

test('Argus unavailable / unauthorized / timeout / malformed are reported accurately', async () => {
  const closed = http.createServer(); // bind then close → a port with nothing listening
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const hang = http.createServer(() => {}); // never responds
  const junk = http.createServer((_q, s) => { s.writeHead(200); s.end('not json'); });
  for (const s of [hang, junk]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const cases = [
    [createArgusClient({ baseUrl: `http://127.0.0.1:${deadPort}`, token: TOKEN }), 502, 'ARGUS_UNAVAILABLE'],
    [createArgusClient({ baseUrl: argusBase, token: 'wrong-token' }), 502, 'ARGUS_UNAUTHORIZED'],
    [createArgusClient({ baseUrl: `http://127.0.0.1:${hang.address().port}`, token: TOKEN, timeoutMs: 300 }), 504, 'ARGUS_TIMEOUT'],
    [createArgusClient({ baseUrl: `http://127.0.0.1:${junk.address().port}`, token: TOKEN }), 502, 'ARGUS_BAD_RESPONSE']
  ];
  try {
    for (const [argusClient, status, code] of cases) {
      const m = await manageWith(argusClient);
      const c = client(m.base, await login(m.base));
      const res = await c.send('POST', '/operations', { operation: 'health', application: 'node-a' });
      assert.equal(res.status, status, code);
      assert.equal((await res.json()).code, code);
      const st = await (await c.get('/status')).json();
      assert.equal(st.argus.reachable, false, `${code} must not look healthy`);
    }
  } finally {
    hang.closeAllConnections();
    for (const s of [hang, junk]) await new Promise((r) => s.close(r));
  }
  assert.throws(() => createArgusClient({ baseUrl: 'http://10.0.0.5:6040', token: TOKEN }), (e) => e.code === 'CONFIG_INVALID');
});

test('production mode: only allowlisted, non-test, enabled apps are executable', async () => {
  const p = await serve(argusApp({ ARGUS_MODE: 'production', ARGUS_EXECUTION_ALLOWLIST: 'node-a', NODE_ENV: 'production', ARGUS_INTERNAL_TOKEN: TOKEN }));
  servers.push(p);
  const send = (application) => fetch(`${p.base}/operations`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, operation: 'health', application })
  });
  // Re-enable a test entry to prove the test flag alone is enough to refuse.
  const refusedTest = await send('test-t');
  assert.equal(refusedTest.status, 403);
  assert.equal((await refusedTest.json()).code, 'TARGET_NOT_ALLOWED');
  assert.equal((await send('static-s')).status, 403, 'not on the allowlist');
  assert.equal((await send('node-off')).status, 409, 'disabled');
  const before = await (await fetch(`${p.base}/operations`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(before.total, 0, 'refused requests create no operation records');
  assert.equal((await send('node-a')).status, 202, 'allowlisted app accepted');
  assert.throws(() => loadConfig({ env: { ARGUS_EXECUTION_ENABLED: 'true', ARGUS_MODE: 'production', PROJECTS_ROOT: '/projects' } }), (e) => e.code === 'CONFIG_INVALID');
});

test('the frontend never references Argus, its port, or credentials', () => {
  const dirs = ['apps/manage/src', 'apps/manage/dist'].map((d) => join(process.cwd(), d)).filter(existsSync);
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const file of dirs.flatMap(walk)) {
    const text = readFileSync(file, 'utf8');
    for (const needle of ['6040', 'ARGUS_INTERNAL_TOKEN', 'Bearer ', '127.0.0.1']) {
      assert.ok(!text.includes(needle), `${file} must not contain ${needle}`);
    }
  }
});
