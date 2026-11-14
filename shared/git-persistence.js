// Generic scoped Git persistence for Manage-owned special repositories
// (bmb-infrastructure Config Repo, bmb-data). Same guarantees for both:
//
//   lock → verify remote identity + branch + clean tree → fetch; fast-forward
//   when the remote advanced cleanly, block on divergence → write ONLY allowed
//   paths, atomically (tmp + rename) → stage exact paths (never `git add .`)
//   → commit only on a real change → push without force → read each file back
//   from the REMOTE branch and verify its SHA-256 → release lock.
//
// Supports an empty ("unborn") repository: the first commit creates the branch.
// Error codes are `${codePrefix}_UNAVAILABLE | _DIRTY | _DIVERGED`, plus
// GIT_FAILED (retryable: true) for transport failures after a local commit.

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
import { resolveWithinRoot } from './validation/paths.js';
import { run, tail } from './exec.js';

async function git(root, args, { allowFail = false } = {}) {
  const r = await run('git', ['-C', root, ...args]);
  if (r.code !== 0 && !allowFail) {
    throw new AppError('GIT_FAILED', `git ${args[0]} failed`, { output: tail(r.stderr || r.stdout) });
  }
  return r;
}

export const sha256Text = (s) => createHash('sha256').update(String(s).replace(/\r\n/g, '\n')).digest('hex');

const normRemote = (u) => String(u).replace(/\\/g, '/').replace(/\/+$/, '');

function assertAllowed(relPath, allowedPaths) {
  const norm = String(relPath).replace(/\\/g, '/');
  const ok = allowedPaths.some((a) => (a.endsWith('/') ? norm.startsWith(a) : norm === a));
  if (!ok) throw new AppError('PATH_VIOLATION', 'Path is not owned by this repository workflow', { path: norm });
  return norm;
}

function atomicWrite(abs, content) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content.replace(/\r\n/g, '\n'));
  renameSync(tmp, abs);
}

/**
 * @param {object} p
 * @param {string} p.root absolute checkout path
 * @param {string} p.branch branch the checkout must be on
 * @param {string} p.expectedRemote origin URL the checkout must have
 * @param {string[]} p.allowedPaths exact relative files, or prefixes ending in '/'
 * @param {Array<{relPath:string, content:string}>} p.files
 * @param {string} p.message commit message (no secrets)
 * @param {{acquire:Function}} p.lock
 * @param {'CONFIG_REPO'|'DATA_REPO'} p.codePrefix
 * @param {{name:string,email:string}} [p.author]
 */
export async function persistScopedFiles({ root, branch, expectedRemote, allowedPaths, files, message, lock, codePrefix, author }) {
  const who = author || { name: 'manage', email: 'manage@localhost' };
  const release = await lock.acquire(60_000);
  try {
    // 1. Identity + branch (works on an unborn branch too).
    const remote = (await git(root, ['remote', 'get-url', 'origin'])).stdout.trim();
    if (normRemote(remote) !== normRemote(expectedRemote)) {
      throw new AppError(`${codePrefix}_UNAVAILABLE`, 'Repository remote does not match the expected identity');
    }
    const current = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    if (current !== branch) {
      throw new AppError(`${codePrefix}_UNAVAILABLE`, 'Checkout is on an unexpected branch', { expected: branch, actual: current });
    }

    // 2. Clean working tree — never capture unrelated local changes.
    const status = (await git(root, ['status', '--porcelain'])).stdout.trim();
    if (status) {
      throw new AppError(`${codePrefix}_DIRTY`, 'Repository has unexpected local changes; refusing to write', {
        paths: status.split('\n').map((l) => l.slice(3)).slice(0, 20)
      });
    }

    // 3. Remote state before mutating.
    const remoteHasBranch = (await git(root, ['ls-remote', '--heads', 'origin', branch])).stdout.trim() !== '';
    let localUnborn = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })).code !== 0;
    if (remoteHasBranch) {
      await git(root, ['fetch', 'origin', branch]);
      if (localUnborn) {
        await git(root, ['checkout', '-q', '-B', branch, `origin/${branch}`]);
        localUnborn = false;
      }
      const local = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
      const upstream = (await git(root, ['rev-parse', `origin/${branch}`])).stdout.trim();
      if (local !== upstream) {
        const behind = (await git(root, ['merge-base', '--is-ancestor', local, upstream], { allowFail: true })).code === 0;
        const ahead = (await git(root, ['merge-base', '--is-ancestor', upstream, local], { allowFail: true })).code === 0;
        if (behind) {
          await git(root, ['merge', '--ff-only', `origin/${branch}`]);
        } else if (!ahead) {
          throw new AppError(`${codePrefix}_DIVERGED`, 'Repository diverged from its remote; resolve explicitly (no force-push)', { local, remote: upstream });
        }
        // ahead: an earlier commit was not pushed — the push below retries it.
      }
    }

    // 4. Write only allowed paths, atomically, containment-checked.
    const rels = files.map((f) => assertAllowed(f.relPath, allowedPaths));
    files.forEach((f, i) => atomicWrite(resolveWithinRoot(root, rels[i]), f.content));

    // 5. Stage exactly these paths; commit only on a real change.
    await git(root, ['add', '--', ...rels]);
    const changed = (await git(root, ['diff', '--cached', '--quiet'], { allowFail: true })).code === 1;
    if (changed) {
      await git(root, ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, 'commit', '-q', '-m', message]);
    }

    // 6. Push anything not yet on the remote. Never force.
    const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })).code === 0;
    const toPush = !hasHead
      ? 0
      : remoteHasBranch
        ? Number((await git(root, ['rev-list', '--count', `origin/${branch}..HEAD`])).stdout.trim())
        : Number((await git(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());
    let pushed = false;
    if (toPush > 0) {
      const p = await git(root, ['push', 'origin', `HEAD:refs/heads/${branch}`], { allowFail: true });
      if (p.code !== 0) {
        const out = tail(p.stderr || p.stdout);
        if (/non-fast-forward|rejected|fetch first/i.test(out)) {
          throw new AppError(`${codePrefix}_DIVERGED`, 'Push rejected: remote advanced; resolve explicitly (no force-push)', { output: out });
        }
        throw new AppError('GIT_FAILED', 'Push failed; commit kept locally and retryable', {
          retryable: true,
          localCommit: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(),
          output: out
        });
      }
      pushed = true;
    }

    // 7. Read back from the REMOTE branch and verify content hashes.
    await git(root, ['fetch', 'origin', branch]);
    const readBack = [];
    for (let i = 0; i < files.length; i++) {
      const shown = await git(root, ['show', `origin/${branch}:${rels[i]}`]);
      const got = sha256Text(shown.stdout);
      if (got !== sha256Text(files[i].content)) {
        throw new AppError(`${codePrefix}_DIVERGED`, 'Read-back content does not match what was written', { path: rels[i] });
      }
      readBack.push({ relPath: rels[i], sha256: got, content: shown.stdout });
    }

    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    return { changed, commit, pushed, readBack };
  } finally {
    release();
  }
}
