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

// ── Disabled write surface (Stage 3+) ────────────────────────────────────────
function disabled(op) {
  return () => {
    throw new AppError('NOT_IMPLEMENTED', `Config Repo operation '${op}' is disabled in Stage 2`);
  };
}

export const writeConfig = disabled('writeConfig');
export const commit = disabled('commit');
export const push = disabled('push');
export const reconcile = disabled('reconcile');

export const _internal = { MANIFEST_REL };
