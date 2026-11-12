// Config Repo adapter (Manage/Argus side) — READ-ONLY in Stage 2.
//
// Responsibilities implemented now:
//   - locate the Config Repo checkout from configuration (never a hardcoded path);
//   - parse + schema-version-validate the manifest;
//   - resolve owned PM2/Nginx file paths with containment + symlink-escape checks;
//   - expose a sanitized read-only inspection.
//
// Write/commit/push/reconcile are DEFINED but DISABLED — they throw
// NOT_IMPLEMENTED. Enabling them is Stage 3+ and requires explicit authorization.

import { resolve, join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { validateVersioned } from '../schemas/index.js';
import { resolveWithinRoot } from '../validation/paths.js';
import { run, tail } from '../exec.js';

const MANIFEST_REL = 'infrastructure/config/manifest.json';

/**
 * Resolve the Config Repo root to an absolute path.
 * @param {string} configuredRoot e.g. config.configRepoRoot
 * @param {string} [base] base to resolve a relative root against (default cwd)
 */
export function resolveConfigRepoRoot(configuredRoot, base = process.cwd()) {
  if (typeof configuredRoot !== 'string' || configuredRoot.trim() === '') {
    throw new AppError('CONFIG_INVALID', 'Config Repo root is not configured');
  }
  return resolve(base, configuredRoot);
}

export function manifestPath(root) {
  return join(root, MANIFEST_REL);
}

/**
 * Load + validate the Config Repo manifest. Read-only.
 * @returns {{ root: string, manifest: object }}
 */
export function loadManifest(root) {
  const mPath = manifestPath(root);
  if (!existsSync(root)) {
    throw new AppError('CONFIG_REPO_UNAVAILABLE', 'Config Repo checkout not found');
  }
  if (!existsSync(mPath)) {
    throw new AppError('CONFIG_REPO_UNAVAILABLE', 'Config Repo manifest not found');
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(mPath, 'utf8'));
  } catch {
    throw new AppError('INVALID_MANIFEST', 'Config Repo manifest is not valid JSON');
  }

  const { valid, errors } = validateVersioned('configRepoManifest', parsed);
  if (!valid) {
    const versionErr = errors.find((e) => e.keyword === 'version');
    if (versionErr) {
      throw new AppError('UNSUPPORTED_SCHEMA_VERSION', 'Unsupported manifest schema version', {
        schemaVersion: parsed && parsed.schemaVersion
      });
    }
    throw new AppError('INVALID_MANIFEST', 'Config Repo manifest failed validation', { errors });
  }

  return { root, manifest: parsed };
}

/** Resolve an owned PM2 ecosystem file path, containment-checked. */
export function resolvePm2File(root, manifest, file) {
  const base = resolve(root, manifest.configRoots.pm2);
  return resolveWithinRoot(base, file, { allowedExtensions: ['.js'] });
}

/** Resolve an owned Nginx config file path, containment-checked. */
export function resolveNginxFile(root, manifest, file) {
  const base = resolve(root, manifest.configRoots.nginx);
  return resolveWithinRoot(base, file, { allowedExtensions: ['.conf'] });
}

/** Sanitized, read-only view of what the Config Repo declares. */
export function inspect(root) {
  const { manifest } = loadManifest(root);
  return {
    repository: manifest.repository,
    branch: manifest.branch,
    revision: manifest.revision ?? null,
    pm2: (manifest.pm2 || []).map((p) => ({
      application: p.application,
      file: p.file ?? null,
      managedByArgus: p.managedByArgus,
      status: p.status || (p.file ? 'generated' : 'pending')
    })),
    nginx: (manifest.nginx || []).map((n) => ({ host: n.host, file: n.file ?? null, owner: n.owner })),
    excluded: manifest.excluded || []
  };
}

// ── Manifest helpers ─────────────────────────────────────────────────────────
export function renderManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** Return a new manifest with the application's PM2 entry set to `file` (generated). */
export function upsertPm2Entry(manifest, application, file) {
  if ((manifest.excluded || []).includes(application)) {
    throw new AppError('FORBIDDEN', 'Application is excluded from the Argus-managed set', { application });
  }
  const pm2 = [...(manifest.pm2 || [])];
  const idx = pm2.findIndex((p) => p.application === application);
  const entry = { application, file, managedByArgus: true, status: 'generated' };
  if (idx === -1) pm2.push(entry);
  else pm2[idx] = entry;
  const next = { ...manifest, pm2 };
  const { valid, errors } = validateVersioned('configRepoManifest', next);
  if (!valid) throw new AppError('INVALID_MANIFEST', 'Updated manifest failed validation', { errors });
  return next;
}

// ── Safe write workflow (Stage 3+4) ──────────────────────────────────────────
//
// locate → verify identity/branch/clean tree → infra lock → fetch + check remote
// advancement → write ONLY operation-owned paths → stage exact paths (never
// `git add .`) → commit only if content changed → push (never force) →
// read back from the remote branch + hash-verify → release lock.

async function git(root, args, { allowFail = false } = {}) {
  const r = await run('git', ['-C', root, ...args]);
  if (r.code !== 0 && !allowFail) {
    throw new AppError('GIT_FAILED', `git ${args[0]} failed`, { output: tail(r.stderr || r.stdout) });
  }
  return r;
}

const sha = (s) => createHash('sha256').update(String(s).replace(/\r\n/g, '\n')).digest('hex');

function assertOwnedPath(manifest, relPath) {
  const norm = String(relPath).replace(/\\/g, '/');
  const roots = [manifest.configRoots.pm2, manifest.configRoots.nginx].map((r) => r.replace(/\/+$/, '') + '/');
  if (norm !== MANIFEST_REL && !roots.some((r) => norm.startsWith(r))) {
    throw new AppError('PATH_VIOLATION', 'Path is not owned by the Config Repo manifest', { path: norm });
  }
  return norm;
}

/**
 * @param {object} p
 * @param {string} p.root Config Repo checkout (absolute)
 * @param {string} p.branch branch this checkout must be on
 * @param {Array<{relPath:string, content:string}>} p.files operation-owned files
 * @param {string} p.message commit message (no secrets)
 * @param {{acquire:Function}} p.lock infrastructure lock
 * @param {{name:string,email:string}} [p.author]
 * @param {string} [p.expectedRemote] origin URL this checkout must have
 *   (default: the manifest's repository identity)
 * @returns {Promise<{changed:boolean, commit:string, pushed:boolean, readBack:Array<{relPath:string, sha256:string}>}>}
 */
export async function persistOwnedFiles({ root, branch, files, message, lock, expectedRemote, author = { name: 'argus', email: 'argus@localhost' } }) {
  const release = await lock.acquire(60_000);
  try {
    const { manifest } = loadManifest(root);

    // 1. Identity + branch.
    const remote = (await git(root, ['remote', 'get-url', 'origin'])).stdout.trim();
    const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (current !== branch) {
      throw new AppError('CONFIG_REPO_UNAVAILABLE', 'Config Repo checkout is on an unexpected branch', { expected: branch, actual: current });
    }
    const normRemote = (u) => String(u).replace(/\\/g, '/').replace(/\/+$/, '');
    if (normRemote(remote) !== normRemote(expectedRemote || manifest.repository)) {
      throw new AppError('CONFIG_REPO_UNAVAILABLE', 'Config Repo remote does not match the expected identity');
    }

    // 2. Clean working tree — never capture unrelated local changes.
    const status = (await git(root, ['status', '--porcelain'])).stdout.trim();
    if (status) {
      throw new AppError('CONFIG_REPO_DIRTY', 'Config Repo has unexpected local changes; refusing to write', {
        paths: status.split('\n').map((l) => l.slice(3)).slice(0, 20)
      });
    }

    // 3. Remote advancement / divergence before mutating.
    await git(root, ['fetch', 'origin', branch]);
    const local = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const upstream = (await git(root, ['rev-parse', `origin/${branch}`])).stdout.trim();
    if (local !== upstream) {
      const localBehind = (await git(root, ['merge-base', '--is-ancestor', local, upstream], { allowFail: true })).code === 0;
      const localAhead = (await git(root, ['merge-base', '--is-ancestor', upstream, local], { allowFail: true })).code === 0;
      if (localBehind) {
        await git(root, ['merge', '--ff-only', `origin/${branch}`]);
      } else if (!localAhead) {
        throw new AppError('CONFIG_REPO_DIVERGED', 'Config Repo diverged from its remote; resolve explicitly (no force-push)', {
          local,
          remote: upstream
        });
      }
      // localAhead: an earlier commit was not pushed yet — the push below retries it.
    }

    // 4. Write only operation-owned paths (containment-checked).
    const rels = files.map((f) => assertOwnedPath(manifest, f.relPath));
    files.forEach((f, i) => {
      const abs = resolveWithinRoot(root, rels[i]);
      writeFileSync(abs, f.content.replace(/\r\n/g, '\n'));
    });

    // 5. Stage exactly these paths; commit only on a real content change.
    await git(root, ['add', '--', ...rels]);
    const diff = await git(root, ['diff', '--cached', '--quiet'], { allowFail: true });
    const changed = diff.code === 1;
    if (changed) {
      await git(root, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', message]);
    }

    // 6. Push anything not yet on the remote. Never force.
    const ahead = Number((await git(root, ['rev-list', '--count', `origin/${branch}..HEAD`])).stdout.trim());
    let pushed = false;
    if (ahead > 0) {
      const p = await git(root, ['push', 'origin', `HEAD:${branch}`], { allowFail: true });
      if (p.code !== 0) {
        const out = tail(p.stderr || p.stdout);
        if (/non-fast-forward|rejected|fetch first/i.test(out)) {
          throw new AppError('CONFIG_REPO_DIVERGED', 'Push rejected: remote advanced; resolve explicitly (no force-push)', { output: out });
        }
        throw new AppError('GIT_FAILED', 'Config Repo push failed; commit kept locally and retryable', {
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
      const got = sha(shown.stdout);
      const want = sha(files[i].content);
      if (got !== want) {
        throw new AppError('CONFIG_REPO_DIVERGED', 'Read-back content does not match what was written', { path: rels[i] });
      }
      readBack.push({ relPath: rels[i], sha256: got, content: shown.stdout });
    }

    const commitSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    return { changed, commit: commitSha, pushed, readBack };
  } finally {
    release();
  }
}

// Config Repo has no "reconcile" of its own — PM2 reconciliation is an Argus
// operation against the read-back desired config.
export function reconcile() {
  throw new AppError('NOT_IMPLEMENTED', 'Config Repo does not reconcile; use the Argus pm2.reconcile operation');
}

export const _internal = { MANIFEST_REL };
