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
import { readFileSync, existsSync } from 'node:fs';
import { AppError } from '../errors.js';
import { validateVersioned } from '../schemas/index.js';
import { resolveWithinRoot } from '../validation/paths.js';
import { persistScopedFiles } from '../git-persistence.js';

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

// The Config Repo's owned paths: the manifest itself + its PM2/Nginx roots.
function ownedPaths(manifest) {
  return [MANIFEST_REL, ...[manifest.configRoots.pm2, manifest.configRoots.nginx].map((r) => r.replace(/\/+$/, '') + '/')];
}

/**
 * Persist Config Repo files through the generic scoped workflow
 * (shared/git-persistence.js). Ownership = the manifest + its PM2/Nginx roots.
 *
 * @param {object} p
 * @param {string} p.root Config Repo checkout (absolute)
 * @param {string} p.branch branch this checkout must be on
 * @param {Array<{relPath:string, content:string}>} p.files operation-owned files
 * @param {string} p.message commit message (no secrets)
 * @param {{acquire:Function}} p.lock infrastructure lock
 * @param {{name:string,email:string}} [p.author]
 * @param {string} [p.expectedRemote] origin URL (default: manifest repository)
 */
export async function persistOwnedFiles({ root, branch, files, message, lock, expectedRemote, author = { name: 'argus', email: 'argus@localhost' } }) {
  const { manifest } = loadManifest(root);
  return persistScopedFiles({
    root,
    branch,
    files,
    message,
    lock,
    author,
    expectedRemote: expectedRemote || manifest.repository,
    allowedPaths: ownedPaths(manifest),
    codePrefix: 'CONFIG_REPO'
  });
}

// Config Repo has no "reconcile" of its own — PM2 reconciliation is an Argus
// operation against the read-back desired config.
export function reconcile() {
  throw new AppError('NOT_IMPLEMENTED', 'Config Repo does not reconcile; use the Argus pm2.reconcile operation');
}

export const _internal = { MANIFEST_REL };
