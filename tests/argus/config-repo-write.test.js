import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistOwnedFiles, upsertPm2Entry, renderManifest, loadManifest } from '../../shared/config-repo/index.js';
import { Mutex } from '../../services/argus/locks.js';
import { makeConfigRepo, git, tmp } from '../helpers/argus-fixtures.js';

const PM2_REL = 'infrastructure/config/pm2/node-ok.config.js';
const MANIFEST_REL = 'infrastructure/config/manifest.json';

function filesFor(repo, content = '// generated v1\n') {
  const { manifest } = loadManifest(repo.checkout);
  return [
    { relPath: PM2_REL, content },
    { relPath: MANIFEST_REL, content: renderManifest(upsertPm2Entry(manifest, 'node-ok', 'node-ok.config.js')) }
  ];
}

const persist = (repo, files, extra = {}) =>
  persistOwnedFiles({ root: repo.checkout, branch: 'main', files, message: 'argus: test', lock: new Mutex(), expectedRemote: repo.bare, ...extra });

const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

test('writes only owned paths in a scoped commit, pushes, and reads back by hash', async () => {
  const repo = makeConfigRepo();
  const r = await persist(repo, filesFor(repo));
  assert.equal(r.changed, true);
  assert.equal(r.pushed, true);
  const changedPaths = git(repo.bare, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
  assert.deepEqual(changedPaths, [MANIFEST_REL, PM2_REL].sort(), 'commit must contain only the generated file + manifest');
  assert.equal(r.readBack.length, 2);
  assert.match(r.readBack[0].sha256, /^[0-9a-f]{64}$/);
  const manifest = JSON.parse(git(repo.bare, ['show', `HEAD:${MANIFEST_REL}`]));
  assert.deepEqual(manifest.pm2[0], { application: 'node-ok', file: 'node-ok.config.js', managedByArgus: true, status: 'generated' });
});

test('repeat with identical content creates no commit', async () => {
  const repo = makeConfigRepo();
  await persist(repo, filesFor(repo));
  const before = git(repo.bare, ['rev-parse', 'HEAD']);
  const r2 = await persist(repo, filesFor(repo));
  assert.equal(r2.changed, false);
  assert.equal(r2.pushed, false);
  assert.equal(git(repo.bare, ['rev-parse', 'HEAD']), before);
});

test('unexpected local changes are never captured (CONFIG_REPO_DIRTY)', async () => {
  const repo = makeConfigRepo();
  writeFileSync(join(repo.checkout, 'stray.txt'), 'operator scratch');
  assert.equal(await codeOf(persist(repo, filesFor(repo))), 'CONFIG_REPO_DIRTY');
  assert.equal(git(repo.checkout, ['log', '--oneline']).split('\n').length, 1, 'no commit made');
});

test('remote advanced (unrelated change) fast-forwards safely', async () => {
  const repo = makeConfigRepo();
  writeFileSync(join(repo.work, 'NOTES.md'), 'operator note');
  git(repo.work, ['add', 'NOTES.md']);
  git(repo.work, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'note']);
  git(repo.work, ['push', '-q', 'origin', 'HEAD:main']);
  const r = await persist(repo, filesFor(repo));
  assert.equal(r.pushed, true);
  assert.ok(git(repo.bare, ['log', '--oneline']).includes('note'), 'remote history preserved');
});

test('push failure is visible + retryable, retry creates no duplicate commit', async () => {
  const repo = makeConfigRepo();
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'missing.git')]);
  const err = await persist(repo, filesFor(repo)).catch((e) => e);
  assert.equal(err.code, 'GIT_FAILED');
  assert.equal(err.details.retryable, true);
  const localCommit = err.details.localCommit;
  // Remote unchanged; fix the push URL and retry the same operation.
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', repo.bare]);
  const r = await persist(repo, filesFor(repo));
  assert.equal(r.changed, false, 'retry must not create a second commit');
  assert.equal(r.pushed, true);
  assert.equal(git(repo.bare, ['rev-parse', 'HEAD']), localCommit);
});

test('divergence is blocked — no force-push, remote untouched', async () => {
  const repo = makeConfigRepo();
  // Local commit that fails to push...
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'missing.git')]);
  await persist(repo, filesFor(repo)).catch(() => {});
  // ...while the remote moves on independently.
  writeFileSync(join(repo.work, 'OTHER.md'), 'concurrent change');
  git(repo.work, ['add', 'OTHER.md']);
  git(repo.work, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'other']);
  git(repo.work, ['push', '-q', 'origin', 'HEAD:main']);
  const remoteBefore = git(repo.bare, ['rev-parse', 'HEAD']);
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', repo.bare]);
  assert.equal(await codeOf(persist(repo, filesFor(repo, '// generated v2\n'))), 'CONFIG_REPO_DIVERGED');
  assert.equal(git(repo.bare, ['rev-parse', 'HEAD']), remoteBefore, 'remote must not be overwritten');
});

test('ownership, branch and identity are enforced', async () => {
  const repo = makeConfigRepo();
  assert.equal(await codeOf(persist(repo, [{ relPath: 'README.md', content: 'x' }])), 'PATH_VIOLATION');
  assert.equal(await codeOf(persist(repo, filesFor(repo), { branch: 'other' })), 'CONFIG_REPO_UNAVAILABLE');
  assert.equal(await codeOf(persist(repo, filesFor(repo), { expectedRemote: 'git@github.com:evil/repo.git' })), 'CONFIG_REPO_UNAVAILABLE');
});

test('RTF (excluded) cannot be added to the managed PM2 set', () => {
  const repo = makeConfigRepo();
  const { manifest } = loadManifest(repo.checkout);
  assert.throws(() => upsertPm2Entry(manifest, 'rtf-web', 'rtf-web.config.js'), (e) => e.code === 'FORBIDDEN');
});
