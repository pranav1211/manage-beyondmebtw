// Argus sync vs an app that writes into its own checkout (minis, minis-private):
// a deploy must never discard the app's not-yet-pushed work. Real Git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { syncRepository } from '../../services/argus/git-sync.js';
import { makeRepo, commitAndPush, git, tmp } from '../helpers/argus-fixtures.js';

const ID = ['-c', 'user.name=app', '-c', 'user.email=app@local'];

async function deployed() {
  const repo = makeRepo({ 'server.js': 'v1\n', 'content-private/index.enc': 'index-v1\n' });
  const dir = join(tmp('deploy-'), 'app');
  mkdirSync(join(dir, '..'), { recursive: true });
  await syncRepository({ remoteUrl: repo.bare, branch: 'main', dir });
  return { repo, dir };
}

test('the overlap: an app wrote a tracked file but has not committed yet -> deploy refuses, nothing lost', async () => {
  const { repo, dir } = await deployed();
  commitAndPush(repo, { 'server.js': 'v2\n' }, 'code change'); // a newer commit to deploy
  writeFileSync(join(dir, 'content-private/index.enc'), 'index-v2 (written by the app, push pending)\n');
  writeFileSync(join(dir, 'content-private/new-post.enc'), 'new post\n'); // untracked, also pending
  await assert.rejects(syncRepository({ remoteUrl: repo.bare, branch: 'main', dir }), (e) => e.code === 'CONFLICT' && e.details.paths.includes('content-private/index.enc'));
  assert.equal(readFileSync(join(dir, 'content-private/index.enc'), 'utf8'), 'index-v2 (written by the app, push pending)\n', 'pending write intact');
  assert.equal(readFileSync(join(dir, 'content-private/new-post.enc'), 'utf8'), 'new post\n');
  assert.equal(readFileSync(join(dir, 'server.js'), 'utf8').replace(/\r\n/g, '\n'), 'v1\n', 'checkout not half-updated');
});

test('the overlap: an app committed locally but its push failed -> deploy refuses, commit kept', async () => {
  const { repo, dir } = await deployed();
  writeFileSync(join(dir, 'content-private/index.enc'), 'index-v2\n');
  git(dir, ['add', '--', 'content-private/index.enc']);
  git(dir, [...ID, 'commit', '-q', '-m', 'app content (unpushed)']);
  const local = git(dir, ['rev-parse', 'HEAD']);
  await assert.rejects(syncRepository({ remoteUrl: repo.bare, branch: 'main', dir }), (e) => e.code === 'CONFLICT' && e.details.unpushedCommits === 1);
  assert.equal(git(dir, ['rev-parse', 'HEAD']), local, 'local commit not discarded');
});

test('once the app has pushed, the same deploy proceeds and includes its work', async () => {
  const { repo, dir } = await deployed();
  writeFileSync(join(dir, 'content-private/index.enc'), 'index-v2\n');
  git(dir, ['add', '--', 'content-private/index.enc']);
  git(dir, [...ID, 'commit', '-q', '-m', 'app content']);
  git(dir, ['push', '-q', 'origin', 'HEAD:main']); // the app's own push
  const r = await syncRepository({ remoteUrl: repo.bare, branch: 'main', dir });
  assert.equal(r.revision, git(repo.bare, ['rev-parse', 'main']));
  assert.equal(readFileSync(join(dir, 'content-private/index.enc'), 'utf8').replace(/\r\n/g, '\n'), 'index-v2\n');
});

test('untracked runtime files never block a deploy and are left alone', async () => {
  const { repo, dir } = await deployed();
  writeFileSync(join(dir, 'runtime.log'), 'log\n');
  const head = commitAndPush(repo, { 'server.js': 'v2\n' }, 'code');
  const r = await syncRepository({ remoteUrl: repo.bare, branch: 'main', dir });
  assert.equal(r.revision, head);
  assert.equal(readFileSync(join(dir, 'runtime.log'), 'utf8'), 'log\n');
});
