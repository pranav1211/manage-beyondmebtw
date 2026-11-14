// DataRepo: atomic journaled mutations, Git persistence safety, fault injection
// + startup recovery, locks. Real Git against local bare origins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { git, tmp } from '../helpers/argus-fixtures.js';
import { makeSeededDataRepo, openRepo, devCommit, commitCount, j } from '../helpers/data-fixtures.js';
import { SimulatedCrash } from '../../shared/data/data-repo.js';
import { GitLock } from '../../shared/data/git-lock.js';
import { sha256 } from '../../shared/data/durable.js';

const A = 'data/notes/notes.json';
const B = 'data/list/list.json';
const docA = j({ items: [{ id: 'a', text: 'changed' }] });
const docB = j([{ id: 1 }, { id: 2 }, { id: 3 }]);
const read = (repo, rel) => readFileSync(join(repo.checkout, rel), 'utf8').replace(/\r\n/g, '\n');
const remoteFile = (repo, rel) => git(repo.bare, ['show', `main:${rel}`]) + '\n';
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

test('single-file mutation: exact-path commit, pushed, remote read-back, history record', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  const before = commitCount(repo);
  const op = await dr.mutate({ action: 'resource.replace', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'manage: replace notes' });
  assert.equal(op.status, 'succeeded');
  assert.equal(op.phase, 'verified');
  assert.equal(op.readBackVerified, true);
  assert.deepEqual(op.committedPaths, [A]);
  assert.equal(commitCount(repo), before + 1);
  assert.equal(remoteFile(repo, A), docA);
  assert.match(git(repo.bare, ['log', '-1', '--format=%B', 'main']), new RegExp(`Operation: ${op.operationId}`));
  assert.equal(op.changes[0].after, sha256(docA));
  const rec = dr.getOp(op.operationId);
  assert.equal(rec.status, 'succeeded');
  assert.ok(!JSON.stringify(rec).includes('changed'), 'history holds hashes, not payloads');
  assert.deepEqual(readdirSync(join(repo.stateRoot, 'journal')), [], 'journal cleaned after commit');
});

test('no-op mutation creates no commit', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  const before = commitCount(repo);
  const op = await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: read(repo, A) }], message: 'noop' });
  assert.equal(op.status, 'noop');
  assert.equal(commitCount(repo), before);
});

test('multi-file mutation (incl. delete) is one commit; invalid content leaves files byte-identical', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  const op = await dr.mutate({
    action: 'resource.transaction',
    keys: ['notes', 'list', 'private'],
    changes: [{ relPath: A, content: docA }, { relPath: B, content: docB }, { relPath: 'data/private/secret-notes.json', content: null }],
    message: 'tx'
  });
  assert.equal(op.status, 'succeeded');
  assert.deepEqual(op.committedPaths, [B, A, 'data/private/secret-notes.json'].sort());
  assert.equal(existsSync(join(repo.checkout, 'data/private/secret-notes.json')), false);

  const snapA = read(repo, A);
  const count = commitCount(repo);
  await assert.rejects(
    dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: '{"broken"' }], message: 'bad', validate: (_r, c) => JSON.parse(c) }),
    (e) => Boolean(e.details && e.details.operationId)
  );
  assert.equal(read(repo, A), snapA, 'original untouched');
  assert.equal(commitCount(repo), count);
  assert.equal(git(repo.checkout, ['status', '--porcelain']), '');
});

test('paths outside the owned prefixes, traversal and absolute paths are refused', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  for (const rel of ['catalog/catalog.json', '../escape.json', 'data/../catalog/catalog.json', '/etc/passwd', 'data/%2e%2e/x.json']) {
    assert.ok(await codeOf(dr.mutate({ action: 'x', keys: ['k'], changes: [{ relPath: rel, content: '{}' }], message: 'm' })), rel);
  }
});

test('dirty checkout and wrong remote/branch block safely (no reset, no write)', async () => {
  const repo = makeSeededDataRepo();
  writeFileSync(join(repo.checkout, 'stray.txt'), 'developer scratch');
  assert.equal(await codeOf(openRepo(repo).mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm' })), 'DATA_REPO_DIRTY');
  assert.ok(existsSync(join(repo.checkout, 'stray.txt')), 'never cleaned automatically');

  const r2 = makeSeededDataRepo();
  assert.equal(await codeOf(openRepo(r2, { expectedRemote: 'git@github.com:evil/repo.git' }).mutate({ action: 'x', keys: ['n'], changes: [{ relPath: A, content: docA }], message: 'm' })), 'DATA_REPO_UNAVAILABLE');
  assert.equal(await codeOf(openRepo(r2, { branch: 'release' }).mutate({ action: 'x', keys: ['n'], changes: [{ relPath: A, content: docA }], message: 'm' })), 'DATA_REPO_UNAVAILABLE');
});

test('remote advanced cleanly: fast-forward, then commit on top', async () => {
  const repo = makeSeededDataRepo();
  const devHead = devCommit(repo, { 'data/list/list.json': docB });
  const op = await openRepo(repo).mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm' });
  assert.equal(op.status, 'succeeded');
  assert.equal(git(repo.bare, ['rev-parse', 'main~1']), devHead, 'built on the developer commit');
  assert.equal(remoteFile(repo, B), docB);
});

test('divergence blocks; nothing is force-pushed; remote unchanged', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'x.git')]);
  const pending = await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm' });
  assert.equal(pending.status, 'pending-push');
  const devHead = devCommit(repo, { 'data/list/list.json': docB }); // remote advances meanwhile
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', repo.bare]);
  const retried = await dr.retry(pending.operationId);
  assert.equal(retried.status, 'blocked');
  assert.equal(retried.lastError.code, 'DATA_REPO_DIVERGED');
  assert.equal(git(repo.bare, ['rev-parse', 'main']), devHead, 'remote untouched — no force-push');
});

test('remote outage: commit durable + pending-push; explicit retry is idempotent (same commit, no duplicate)', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'x.git')]);
  const op = await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm' });
  assert.equal(op.status, 'pending-push');
  assert.ok(op.commit);
  assert.equal(op.pushAttempts, 3, 'bounded automatic retries');
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', repo.bare]);
  const before = Number(git(repo.checkout, ['rev-list', '--count', 'HEAD']));
  const r1 = await dr.retry(op.operationId);
  const r2 = await dr.retry(op.operationId);
  assert.equal(r1.status, 'succeeded');
  assert.equal(r2.replayed, true);
  assert.equal(git(repo.bare, ['rev-parse', 'main']), op.commit, 'the same commit');
  assert.equal(Number(git(repo.checkout, ['rev-list', '--count', 'HEAD'])), before);
});

test('a later push settles earlier pending ops (their commits are verified on the remote)', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'x.git')]);
  const first = await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm1' });
  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', repo.bare]);
  const second = await dr.mutate({ action: 'x', keys: ['list'], changes: [{ relPath: B, content: docB }], message: 'm2' });
  assert.equal(second.status, 'succeeded');
  const settled = dr.getOp(first.operationId);
  assert.equal(settled.status, 'succeeded');
  assert.equal(settled.pushedWith, second.operationId);
});

// Every meaningful phase, with a 2-file change. After the simulated crash a NEW
// DataRepo (= process restart) recovers. Must end in a valid pre- or
// post-operation state with an accurate record and no duplicate commit.
const POINTS = ['staging', 'temp-written', 'validated', 'prepared', 'applying', 'applied', 'staged', 'committed', 'pushing', 'push-done'];
const PRE = new Set(['staging', 'temp-written', 'validated']);

for (const point of POINTS) {
  test(`fault injection: crash at "${point}" recovers to a valid ${PRE.has(point) ? 'pre' : 'post'}-operation state`, async () => {
    const repo = makeSeededDataRepo();
    const beforeA = read(repo, A);
    const beforeB = read(repo, B);
    const remoteBefore = commitCount(repo);
    let fired = false;
    const crashing = openRepo(repo, {
      faults: (p) => {
        if (p === point && !fired) {
          fired = true;
          throw new SimulatedCrash(p);
        }
      }
    });
    await assert.rejects(
      crashing.mutate({ action: 'tx', keys: ['notes', 'list'], changes: [{ relPath: A, content: docA }, { relPath: B, content: docB }], message: 'tx' }),
      SimulatedCrash
    );
    const opId = readdirSync(join(repo.stateRoot, 'ops')).map((f) => f.replace('.json', ''))[0];

    const restarted = openRepo(repo);
    const outcomes = await restarted.recover();
    assert.equal(outcomes.length, 1);
    const rec = restarted.getOp(opId);
    const a = read(repo, A);
    const b = read(repo, B);
    if (PRE.has(point)) {
      assert.equal(rec.status, 'failed');
      assert.equal(a, beforeA);
      assert.equal(b, beforeB);
      assert.equal(commitCount(repo), remoteBefore, 'no commit');
    } else {
      assert.equal(rec.status, 'succeeded', JSON.stringify(rec.lastError));
      assert.equal(a, docA);
      assert.equal(b, docB);
      assert.equal(commitCount(repo), remoteBefore + 1, 'exactly one commit (no duplicate)');
      assert.equal(remoteFile(repo, A), docA);
      assert.equal(remoteFile(repo, B), docB);
      assert.equal(git(repo.bare, ['log', '--format=%B', '--fixed-strings', `--grep=Operation: ${opId}`, 'main']).split('Operation:').length - 1, 1);
    }
    assert.ok(rec.recovery.length >= 1, 'recovery action recorded');
    assert.equal(git(repo.checkout, ['status', '--porcelain', '--untracked-files=all']), '', 'clean tree');
    assert.deepEqual(readdirSync(join(repo.stateRoot, 'journal')), [], 'journal cleaned');
    assert.deepEqual(await restarted.recover(), [], 'recovery is idempotent');
  });
}

test('crash DURING recovery is itself recovered (no duplicate commit)', async () => {
  const repo = makeSeededDataRepo();
  const base = commitCount(repo);
  await assert.rejects(openRepo(repo, { faults: (p) => { if (p === 'applied') throw new SimulatedCrash(p); } })
    .mutate({ action: 'tx', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm' }), SimulatedCrash);
  await assert.rejects(openRepo(repo, { faults: (p) => { if (p === 'push-done') throw new SimulatedCrash(p); } }).recover(), SimulatedCrash);
  const out = await openRepo(repo).recover();
  assert.equal(out[0].status, 'succeeded');
  assert.equal(commitCount(repo), base + 1);
});

test('idempotency key: a replayed request returns the original operation, no second mutation', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  const one = await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm', idempotencyKey: 'req-1' });
  const two = await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: j({ items: [] }) }], message: 'm', idempotencyKey: 'req-1' });
  assert.equal(two.operationId, one.operationId);
  assert.equal(two.replayed, true);
  assert.equal(read(repo, A), docA);
});

test('webhook sync: fast-forward, duplicate delivery is a no-op, dirty/diverged block', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  const head = devCommit(repo, { 'data/list/list.json': docB });
  const s1 = await dr.syncFromRemote({ after: head });
  assert.equal(s1.status, 'succeeded');
  assert.equal(s1.result.to, head);
  assert.equal(read(repo, B), docB);
  const s2 = await dr.syncFromRemote({ after: head });
  assert.equal(s2.status, 'noop');
  assert.equal(s2.result.state, 'up-to-date');

  writeFileSync(join(repo.checkout, 'stray.txt'), 'x');
  assert.equal((await dr.syncFromRemote({})).status, 'blocked');
  git(repo.checkout, ['clean', '-fq']);

  git(repo.checkout, ['remote', 'set-url', '--push', 'origin', join(tmp('nowhere-'), 'x.git')]);
  await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'local' });
  devCommit(repo, { 'data/list/list.json': j([{ id: 9 }]) });
  const s3 = await dr.syncFromRemote({});
  assert.equal(s3.status, 'blocked');
  assert.equal(s3.lastError.code, 'DATA_REPO_DIVERGED');
});

test('Git lock: stale lock (dead owner) is recovered; a live owner is never stolen', async () => {
  const dir = tmp('lock-');
  const file = join(dir, 'x.lock');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: 2147483646, hostname: hostname(), nonce: 'dead', acquiredAt: 'then' }));
  const events = [];
  const lock = new GitLock(file, { onRecover: (e) => events.push(e) });
  const release = await lock.acquire(2000);
  assert.equal(events[0].action, 'stale-lock-recovered');
  release();
  assert.equal(existsSync(file), false, 'released on completion');

  // A live owner (our parent process) holds it: we wait, then time out. Never stolen.
  writeFileSync(file, JSON.stringify({ pid: process.ppid, hostname: hostname(), nonce: 'live', acquiredAt: 'now' }));
  await assert.rejects(new GitLock(file).acquire(300), (e) => e.code === 'LOCK_TIMEOUT');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).nonce, 'live');
});

test('lock is released after a failed operation', async () => {
  const repo = makeSeededDataRepo();
  const dr = openRepo(repo);
  await codeOf(dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: 'x' }], message: 'm', validate: () => { throw new Error('nope'); } }));
  assert.equal(existsSync(join(repo.stateRoot, 'bmb-data.git.lock')), false);
  const ok = await dr.mutate({ action: 'x', keys: ['notes'], changes: [{ relPath: A, content: docA }], message: 'm' });
  assert.equal(ok.status, 'succeeded');
});

test('state root inside the checkout is refused (journals never enter Git)', () => {
  const repo = makeSeededDataRepo();
  assert.throws(() => openRepo(repo, { stateRoot: join(repo.checkout, '.state') }), (e) => e.code === 'CONFIG_INVALID');
});
