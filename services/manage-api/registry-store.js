// Manage-owned application registry, stored in the private bmb-data repo at
// registry/applications.json. Manage is the ONLY writer. Every change is a
// scoped commit + push through the shared workflow (atomic write, no
// `git add .`, no force-push, remote read-back). A failed push leaves the
// change committed locally and reported as pending/retryable — never as saved.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../shared/errors.js';
import { validateRegistryEntry } from '../../shared/schemas/index.js';
import { persistScopedFiles } from '../../shared/git-persistence.js';
import { Mutex } from '../argus/locks.js';

export const REGISTRY_REL = 'registry/applications.json';

export function createRegistryStore({ root, branch, expectedRemote, lock = new Mutex() }) {
  const path = join(root, REGISTRY_REL);

  function validateAll(applications) {
    const seen = new Set();
    for (const entry of applications) {
      const { valid, errors } = validateRegistryEntry(entry);
      if (!valid) throw new AppError('VALIDATION_FAILED', 'Registry entry failed validation', { application: entry && entry.application, errors });
      if (seen.has(entry.application)) throw new AppError('CONFLICT', 'Duplicate application identity', { application: entry.application });
      seen.add(entry.application);
    }
  }

  function read() {
    if (!existsSync(path)) return [];
    let doc;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new AppError('REGISTRY_INVALID', 'Registry file is not valid JSON');
    }
    if (!doc || !Array.isArray(doc.applications)) throw new AppError('REGISTRY_INVALID', 'Registry must contain an "applications" array');
    validateAll(doc.applications);
    return doc.applications;
  }

  async function write(applications, message) {
    validateAll(applications);
    const content = JSON.stringify({ applications }, null, 2) + '\n';
    try {
      const r = await persistScopedFiles({
        root,
        branch,
        expectedRemote,
        allowedPaths: ['registry/'],
        files: [{ relPath: REGISTRY_REL, content }],
        message,
        lock,
        codePrefix: 'DATA_REPO',
        author: { name: 'manage', email: 'manage@localhost' }
      });
      return { committed: r.changed, pushed: r.pushed, commit: r.commit, pending: false };
    } catch (err) {
      if (err.code === 'GIT_FAILED' && err.details && err.details.retryable) {
        // Saved + committed locally; not yet on GitHub. Visible, retryable.
        return { committed: true, pushed: false, pending: true, commit: err.details.localCommit, error: { code: err.code, message: err.message } };
      }
      throw err;
    }
  }

  return Object.freeze({
    source: { repository: expectedRemote, path: REGISTRY_REL, branch },
    read,
    get: (application) => read().find((e) => e.application === application) || null,

    async create(entry) {
      const apps = read();
      if (apps.some((e) => e.application === entry.application)) {
        throw new AppError('CONFLICT', 'An application with this identity already exists', { application: entry.application });
      }
      const next = [...apps, entry];
      return { entry, persistence: await write(next, `manage: register ${entry.application}`) };
    },

    async replace(application, entry) {
      if (entry.application !== application) throw new AppError('VALIDATION_FAILED', 'Application identity cannot be changed');
      const apps = read();
      const i = apps.findIndex((e) => e.application === application);
      if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Application is not registered');
      const next = [...apps];
      next[i] = entry;
      return { entry, persistence: await write(next, `manage: update ${application}`) };
    },

    async setEnabled(application, enabled) {
      if (typeof enabled !== 'boolean') throw new AppError('VALIDATION_FAILED', '"enabled" must be a boolean');
      const apps = read();
      const i = apps.findIndex((e) => e.application === application);
      if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Application is not registered');
      const next = [...apps];
      next[i] = { ...apps[i], enabled };
      return { entry: next[i], persistence: await write(next, `manage: ${enabled ? 'enable' : 'disable'} ${application}`) };
    },

    /** Re-run persistence with the current content (pushes any pending commit). */
    async retryPush() {
      return { persistence: await write(read(), 'manage: registry retry') };
    }
  });
}
