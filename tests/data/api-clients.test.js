// Application access to Manage's data API: Manage-issued, scoped bearer tokens
// (written into the app's env file), per-application env files, and collections.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { loadConfig } from '../../shared/config/index.js';
import { createApp } from '../../services/manage-api/index.js';
import { createRegistryStore } from '../../services/manage-api/registry-store.js';
import { createResourceStore } from '../../services/manage-api/resource-store.js';
import { createApiClients } from '../../services/manage-api/api-clients.js';
import { createEnvStore, formatValue } from '../../services/manage-api/env-store.js';
import { hashPassword, LoginLimiter } from '../../services/manage-api/auth.js';
import { git, tmp, serve, registryEntry } from '../helpers/argus-fixtures.js';
import { makeSeededDataRepo, openRepo, seedFiles, BASE_CATALOG, j } from '../helpers/data-fixtures.js';

const PASSWORD = 'clients-test-password-1';
const servers = [];
after(async () => { for (const s of servers) await s.close(); });

const CATALOG = structuredClone(BASE_CATALOG);
CATALOG.resources.push({
  key: 'season', root: 'data', path: 'seasons/{id}.json', format: 'json', access: 'public',
  collection: { idPattern: '^[0-9]{4}$' }, operations: ['read', 'replace', 'create', 'delete'], schemaRef: 'notes'
});

async function boot() {
  const files = seedFiles(CATALOG);
  files['data/seasons/2025.json'] = j({ items: [{ id: 'r1', text: 'race one' }] });
  files['registry/applications.json'] = j({ applications: [registryEntry('site-app'), registryEntry('manage-beyondmebtw')] });
  const repo = makeSeededDataRepo(files);
  const dataRepo = openRepo(repo);
  const envRoot = join(tmp('env-'), 'env');
  mkdirSync(envRoot, { recursive: true });
  const submitted = [];
  const s = await serve(
    createApp(loadConfig({ env: {} }), {
      env: { MANAGE_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), MANAGE_SESSION_SECRET: 'clients-session' },
      argus: { health: async () => ({ reachable: true }), submit: async (op, app) => { submitted.push([op, app]); return { operationId: 'op_fake', started: true }; } },
      dataRepo,
      registry: createRegistryStore({ dataRepo, expectedRemote: repo.bare }),
      resources: createResourceStore({ dataRepo }),
      apiClients: createApiClients({ dataRepo }),
      envStore: createEnvStore({ envRoot }),
      limiter: new LoginLimiter({ max: 100 })
    })
  );
  servers.push(s);
  const login = await fetch(`${s.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  const admin = async (method, path, body) => {
    const r = await fetch(`${s.base}/api/v1${path}`, { method, headers: { cookie, 'x-csrf-token': csrfToken, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const as = (token) => async (method, path, body) => {
    const r = await fetch(`${s.base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { repo, envRoot, admin, as, submitted };
}

test('issuing a token writes it into the app env file; only its hash is stored in bmb-data', async () => {
  const { repo, envRoot, admin, submitted } = await boot();
  const r = await admin('POST', '/apps/site-app/token', { scopes: [{ resource: 'notes', access: ['read', 'write'] }, { resource: 'season.*', access: ['write'] }], restart: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.token, /^bmbm_c_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.body.endpoints.resources.map((x) => x.key), ['notes']);
  assert.deepEqual(r.body.endpoints.collections, [{ key: 'season.{id}', access: 'read-write' }]);
  const envText = readFileSync(join(envRoot, 'site-app.env'), 'utf8');
  assert.equal(parseEnv(envText).MANAGE_API_TOKEN, r.body.token);
  assert.equal(parseEnv(envText).MANAGE_API_URL, 'http://127.0.0.1:7100/api/v1');
  if (process.platform !== 'win32') assert.equal(statSync(join(envRoot, 'site-app.env')).mode & 0o777, 0o600);
  const stored = git(repo.bare, ['show', 'main:registry/api-clients.json']);
  assert.ok(!stored.includes(r.body.token), 'token itself never stored');
  assert.match(stored, /"tokenHash": "[0-9a-f]{64}"/);
  assert.deepEqual(submitted, [['pm2.restart', 'site-app']], 'app restarted to pick up its env');
  const view = await admin('GET', '/apps/site-app/token');
  assert.ok(view.body.client && !JSON.stringify(view.body).includes(r.body.token), 'token never shown again');
});

test('app token: scoped reads/writes with no cookie or CSRF; outside scope is refused; bad/revoked/rotated tokens fail', async () => {
  const { admin, as } = await boot();
  const issued = (await admin('POST', '/apps/site-app/token', { scopes: [{ resource: 'notes', access: ['read', 'write'] }, { resource: 'secret.notes', access: ['read'] }] })).body;
  const app = as(issued.token);
  assert.equal((await app('GET', '/data/resources/secret.notes')).status, 200, 'private read via scope');
  const w = await app('PUT', '/data/resources/notes', { data: { items: [{ id: 'x', text: 'written by the app' }] } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.persistence.saved, true);
  assert.equal((await app('PUT', '/data/resources/list', { data: [{ id: 1 }] })).status, 403, 'not in scope');
  assert.equal((await app('PUT', '/data/resources/secret.notes', { data: { items: [] } })).status, 403, 'read-only scope');
  assert.equal((await app('GET', '/data/operations')).status, 401, 'tokens never reach admin routes');
  assert.equal((await as('bmbm_c_000000000000_' + 'A'.repeat(43))('GET', '/data/resources/notes')).status, 401);
  assert.equal((await as('garbage')('PUT', '/data/resources/notes', { data: {} })).status, 401);

  const rotated = (await admin('POST', '/apps/site-app/token', { scopes: [{ resource: 'notes', access: ['read'] }] })).body;
  assert.equal(rotated.client.id, issued.client.id, 'same client, new token');
  assert.equal((await app('GET', '/data/resources/notes')).status, 401, 'old token stops working');
  assert.equal((await as(rotated.token)('GET', '/data/resources/notes')).status, 200);
  assert.equal((await admin('DELETE', '/apps/site-app/token')).status, 200);
  assert.equal((await as(rotated.token)('GET', '/data/resources/notes')).status, 401, 'revoked');
});

test('collections: an app creates and deletes members; ids are validated; list shows members', async () => {
  const { admin, as, repo } = await boot();
  const t = (await admin('POST', '/apps/site-app/token', { scopes: [{ resource: 'season.*', access: ['read', 'write'] }] })).body.token;
  const app = as(t);
  const created = await app('PUT', '/data/resources/season.2027', { data: { items: [{ id: 'r1', text: 'new season' }] } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(JSON.parse(git(repo.bare, ['show', 'main:data/seasons/2027.json'])).items[0].text, 'new season');
  const list = await app('GET', '/data/resources');
  assert.deepEqual(list.body.resources.filter((r) => r.collection === 'season').map((r) => r.key), ['season.2025', 'season.2027']);
  assert.equal((await app('PUT', '/data/resources/season.abcd', { data: { items: [] } })).status, 404);
  assert.equal((await app('PUT', '/data/resources/season.20270', { data: { items: [] } })).status, 404);
  assert.equal((await app('PUT', '/data/resources/season', { data: { items: [] } })).status, 405, 'the collection itself is not a document');
  assert.equal((await app('PUT', '/data/resources/season.2028', { data: { bad: 1 } })).status, 400, 'schema still enforced');
  assert.equal((await app('DELETE', '/data/resources/season.2027')).status, 200);
  assert.equal((await app('GET', '/data/resources/season.2027')).status, 404);
  assert.throws(() => git(repo.bare, ['show', 'main:data/seasons/2027.json']));
});

test('env files: names only, Node-compatible quoting, Manage-only keys protected, control-plane apps refused', async () => {
  const { admin, envRoot } = await boot();
  const hash = 'scrypt$16384$8$1$c2FsdA$aGFzaA';
  const put = await admin('PUT', '/apps/site-app/env', { set: { SITE_PASSWORD_HASH: hash, GREETING: "it's \"quoted\"? no", PLAIN: 'abc-123' } });
  assert.equal(put.status, 400, 'mixed quotes refused rather than silently mangled');
  const ok = await admin('PUT', '/apps/site-app/env', { set: { SITE_PASSWORD_HASH: hash, GREETING: 'hello world #1', PLAIN: 'abc-123' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const parsed = parseEnv(readFileSync(join(envRoot, 'site-app.env'), 'utf8'));
  assert.equal(parsed.SITE_PASSWORD_HASH, hash);
  assert.equal(parsed.GREETING, 'hello world #1');
  assert.equal(parsed.PLAIN, 'abc-123');
  const listed = await admin('GET', '/apps/site-app/env');
  assert.deepEqual(listed.body.keys.map((k) => k.name), ['SITE_PASSWORD_HASH', 'GREETING', 'PLAIN']);
  assert.ok(!JSON.stringify(listed.body).includes(hash), 'values never returned');
  assert.equal((await admin('PUT', '/apps/site-app/env', { unset: ['PLAIN'] })).body.env.keys.length, 2);
  assert.equal((await admin('PUT', '/apps/site-app/env', { set: { MANAGE_API_TOKEN: 'x' } })).status, 403);
  assert.equal((await admin('PUT', '/apps/site-app/env', { set: { 'bad-name': 'x' } })).status, 400);
  assert.equal((await admin('GET', '/apps/manage-beyondmebtw/env')).status, 403, 'control plane is hand-managed');
  assert.equal((await admin('GET', '/apps/nope/env')).status, 404);
  for (const v of ['a$b', 'p@ss w0rd', '#hash', 'x=y']) assert.equal(parseEnv(`K=${formatValue(v)}`).K, v);
});
