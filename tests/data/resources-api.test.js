// Catalog + resource API + bmb-data webhook + concurrency, through the real
// Manage app over HTTP, against local bare Git origins.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../shared/config/index.js';
import { createApp } from '../../services/manage-api/index.js';
import { createRegistryStore } from '../../services/manage-api/registry-store.js';
import { createResourceStore } from '../../services/manage-api/resource-store.js';
import { hashPassword, LoginLimiter } from '../../services/manage-api/auth.js';
import { parseCatalog } from '../../shared/data/catalog.js';
import { sign } from '../../services/argus/webhook.js';
import { git, tmp, serve, registryEntry } from '../helpers/argus-fixtures.js';
import { makeSeededDataRepo, openRepo, devCommit, commitCount, seedFiles, BASE_CATALOG, j } from '../helpers/data-fixtures.js';

const PASSWORD = 'resources-test-password-1';
const SECRET = 'resources-test-webhook-secret';
const servers = [];
after(async () => { for (const s of servers) await s.close(); });

async function boot(repo, { sourceRoots = {} } = {}) {
  const dataRepo = openRepo(repo);
  const s = await serve(
    createApp(loadConfig({ env: {} }), {
      env: { MANAGE_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), MANAGE_SESSION_SECRET: 'resources-session', WEBHOOK_DEFAULT_SECRET: SECRET },
      argus: { health: async () => ({ reachable: true }) },
      dataRepo,
      registry: createRegistryStore({ dataRepo, expectedRemote: repo.bare }),
      resources: createResourceStore({ dataRepo, sourceRoots }),
      dataRepoFullName: 'pranav1211/bmb-data',
      limiter: new LoginLimiter({ max: 100 })
    })
  );
  servers.push(s);
  const login = await fetch(`${s.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  const call = async (method, path, body, { auth = true, csrf = true, headers = {} } = {}) => {
    const res = await fetch(`${s.base}/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { cookie } : {}),
        ...(auth && csrf ? { 'x-csrf-token': csrfToken } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  };
  return { s, call, dataRepo };
}

const fileOf = (repo, rel) => readFileSync(join(repo.checkout, rel), 'utf8');

// ── Catalog rules ──────────────────────────────────────────────────────────
test('catalog: valid entries pass; unknown fields, traversal, encoded/mixed separators, absolute, wrong extension, duplicates fail', () => {
  const repo = makeSeededDataRepo();
  const text = JSON.stringify(BASE_CATALOG);
  assert.equal(parseCatalog(repo.checkout, text).entries.size, 4);
  const bad = (patch) => {
    const c = structuredClone(BASE_CATALOG);
    Object.assign(c.resources[0], patch);
    assert.throws(() => parseCatalog(repo.checkout, JSON.stringify(c)), (e) => Boolean(e.code), JSON.stringify(patch));
  };
  bad({ extra: true });
  bad({ path: '../escape.json' });
  bad({ path: 'a/../../escape.json' });
  bad({ path: '%2e%2e/escape.json' });
  bad({ path: 'a\\..\\escape.json' });
  bad({ path: '/etc/passwd.json' });
  bad({ path: 'notes/notes.js' });
  bad({ root: 'registry' });
  bad({ key: '../registry' });
  bad({ schemaRef: '../../registry/applications' });
  bad({ schemaRef: 'missing' });
  bad({ operations: ['read', 'rm -rf'] });
  const dup = structuredClone(BASE_CATALOG);
  dup.resources.push({ ...dup.resources[0] });
  assert.throws(() => parseCatalog(repo.checkout, JSON.stringify(dup)), (e) => e.code === 'CATALOG_INVALID');
  const noItems = structuredClone(BASE_CATALOG);
  delete noItems.resources[0].items;
  assert.throws(() => parseCatalog(repo.checkout, JSON.stringify(noItems)), (e) => e.code === 'CATALOG_INVALID');
});

test('catalog: a symlink escaping the data root is refused', (t) => {
  const repo = makeSeededDataRepo();
  const outside = tmp('outside-');
  try {
    symlinkSync(outside, join(repo.checkout, 'data', 'link'), 'junction');
  } catch {
    t.skip('symlinks not permitted in this environment');
    return;
  }
  const c = structuredClone(BASE_CATALOG);
  c.resources[0].path = 'link/notes.json';
  assert.throws(() => parseCatalog(repo.checkout, JSON.stringify(c)), (e) => e.code === 'SYMLINK_ESCAPE');
});

// ── Reads ──────────────────────────────────────────────────────────────────
test('reads: public list hides private + registry; private needs a session; mapped is not served; reads never touch Git', async () => {
  const repo = makeSeededDataRepo();
  const { call } = await boot(repo);
  const head = git(repo.checkout, ['rev-parse', 'HEAD']);
  const anonList = await call('GET', '/data/resources', undefined, { auth: false });
  assert.equal(anonList.status, 200);
  assert.deepEqual(anonList.body.resources.map((r) => r.key).sort(), ['list', 'mapped.only', 'notes']);
  assert.ok(!JSON.stringify(anonList.body).includes('data/'), 'no paths for anonymous callers');
  const adminList = await call('GET', '/data/resources');
  assert.ok(adminList.body.resources.some((r) => r.key === 'secret.notes'));
  assert.ok(!adminList.body.resources.some((r) => /registry/.test(r.key + (r.path || ''))), 'registry is never a resource');

  const pub = await call('GET', '/data/resources/notes', undefined, { auth: false });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.items.length, 2);
  assert.match(pub.body.revision, /^[0-9a-f]{64}$/);
  assert.equal((await call('GET', '/data/resources/notes/items/b', undefined, { auth: false })).body.item.text, 'second');
  assert.equal((await call('GET', '/data/resources/secret.notes', undefined, { auth: false })).status, 404, 'private looks unknown');
  assert.equal((await call('GET', '/data/resources/secret.notes')).status, 200);
  assert.equal((await call('GET', '/data/resources/mapped.only', undefined, { auth: false })).status, 404);
  assert.equal((await call('GET', '/data/resources/registry', undefined, { auth: false })).status, 404);
  assert.equal((await call('GET', '/data/resources/..%2Fregistry', undefined, { auth: false })).status, 400);
  assert.equal(git(repo.checkout, ['rev-parse', 'HEAD']), head);
});

test('reads: missing and malformed canonical files are explicit errors, never empty success', async () => {
  const repo = makeSeededDataRepo();
  const { call } = await boot(repo);
  writeFileSync(join(repo.checkout, 'data/notes/notes.json'), '{"items": [');
  const malformed = await call('GET', '/data/resources/notes', undefined, { auth: false });
  assert.equal(malformed.status, 500);
  assert.equal(malformed.body.code, 'DATA_INTEGRITY');
  assert.equal(malformed.body.details.reason, 'malformed');
  writeFileSync(join(repo.checkout, 'data/notes/notes.json'), j({ wrong: true }));
  assert.equal((await call('GET', '/data/resources/notes', undefined, { auth: false })).body.details.reason, 'schema');
  git(repo.checkout, ['rm', '-q', 'data/list/list.json']);
  const missing = await call('GET', '/data/resources/list', undefined, { auth: false });
  assert.equal(missing.body.details.reason, 'missing');
});

// ── Writes ─────────────────────────────────────────────────────────────────
test('writes: unauthenticated 401, missing CSRF 403, invalid payload leaves the file byte-identical', async () => {
  const repo = makeSeededDataRepo();
  const { call } = await boot(repo);
  const snap = fileOf(repo, 'data/notes/notes.json');
  const count = commitCount(repo);
  assert.equal((await call('PUT', '/data/resources/notes', { data: { items: [] } }, { auth: false })).status, 401);
  assert.equal((await call('PUT', '/data/resources/notes', { data: { items: [] } }, { csrf: false })).status, 403);
  const invalid = await call('PUT', '/data/resources/notes', { data: { items: [{ id: 'BAD ID', text: 1 }] } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'VALIDATION_FAILED');
  assert.equal((await call('PUT', '/data/resources/notes', { data: {}, extra: 1 })).body.code, 'UNKNOWN_KEY');
  assert.equal((await call('PUT', '/data/resources/mapped.only', { data: {} })).status, 405);
  assert.equal((await call('POST', '/data/resources/secret.notes/items', { item: { id: 'x', text: 'y' } })).status, 405);
  assert.equal(fileOf(repo, 'data/notes/notes.json'), snap);
  assert.equal(commitCount(repo), count);
});

test('writes: item CRUD keeps ordering, persists + verifies; stale revision conflicts; idempotency key replays', async () => {
  const repo = makeSeededDataRepo();
  const { call } = await boot(repo);
  const created = await call('POST', '/data/resources/notes/items', { item: { id: 'c', text: 'third' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.persistence.saved, true);
  assert.equal(created.body.persistence.readBackVerified, true);
  assert.equal((await call('POST', '/data/resources/notes/items', { item: { id: 'c', text: 'dup' } })).status, 409);
  const updated = await call('PUT', '/data/resources/notes/items/a', { item: { id: 'a', text: 'edited' } });
  assert.equal(updated.status, 200);
  assert.deepEqual(JSON.parse(git(repo.bare, ['show', 'main:data/notes/notes.json'])).items.map((i) => i.id), ['a', 'b', 'c'], 'order preserved');
  assert.equal((await call('PUT', '/data/resources/notes/items/a', { item: { id: 'zz', text: 'x' } })).status, 400, 'id cannot change');
  const stale = await call('PUT', '/data/resources/notes', { data: { items: [] }, ifRevision: '0'.repeat(64) });
  assert.equal(stale.status, 409);
  const del = await call('DELETE', '/data/resources/notes/items/b', {});
  assert.equal(del.status, 200);
  const count = commitCount(repo);
  const k = { headers: { 'idempotency-key': 'req-42' } };
  const r1 = await call('PUT', '/data/resources/list', { data: [{ id: 7 }] }, k);
  const r2 = await call('PUT', '/data/resources/list', { data: [{ id: 8 }] }, k);
  assert.equal(r2.body.persistence.operationId, r1.body.persistence.operationId);
  assert.equal(r2.body.persistence.replayed, true);
  assert.equal(commitCount(repo), count + 1);
  const noop = await call('PUT', '/data/resources/list', { data: [{ id: 7 }] });
  assert.equal(noop.body.persistence.status, 'noop');
  assert.equal(commitCount(repo), count + 1, 'no-op creates no commit');
});

test('writes: push failure reports 202 pending (not saved); explicit retry pushes the same commit', async () => {
  const repo = makeSeededDataRepo();
  const { call } = await boot(repo);
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'x.git')]);
  const r = await call('PUT', '/data/resources/list', { data: [{ id: 5 }] });
  assert.equal(r.status, 202);
  assert.equal(r.body.persistence.saved, false);
  assert.equal(r.body.persistence.pending, true);
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', repo.bare]);
  const retry = await call('POST', `/data/operations/${r.body.persistence.operationId}/retry`, {});
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, 'succeeded');
  assert.equal(git(repo.bare, ['rev-parse', 'main']), r.body.persistence.commit);
  const hist = await call('GET', '/data/operations?limit=5');
  assert.ok(hist.body.operations.some((o) => o.operationId === r.body.persistence.operationId && o.status === 'succeeded'));
  assert.equal((await call('GET', '/data/operations', undefined, { auth: false })).status, 401);
});

test('transaction: multi-resource change is one commit; one invalid document rejects all', async () => {
  const repo = makeSeededDataRepo();
  const { call } = await boot(repo);
  const count = commitCount(repo);
  const bad = await call('POST', '/data/transactions', { changes: [{ key: 'list', data: [{ id: 3 }] }, { key: 'notes', data: { items: 'nope' } }] });
  assert.equal(bad.status, 400);
  assert.equal(commitCount(repo), count);
  const ok = await call('POST', '/data/transactions', { changes: [{ key: 'list', data: [{ id: 3 }] }, { key: 'notes', data: { items: [] } }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(commitCount(repo), count + 1);
  assert.deepEqual(git(repo.bare, ['show', '--name-only', '--format=', 'main']).split('\n').sort(), ['data/list/list.json', 'data/notes/notes.json']);
});

// ── Concurrency ────────────────────────────────────────────────────────────
test('concurrency: same-resource writes serialize (none lost); registry + data writes never race', async () => {
  const repo = makeSeededDataRepo();
  const { call } = await boot(repo);
  const count = commitCount(repo);
  const jobs = [];
  for (let i = 0; i < 4; i++) jobs.push(call('POST', '/data/resources/notes/items', { item: { id: `n${i}`, text: `t${i}` } }));
  for (let i = 0; i < 2; i++) jobs.push(call('POST', '/data/resources/list/items', { item: { id: 100 + i } }));
  for (let i = 0; i < 2; i++) jobs.push(call('POST', '/registry', registryEntry(`app-${i}`)));
  const results = await Promise.all(jobs);
  for (const r of results) assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  assert.equal(commitCount(repo), count + 8, 'one commit per write, none lost');
  const notes = JSON.parse(git(repo.bare, ['show', 'main:data/notes/notes.json'])).items.map((i) => i.id);
  for (let i = 0; i < 4; i++) assert.ok(notes.includes(`n${i}`));
  assert.equal(JSON.parse(git(repo.bare, ['show', 'main:data/list/list.json'])).length, 4);
  assert.equal(JSON.parse(git(repo.bare, ['show', 'main:registry/applications.json'])).applications.length, 2);
  assert.equal(git(repo.checkout, ['status', '--porcelain']), '');
});

// ── Comparison mode ────────────────────────────────────────────────────────
test('comparison mode: reports counts, ids, order and differences without normalizing', async () => {
  const repo = makeSeededDataRepo();
  const legacy = tmp('legacy-');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'notes.json'), j({ items: [{ id: 'b', text: 'second' }, { id: 'a', text: 'FIRST' }, { id: 'z', text: 'only in source' }] }));
  const { call } = await boot(repo, { sourceRoots: { 'fixture/legacy': legacy } });
  const r = await call('GET', '/data/resources/notes/compare');
  assert.equal(r.status, 200);
  assert.equal(r.body.identical, false);
  assert.equal(r.body.source.count, 3);
  assert.equal(r.body.target.count, 2);
  assert.deepEqual(r.body.ids.missingInTarget, ['z']);
  assert.equal(r.body.ids.sameOrder, false);
  assert.ok(r.body.differences.length > 0);
  assert.equal(r.body.target.path, 'data/notes/notes.json');
  assert.equal((await call('GET', '/data/resources/notes/compare', undefined, { auth: false })).status, 401);
});

// ── bmb-data webhook ───────────────────────────────────────────────────────
test('bmb-data webhook: signature, identity, ping, fast-forward sync visible to reads, duplicate delivery no-op', async () => {
  const repo = makeSeededDataRepo();
  const { s, call } = await boot(repo);
  const hook = (event, payload, secret = SECRET) => {
    const body = JSON.stringify(payload);
    return fetch(`${s.base}/api/v1/webhooks/bmb-data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(Buffer.from(body), secret), 'x-github-delivery': 'd-1' },
      body
    });
  };
  const repoInfo = { full_name: 'pranav1211/bmb-data' };
  assert.equal((await hook('push', { repository: repoInfo, ref: 'refs/heads/main', after: 'a'.repeat(40) }, 'wrong')).status, 401);
  assert.equal((await hook('push', { repository: { full_name: 'evil/repo' }, ref: 'refs/heads/main' })).status, 404);
  assert.equal((await hook('ping', { repository: repoInfo })).status, 200);
  assert.equal((await (await hook('push', { repository: repoInfo, ref: 'refs/heads/other', after: 'a'.repeat(40) })).json()).reason, 'branch-not-tracked');

  const head = devCommit(repo, { 'data/notes/notes.json': j({ items: [{ id: 'gh', text: 'edited on GitHub' }] }) });
  const r = await hook('push', { repository: repoInfo, ref: 'refs/heads/main', after: head });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.status, 'succeeded');
  assert.equal(body.result.to, head);
  assert.equal((await call('GET', '/data/resources/notes', undefined, { auth: false })).body.data.items[0].id, 'gh');
  const again = await (await hook('push', { repository: repoInfo, ref: 'refs/heads/main', after: head })).json();
  assert.equal(again.status, 'noop');
  const status = await call('GET', '/data/status');
  assert.equal(status.body.repository.head, head);
  assert.equal(status.body.catalog.ok, true);
});

test('catalog changes arrive by bmb-data push and take effect without restart', async () => {
  const repo = makeSeededDataRepo();
  const { dataRepo, call } = await boot(repo);
  const c = structuredClone(BASE_CATALOG);
  c.resources.find((r) => r.key === 'mapped.only').status = 'imported';
  devCommit(repo, { 'catalog/catalog.json': j(c), 'data/mapped/mapped.json': j({ ok: true }) });
  await dataRepo.syncFromRemote({});
  const r = await call('GET', '/data/resources/mapped.only', undefined, { auth: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { ok: true });
  assert.ok(seedFiles());
});
