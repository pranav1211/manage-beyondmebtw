// Catalog-backed canonical resources in bmb-data — the data API applications
// use (with their Manage-issued token) and the dashboard uses (admin session).
//
// Principals: { kind: 'anonymous' } | { kind: 'admin' } | { kind: 'client', client }.
// Reads: public resources for anyone; private ones for the admin or a client
// whose scopes grant read (otherwise indistinguishable from unknown keys).
// Writes: admin, or a client whose scopes grant write; catalog operation
// permission + schema validation of the COMPLETE resulting document; serialized
// per resource; persisted through DataRepo (journal, exact-path commit, push,
// read-back). Invalid input never replaces the current file. Reads never touch Git.
// Collections ("f1.season" -> f1ta/{id}.json) let apps create/delete members.

import { AppError } from '../../shared/errors.js';
import { createCatalog } from '../../shared/data/catalog.js';
import { compareDataset } from '../../shared/data/compare.js';
import { sha256, readTextOrNull } from '../../shared/data/durable.js';
import { resolveWithinRoot } from '../../shared/validation/paths.js';
import { scopeAllows } from './api-clients.js';

const ITEM_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
export const ADMIN = Object.freeze({ kind: 'admin' });
export const ANONYMOUS = Object.freeze({ kind: 'anonymous' });

function hidden() {
  return new AppError('RESOURCE_NOT_FOUND', 'Unknown resource key');
}

function schemaErrors(entry) {
  return (entry.validate.errors || []).slice(0, 20).map((e) => ({ path: e.instancePath || '(root)', keyword: e.keyword, message: e.message }));
}

/** Persistence state for API responses — "saved" only when on GitHub and verified. */
export function persistenceOf(op) {
  return {
    operationId: op.operationId,
    status: op.status,
    saved: op.status === 'succeeded' || op.status === 'noop',
    phase: op.phase,
    commit: op.commit || null,
    pushed: Boolean(op.pushed) || op.status === 'succeeded',
    readBackVerified: Boolean(op.readBackVerified),
    pending: op.status === 'pending-push',
    ...(op.replayed ? { replayed: true } : {}),
    ...(op.lastError ? { error: op.lastError } : {})
  };
}

const canRead = (e, p) =>
  e.access === 'public' || p.kind === 'admin' || (p.kind === 'client' && (scopeAllows(p.client.scopes, e.key, 'read') || scopeAllows(p.client.scopes, e.key, 'write')));
const canWrite = (e, p) => p.kind === 'admin' || (p.kind === 'client' && scopeAllows(p.client.scopes, e.key, 'write'));
const actor = (p) => (p.kind === 'client' ? `client:${p.client.id}:${p.client.application}` : p.kind);

/**
 * @param {object} p
 * @param {ReturnType<import('../../shared/data/data-repo.js').createDataRepo>} p.dataRepo
 * @param {Record<string,string>} [p.sourceRoots] owner/repo -> local read-only checkout (comparison mode)
 */
export function createResourceStore({ dataRepo, sourceRoots = {} }) {
  const catalog = createCatalog(dataRepo.root);

  function readable(key, principal) {
    const e = catalog.get(key);
    if (!canRead(e, principal)) throw hidden();
    return e;
  }

  function writable(key, principal) {
    const e = catalog.get(key);
    if (!canRead(e, principal) && principal.kind !== 'client') throw hidden();
    if (e.collection && !e.collectionKey) throw new AppError('OPERATION_NOT_ALLOWED', 'Address a collection member ("<key>.<id>"), not the collection', { key: e.key });
    if (!canWrite(e, principal)) {
      throw principal.kind === 'anonymous'
        ? new AppError('UNAUTHENTICATED', 'Authentication required')
        : new AppError('FORBIDDEN', 'This token does not grant write access to this resource', { key: e.key });
    }
    if (e.format !== 'json') throw new AppError('OPERATION_NOT_ALLOWED', 'Only JSON resources are writable through this API', { key: e.key });
    return e;
  }

  function assertOp(e, op) {
    if (!e.operations.includes(op)) throw new AppError('OPERATION_NOT_ALLOWED', `Operation "${op}" is not allowed on this resource`, { key: e.key });
  }

  function loadDoc(e) {
    if (e.status === 'absent') throw new AppError('RESOURCE_NOT_FOUND', 'Resource does not exist', { key: e.key });
    if (e.status !== 'imported') throw new AppError('RESOURCE_NOT_FOUND', 'Resource is mapped but not imported yet', { key: e.key, status: e.status });
    const text = dataRepo.readText(e.relPath);
    if (text === null) throw new AppError('DATA_INTEGRITY', 'Canonical file is missing', { key: e.key, reason: 'missing' });
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new AppError('DATA_INTEGRITY', 'Canonical file is malformed', { key: e.key, reason: 'malformed' });
    }
    if (e.validate && !e.validate(doc)) {
      throw new AppError('DATA_INTEGRITY', 'Canonical file fails its schema', { key: e.key, reason: 'schema', errors: schemaErrors(e) });
    }
    return { doc, revision: sha256(text) };
  }

  function itemsArray(e, doc) {
    const arr = e.items.pointer ? doc[e.items.pointer.slice(1)] : doc;
    if (!Array.isArray(arr)) throw new AppError('DATA_INTEGRITY', 'Item container is not an array', { key: e.key, reason: 'schema' });
    return arr;
  }

  function validateDoc(e, doc) {
    if (e.validate && !e.validate(doc)) {
      throw new AppError('VALIDATION_FAILED', 'Resulting document fails the resource schema', { key: e.key, errors: schemaErrors(e) });
    }
  }

  const serialize = (doc) => JSON.stringify(doc, null, 2) + '\n';
  const validatorFor = (e) => (_rel, content) => {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Staged content is not valid JSON', { key: e.key });
    }
    validateDoc(e, parsed);
  };

  async function persist(e, action, nextDoc, { expectRevision, idempotencyKey, message, principal }) {
    if (nextDoc !== null) validateDoc(e, nextDoc);
    const op = await dataRepo.mutate({
      action,
      keys: [e.key],
      changes: [{ relPath: e.relPath, content: nextDoc === null ? null : serialize(nextDoc), ...(expectRevision !== undefined ? { expectBefore: expectRevision } : {}) }],
      message,
      validate: validatorFor(e),
      idempotencyKey,
      actor: actor(principal)
    });
    const text = dataRepo.readText(e.relPath);
    return { key: e.key, revision: text === null ? null : sha256(text), persistence: persistenceOf(op) };
  }

  const checkRevision = (current, ifRevision) => {
    if (ifRevision !== undefined && ifRevision !== null && ifRevision !== current) {
      throw new AppError('CONFLICT', 'Resource changed since it was read (revision mismatch)', { current });
    }
  };

  const assertItemId = (id) => {
    if (!ITEM_ID_RE.test(String(id))) throw new AppError('INVALID_IDENTIFIER', 'Invalid item id');
    return String(id);
  };

  /** Run fn(entry) under the resource lock with a FRESH entry (status may change while waiting). */
  const withResource = (key, principal, fn) =>
    dataRepo.resourceLocks.withLocks([writable(key, principal).key], () => fn(writable(key, principal)));

  return Object.freeze({
    catalog,

    list(principal) {
      return catalog
        .list()
        .filter((e) => canRead(e, principal) || (principal.kind === 'client' && e.collection && !e.collectionKey && scopeAllows(principal.client.scopes, `${e.key}.x`, 'read')))
        .map((e) => ({
          key: e.key,
          title: e.title || null,
          owner: e.owner || null,
          access: e.access,
          status: e.collection && !e.collectionKey ? 'collection' : e.status,
          ...(e.collectionKey ? { collection: e.collectionKey, id: e.memberId } : {}),
          format: e.format,
          operations: e.operations,
          items: e.items ? { idField: e.items.idField } : null,
          ...(principal.kind === 'admin' ? { path: e.relPath, source: e.source || null, consumers: e.consumers || [] } : {})
        }));
    },

    read(key, principal) {
      const e = readable(key, principal);
      const { doc, revision } = loadDoc(e);
      return { key: e.key, revision, data: doc };
    },

    readItem(key, id, principal) {
      const e = readable(key, principal);
      if (!e.items) throw new AppError('OPERATION_NOT_ALLOWED', 'Resource has no item-level access', { key: e.key });
      const itemId = assertItemId(id);
      const { doc, revision } = loadDoc(e);
      const item = itemsArray(e, doc).find((it) => it && String(it[e.items.idField]) === itemId);
      if (!item) throw new AppError('RESOURCE_NOT_FOUND', 'Item not found', { key: e.key });
      return { key: e.key, revision, item };
    },

    /** Replace a whole document. For an absent collection member this CREATES it (op "create"). */
    replace(key, data, { ifRevision, idempotencyKey, principal = ADMIN } = {}) {
      return withResource(key, principal, async (e) => {
        if (e.status === 'absent') {
          assertOp(e, 'create');
          if (ifRevision !== undefined && ifRevision !== null) throw new AppError('CONFLICT', 'Resource does not exist (revision given)');
          return persist(e, 'resource.create', data, { expectRevision: null, idempotencyKey, message: `manage: create ${e.key}`, principal });
        }
        assertOp(e, 'replace');
        if (e.status !== 'imported') throw new AppError('OPERATION_NOT_ALLOWED', 'Resource is not imported; writes are disabled', { key: e.key, status: e.status });
        const text = dataRepo.readText(e.relPath);
        const current = text === null ? null : sha256(text);
        checkRevision(current, ifRevision);
        return persist(e, 'resource.replace', data, { expectRevision: current, idempotencyKey, message: `manage: replace ${e.key}`, principal });
      });
    },

    /** Delete a collection member document (op "delete"). */
    remove(key, { ifRevision, idempotencyKey, principal = ADMIN } = {}) {
      return withResource(key, principal, async (e) => {
        if (!e.collectionKey) throw new AppError('OPERATION_NOT_ALLOWED', 'Only collection members can be deleted', { key: e.key });
        assertOp(e, 'delete');
        const { revision } = loadDoc(e);
        checkRevision(revision, ifRevision);
        return persist(e, 'resource.delete', null, { expectRevision: revision, idempotencyKey, message: `manage: delete ${e.key}`, principal });
      });
    },

    createItem(key, item, { ifRevision, idempotencyKey, principal = ADMIN } = {}) {
      return withResource(key, principal, async (e) => {
        assertOp(e, 'create-item');
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('VALIDATION_FAILED', 'Item must be an object');
        const id = assertItemId(item[e.items.idField]);
        const { doc, revision } = loadDoc(e);
        checkRevision(revision, ifRevision);
        const arr = itemsArray(e, doc);
        if (arr.some((it) => it && String(it[e.items.idField]) === id)) throw new AppError('CONFLICT', 'An item with this id already exists', { key: e.key });
        arr.push(item);
        return persist(e, 'resource.create-item', doc, { expectRevision: revision, idempotencyKey, message: `manage: add item to ${e.key}`, principal });
      });
    },

    updateItem(key, id, item, { ifRevision, idempotencyKey, principal = ADMIN } = {}) {
      return withResource(key, principal, async (e) => {
        assertOp(e, 'update-item');
        const itemId = assertItemId(id);
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('VALIDATION_FAILED', 'Item must be an object');
        if (String(item[e.items.idField]) !== itemId) throw new AppError('VALIDATION_FAILED', 'Item id cannot be changed');
        const { doc, revision } = loadDoc(e);
        checkRevision(revision, ifRevision);
        const arr = itemsArray(e, doc);
        const i = arr.findIndex((it) => it && String(it[e.items.idField]) === itemId);
        if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Item not found', { key: e.key });
        arr[i] = item; // position (ordering) preserved
        return persist(e, 'resource.update-item', doc, { expectRevision: revision, idempotencyKey, message: `manage: update item in ${e.key}`, principal });
      });
    },

    deleteItem(key, id, { ifRevision, idempotencyKey, principal = ADMIN } = {}) {
      return withResource(key, principal, async (e) => {
        assertOp(e, 'delete-item');
        const itemId = assertItemId(id);
        const { doc, revision } = loadDoc(e);
        checkRevision(revision, ifRevision);
        const arr = itemsArray(e, doc);
        const i = arr.findIndex((it) => it && String(it[e.items.idField]) === itemId);
        if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Item not found', { key: e.key });
        arr.splice(i, 1);
        return persist(e, 'resource.delete-item', doc, { expectRevision: revision, idempotencyKey, message: `manage: delete item from ${e.key}`, principal });
      });
    },

    /** Multi-resource structural change: one journal, one commit, all-or-nothing. */
    async transaction(changes, { idempotencyKey, principal = ADMIN } = {}) {
      if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20) {
        throw new AppError('VALIDATION_FAILED', 'A transaction needs 1-20 changes');
      }
      const keys = changes.map((c) => writable(String(c && c.key), principal).key);
      if (new Set(keys).size !== keys.length) throw new AppError('VALIDATION_FAILED', 'Each resource may appear once per transaction');
      return dataRepo.structuralLock.withLock(() =>
        dataRepo.resourceLocks.withLocks(keys, async () => {
          const entries = keys.map((k) => writable(k, principal));
          const prepared = entries.map((e, i) => {
            assertOp(e, e.status === 'absent' ? 'create' : 'replace');
            validateDoc(e, changes[i].data);
            const text = dataRepo.readText(e.relPath);
            const current = text === null ? null : sha256(text);
            checkRevision(current, changes[i].ifRevision);
            return { relPath: e.relPath, content: serialize(changes[i].data), expectBefore: current };
          });
          const byRel = new Map(entries.map((e) => [e.relPath, e]));
          const op = await dataRepo.mutate({
            action: 'resource.transaction',
            keys,
            changes: prepared,
            message: `manage: update ${keys.join(', ')}`,
            validate: (rel, content) => validatorFor(byRel.get(rel))(rel, content),
            idempotencyKey,
            actor: actor(principal)
          });
          return {
            keys,
            revisions: Object.fromEntries(entries.map((e) => [e.key, sha256(dataRepo.readText(e.relPath) || '')])),
            persistence: persistenceOf(op)
          };
        })
      );
    },

    /** Comparison mode: a declared source checkout vs the canonical copy. Read-only, admin. */
    compare(key) {
      const e = catalog.get(key);
      if (!e.source) throw new AppError('OPERATION_NOT_ALLOWED', 'Resource has no declared source', { key: e.key });
      const dir = sourceRoots[e.source.repository];
      let sourceText = null;
      let sourceNote = null;
      if (!dir) sourceNote = 'source checkout not configured (DATA_SOURCE_ROOTS)';
      else {
        try {
          sourceText = readTextOrNull(resolveWithinRoot(dir, e.source.path));
          if (sourceText === null) sourceNote = 'source file not found';
        } catch (err) {
          sourceNote = err.code || 'source unreadable';
        }
      }
      return compareDataset(
        e,
        { text: sourceText, label: { repository: e.source.repository, path: e.source.path, ...(sourceNote ? { note: sourceNote } : {}) } },
        { text: dataRepo.readText(e.relPath), label: { repository: 'bmb-data', path: e.relPath } }
      );
    }
  });
}
