import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRegistryStore } from '../../services/manage-api/registry-store.js';
import { makeEmptyDataRepo, registryEntry, git, tmp } from '../helpers/argus-fixtures.js';

const store = (repo) => createRegistryStore({ root: repo.checkout, branch: 'main', expectedRemote: repo.bare });
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

test('first write on an EMPTY bmb-data creates main with a scoped commit, pushed', async () => {
  const repo = makeEmptyDataRepo();
  const s = store(repo);
  assert.deepEqual(s.read(), []);
  const r = await s.create(registryEntry('app-one'));
  assert.equal(r.persistence.committed, true);
  assert.equal(r.persistence.pushed, true);
  assert.equal(git(repo.bare, ['rev-parse', 'main']).length, 40, 'main now exists on the remote');
  const files = git(repo.bare, ['show', '--name-only', '--format=', 'main']).split('\n').filter(Boolean);
  assert.deepEqual(files, ['registry/applications.json']);
  assert.equal(JSON.parse(git(repo.bare, ['show', 'main:registry/applications.json'])).applications[0].application, 'app-one');
});

test('duplicate identity, invalid entries and identity changes are rejected', async () => {
  const repo = makeEmptyDataRepo();
  const s = store(repo);
  await s.create(registryEntry('app-one'));
  assert.equal(await codeOf(s.create(registryEntry('app-one'))), 'CONFLICT');
  assert.equal(await codeOf(s.create({ ...registryEntry('bad'), type: 'docker' })), 'VALIDATION_FAILED');
  assert.equal(await codeOf(s.create({ ...registryEntry('bad2'), port: 3000 })), 'VALIDATION_FAILED');
  assert.equal(await codeOf(s.replace('app-one', registryEntry('renamed'))), 'VALIDATION_FAILED');
  assert.equal(await codeOf(s.replace('ghost', registryEntry('ghost'))), 'RESOURCE_NOT_FOUND');
});

test('update + enable/disable persist; writes are atomic (no temp files left)', async () => {
  const repo = makeEmptyDataRepo();
  const s = store(repo);
  await s.create(registryEntry('app-one'));
  await s.replace('app-one', { ...registryEntry('app-one'), branch: 'release' });
  const r = await s.setEnabled('app-one', false);
  assert.equal(r.entry.enabled, false);
  assert.equal(s.get('app-one').branch, 'release');
  assert.equal(git(repo.bare, ['rev-list', '--count', 'main']), '3');
  assert.deepEqual(readdirSync(join(repo.checkout, 'registry')).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(await codeOf(s.setEnabled('app-one', 'yes')), 'VALIDATION_FAILED');
});

test('push failure leaves the change committed + pending, and retry pushes it', async () => {
  const repo = makeEmptyDataRepo();
  const s = store(repo);
  await s.create(registryEntry('app-one'));
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'missing.git')]);
  const r = await s.create(registryEntry('app-two'));
  assert.equal(r.persistence.pending, true);
  assert.equal(r.persistence.pushed, false);
  assert.ok(s.get('app-two'), 'change is saved locally (visible as pending, not lost)');
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', repo.bare]);
  const commitsBefore = git(repo.checkout, ['rev-list', '--count', 'HEAD']);
  const retry = await s.retryPush();
  assert.equal(retry.persistence.pushed, true);
  assert.equal(retry.persistence.pending, false);
  assert.equal(retry.persistence.commit, r.persistence.commit, 'retry pushes the SAME commit');
  assert.equal(git(repo.checkout, ['rev-list', '--count', 'HEAD']), commitsBefore, 'retry creates no new commit');
  assert.equal(git(repo.bare, ['rev-parse', 'main']), r.persistence.commit);
  assert.equal(JSON.parse(git(repo.bare, ['show', 'main:registry/applications.json'])).applications.length, 2);
});

test('refuses to write when the checkout has unexpected changes or wrong identity', async () => {
  const repo = makeEmptyDataRepo();
  const s = store(repo);
  await s.create(registryEntry('app-one'));
  const bad = createRegistryStore({ root: repo.checkout, branch: 'main', expectedRemote: 'git@github.com:evil/repo.git' });
  assert.equal(await codeOf(bad.create(registryEntry('x'))), 'DATA_REPO_UNAVAILABLE');
  assert.ok(existsSync(join(repo.checkout, 'registry', 'applications.json')));
});
