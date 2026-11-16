// Application Git synchronization: clone on first Build, then fetch + reset to
// the requested commit (or branch tip). Fixed git argv only.
//
// Deliberately NO `git clean -fd`: untracked runtime files an app may have
// written in its deployment directory are left alone. (Tracked files are reset
// to the commit — apps with runtime-mutable data in tracked files must move
// that data to persistent storage before production; noted in the handoff.)

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../../shared/errors.js';
import { run, tail } from './exec.js';

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

async function git(args, cwd) {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) {
    throw new AppError('GIT_FAILED', `git ${args[0]} failed`, { output: tail(r.stderr || r.stdout) });
  }
  return r.stdout.trim();
}

/**
 * @param {object} p
 * @param {string} p.remoteUrl repository URL to sync from
 * @param {string} p.branch configured branch
 * @param {string} p.dir absolute, already-validated deployment directory
 * @param {string} [p.commit] exact commit to deploy (must be on the branch)
 * @returns {Promise<{revision:string, cloned:boolean}>}
 */
export async function syncRepository({ remoteUrl, branch, dir, commit }) {
  if (!BRANCH_RE.test(branch)) throw new AppError('VALIDATION_FAILED', 'Invalid branch name');
  if (commit !== undefined && !SHA_RE.test(commit)) throw new AppError('VALIDATION_FAILED', 'Invalid commit');

  let cloned = false;
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), { recursive: true });
    await git(['clone', '--branch', branch, '--single-branch', '--', remoteUrl, dir]);
    cloned = true;
  }

  await git(['-C', dir, 'fetch', 'origin', branch]);
  const target = commit || `origin/${branch}`;

  if (commit) {
    // The requested commit must exist and belong to the configured branch.
    const exists = await run('git', ['-C', dir, 'cat-file', '-e', `${commit}^{commit}`]);
    if (exists.code !== 0) throw new AppError('GIT_FAILED', 'Requested commit not found on remote');
    const onBranch = await run('git', ['-C', dir, 'merge-base', '--is-ancestor', commit, `origin/${branch}`]);
    if (onBranch.code !== 0) throw new AppError('VALIDATION_FAILED', 'Requested commit is not on the configured branch');
  }

  // Never throw away work an app has not pushed yet. Apps such as minis and
  // minis-private write tracked files in their own checkout and commit/push them
  // a moment later; `reset --hard` in that window would silently discard them
  // (and would also drop local commits whose push failed). Fail visibly instead;
  // a retry after the app has pushed succeeds. (Untracked files are never
  // touched by reset, so they are not a reason to refuse.)
  if (!cloned) {
    // Porcelain lines are "XY path"; never trim the start (a leading space is part of XY).
    const dirty = (await run('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'])).stdout
      .split('\n')
      .filter((l) => l.trim());
    if (dirty.length) {
      throw new AppError('CONFLICT', 'Deployment checkout has uncommitted changes to tracked files; refusing to reset (they would be lost). Retry after the app has pushed them.', {
        paths: dirty.map((l) => l.slice(3)).slice(0, 20)
      });
    }
    const ahead = await run('git', ['-C', dir, 'rev-list', '--count', `origin/${branch}..HEAD`]);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) {
      throw new AppError('CONFLICT', 'Deployment checkout has local commits that are not on the remote yet; refusing to reset (they would be discarded). Retry after the app has pushed them.', {
        unpushedCommits: Number(ahead.stdout.trim())
      });
    }
  }

  await git(['-C', dir, 'reset', '--hard', target]);
  const revision = await git(['-C', dir, 'rev-parse', 'HEAD']);
  return { revision, cloned };
}
