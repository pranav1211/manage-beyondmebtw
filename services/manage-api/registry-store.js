// Manage-owned application registry, stored in the private bmb-data repo at
// registry/applications.json. Manage is the ONLY writer. Writes go through the
// shared DataRepo (same Git lock, journal, exact-path commit, push, read-back
// as canonical data), serialized on the "registry" resource lock, so registry
// and data writes can never race on the checkout. A failed push leaves the
// change committed locally and reported as pending/retryable — never as saved.
//
// The registry is a separately protected operational resource: it is not in
// the catalog and is never exposed through the generic resource API.

import { join, resolve } from 'node:path';
import { AppError } from '../../shared/errors.js';
import { validateRegistryEntry } from '../../shared/schemas/index.js';
import { createDataRepo } from '../../shared/data/data-repo.js';
import { readTextOrNull } from '../../shared/data/durable.js';

export const REGISTRY_REL = 'registry/applications.json';
const LOCK_KEY = '@registry';

/**
 * @param {object} p
 * @param {object} [p.dataRepo] shared DataRepo (production wiring)
 * @param {string} [p.root] bmb-data checkout (when no dataRepo is given)
 * @param {string} [p.branch]
 * @param {string} [p.expectedRemote]
 * @param {string} [p.stateRoot] runtime state dir (default: sibling of the checkout)
 */
export function createRegistryStore({ dataRepo, root, branch = 'main', expectedRemote, stateRoot } = {}) {
  const repo =
    dataRepo ||
    createDataRepo({
      root,
      branch,
      expectedRemote,
      stateRoot: stateRoot || `${resolve(root)}.manage-state`
    });
  const path = join(repo.root, REGISTRY_REL);

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
    const text = readTextOrNull(path);
    if (text === null) return [];
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new AppError('REGISTRY_INVALID', 'Registry file is not valid JSON');
    }
    if (!doc || !Array.isArray(doc.applications)) throw new AppError('REGISTRY_INVALID', 'Registry must contain an "applications" array');
    validateAll(doc.applications);
    return doc.applications;
  }

  // Stage 5 response shape, preserved: { committed, pushed, commit, pending } (+ operationId/status).
  function shape(op) {
    if (op.status === 'blocked' || op.status === 'failed') {
      throw new AppError(op.lastError && op.lastError.code ? op.lastError.code : 'OPERATION_FAILED', op.lastError ? op.lastError.message : 'Registry write failed', {
        operationId: op.operationId,
        status: op.status
      });
    }
    return {
      operationId: op.operationId,
      status: op.status,
      committed: op.status !== 'noop' && Boolean(op.commit),
      pushed: op.status === 'succeeded',
      commit: op.commit || null,
      pending: op.status === 'pending-push',
      ...(op.status === 'pending-push' && op.lastError ? { error: { code: op.lastError.code, message: op.lastError.message } } : {})
    };
  }

  async function write(applications, message) {
    validateAll(applications);
    const content = JSON.stringify({ applications }, null, 2) + '\n';
    const op = await repo.mutate({
      action: 'registry.update',
      keys: ['registry'],
      changes: [{ relPath: REGISTRY_REL, content }],
      message,
      validate: (_rel, text) => {
        const doc = JSON.parse(text);
        if (!doc || !Array.isArray(doc.applications)) throw new AppError('VALIDATION_FAILED', 'Registry must contain an "applications" array');
        validateAll(doc.applications);
      }
    });
    return shape(op);
  }

  const locked = (fn) => repo.resourceLocks.withLocks([LOCK_KEY], fn);

  return Object.freeze({
    source: { repository: expectedRemote || null, path: REGISTRY_REL, branch: repo.branch },
    read,
    get: (application) => read().find((e) => e.application === application) || null,

    create: (entry) =>
      locked(async () => {
        const apps = read();
        if (apps.some((e) => e.application === entry.application)) {
          throw new AppError('CONFLICT', 'An application with this identity already exists', { application: entry.application });
        }
        return { entry, persistence: await write([...apps, entry], `manage: register ${entry.application}`) };
      }),

    replace: (application, entry) =>
      locked(async () => {
        if (entry.application !== application) throw new AppError('VALIDATION_FAILED', 'Application identity cannot be changed');
        const apps = read();
        const i = apps.findIndex((e) => e.application === application);
        if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Application is not registered');
        const next = [...apps];
        next[i] = entry;
        return { entry, persistence: await write(next, `manage: update ${application}`) };
      }),

    setEnabled: (application, enabled) =>
      locked(async () => {
        if (typeof enabled !== 'boolean') throw new AppError('VALIDATION_FAILED', '"enabled" must be a boolean');
        const apps = read();
        const i = apps.findIndex((e) => e.application === application);
        if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Application is not registered');
        const next = [...apps];
        next[i] = { ...apps[i], enabled };
        return { entry: next[i], persistence: await write(next, `manage: ${enabled ? 'enable' : 'disable'} ${application}`) };
      }),

    /** Push any pending registry/data commits (Stage 5 compatible). */
    async retryPush() {
      const results = await repo.retryPending();
      const last = results[results.length - 1];
      if (!last) return { persistence: { committed: false, pushed: false, commit: null, pending: false, status: 'noop' } };
      return { persistence: shape(last), retried: results.map((r) => ({ operationId: r.operationId, status: r.status })) };
    }
  });
}
