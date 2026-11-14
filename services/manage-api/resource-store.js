// Catalog-backed canonical resources in bmb-data.
//
// Reads: key -> catalog entry -> file; private resources only for an admin
// caller (and indistinguishable from unknown keys otherwise); missing/malformed/
// schema-invalid canonical files are explicit DATA_INTEGRITY errors, never an
// empty success. Reads never touch Git.
// Writes: catalog permission + schema validation of the COMPLETE resulting
// document, serialized per resource (and structurally for multi-resource
// transactions), persisted through DataRepo (journal, exact-path commit, push,
// read-back). Invalid input never replaces the current file.

import { AppError } from '../../shared/errors.js';
import { createCatalog } from '../../shared/data/catalog.js';
import { compareDataset } from '../../shared/data/compare.js';
import { sha256, readTextOrNull } from '../../shared/data/durable.js';
import { resolveWithinRoot } from '../../shared/validation/paths.js';

const ITEM_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

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

/**
 * @param {object} p
 * @param {ReturnType<import('../../shared/data/data-repo.js').createDataRepo>} p.dataRepo
 * @param {Record<string,string>} [p.sourceRoots] owner/repo -> local read-only checkout (comparison mode)
 */
export function createResourceStore({ dataRepo, sourceRoots = {} }) {
  const catalog = createCatalog(dataRepo.root);

  function entryFor(key, { admin }) {
    const e = catalog.get(key);
    if (e.access === 'private' && !admin) throw hidden();
    return e;
  }

  function loadDoc(e) {
    if (e.status !== 'imported') {
      throw new AppError('RESOURCE_NOT_FOUND', 'Resource is mapped but not imported yet', { key: e.key, status: e.status });
    }
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
    return { doc, revision: sha256(text), text };
  }

  function itemsArray(e, doc) {
    const arr = e.items.pointer ? doc[e.items.pointer.slice(1)] : doc;
    if (!Array.isArray(arr)) throw new AppError('DATA_INTEGRITY', 'Item container is not an array', { key: e.key, reason: 'schema' });
    return arr;
  }

  function assertOp(e, op) {
    if (e.format !== 'json') throw new AppError('OPERATION_NOT_ALLOWED', 'Only JSON resources are writable through this API', { key: e.key });
    if (!e.operations.includes(op)) throw new AppError('OPERATION_NOT_ALLOWED', `Operation "${op}" is not allowed on this resource`, { key: e.key });
    if (e.status !== 'imported') throw new AppError('OPERATION_NOT_ALLOWED', 'Resource is not imported; writes are disabled', { key: e.key, status: e.status });
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

  async function write(e, action, nextDoc, { expectRevision, idempotencyKey, message }) {
    validateDoc(e, nextDoc);
    const op = await dataRepo.mutate({
      action,
      keys: [e.key],
      changes: [{ relPath: e.relPath, content: serialize(nextDoc), ...(expectRevision !== undefined ? { expectBefore: expectRevision } : {}) }],
      message,
      validate: validatorFor(e),
      idempotencyKey
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

  return Object.freeze({
    catalog,

    list({ admin }) {
      return catalog
        .list()
        .filter((e) => admin || e.access === 'public')
        .map((e) => ({
          key: e.key,
          title: e.title || null,
          owner: e.owner || null,
          access: e.access,
          status: e.status,
          format: e.format,
          operations: e.operations,
          items: e.items ? { idField: e.items.idField } : null,
          ...(admin ? { path: e.relPath, source: e.source || null, consumers: e.consumers || [] } : {})
        }));
    },

    read(key, { admin }) {
      const e = entryFor(key, { admin });
      const { doc, revision } = loadDoc(e);
      return { key: e.key, revision, data: doc };
    },

    readItem(key, id, { admin }) {
      const e = entryFor(key, { admin });
      if (!e.items) throw new AppError('OPERATION_NOT_ALLOWED', 'Resource has no item-level access', { key: e.key });
      const itemId = assertItemId(id);
      const { doc, revision } = loadDoc(e);
      const item = itemsArray(e, doc).find((it) => it && String(it[e.items.idField]) === itemId);
      if (!item) throw new AppError('RESOURCE_NOT_FOUND', 'Item not found', { key: e.key });
      return { key: e.key, revision, item };
    },

    async replace(key, data, { ifRevision, idempotencyKey } = {}) {
      const e = entryFor(key, { admin: true });
      assertOp(e, 'replace');
      return dataRepo.resourceLocks.withLocks([e.key], async () => {
        const text = dataRepo.readText(e.relPath);
        const current = text === null ? null : sha256(text);
        checkRevision(current, ifRevision);
        return write(e, 'resource.replace', data, { expectRevision: current, idempotencyKey, message: `manage: replace ${e.key}` });
      });
    },

    async createItem(key, item, { ifRevision, idempotencyKey } = {}) {
      const e = entryFor(key, { admin: true });
      assertOp(e, 'create-item');
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('VALIDATION_FAILED', 'Item must be an object');
      const id = assertItemId(item[e.items.idField]);
      return dataRepo.resourceLocks.withLocks([e.key], async () => {
        const { doc, revision } = loadDoc(e);
        checkRevision(revision, ifRevision);
        const arr = itemsArray(e, doc);
        if (arr.some((it) => it && String(it[e.items.idField]) === id)) throw new AppError('CONFLICT', 'An item with this id already exists', { key: e.key });
        arr.push(item);
        return write(e, 'resource.create-item', doc, { expectRevision: revision, idempotencyKey, message: `manage: add item to ${e.key}` });
      });
    },

    async updateItem(key, id, item, { ifRevision, idempotencyKey } = {}) {
      const e = entryFor(key, { admin: true });
      assertOp(e, 'update-item');
      const itemId = assertItemId(id);
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('VALIDATION_FAILED', 'Item must be an object');
      if (String(item[e.items.idField]) !== itemId) throw new AppError('VALIDATION_FAILED', 'Item id cannot be changed');
      return dataRepo.resourceLocks.withLocks([e.key], async () => {
        const { doc, revision } = loadDoc(e);
        checkRevision(revision, ifRevision);
        const arr = itemsArray(e, doc);
        const i = arr.findIndex((it) => it && String(it[e.items.idField]) === itemId);
        if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Item not found', { key: e.key });
        arr[i] = item; // position (ordering) preserved
        return write(e, 'resource.update-item', doc, { expectRevision: revision, idempotencyKey, message: `manage: update item in ${e.key}` });
      });
    },

    async deleteItem(key, id, { ifRevision, idempotencyKey } = {}) {
      const e = entryFor(key, { admin: true });
      assertOp(e, 'delete-item');
      const itemId = assertItemId(id);
      return dataRepo.resourceLocks.withLocks([e.key], async () => {
        const { doc, revision } = loadDoc(e);
        checkRevision(revision, ifRevision);
        const arr = itemsArray(e, doc);
        const i = arr.findIndex((it) => it && String(it[e.items.idField]) === itemId);
        if (i === -1) throw new AppError('RESOURCE_NOT_FOUND', 'Item not found', { key: e.key });
        arr.splice(i, 1);
        return write(e, 'resource.delete-item', doc, { expectRevision: revision, idempotencyKey, message: `manage: delete item from ${e.key}` });
      });
    },

    /** Multi-resource structural change: one journal, one commit, all-or-nothing. */
    async transaction(changes, { idempotencyKey } = {}) {
      if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20) {
        throw new AppError('VALIDATION_FAILED', 'A transaction needs 1-20 changes');
      }
      const entries = changes.map((c) => {
        const e = entryFor(String(c && c.key), { admin: true });
        assertOp(e, 'replace');
        validateDoc(e, c.data);
        return e;
      });
      if (new Set(entries.map((e) => e.key)).size !== entries.length) throw new AppError('VALIDATION_FAILED', 'Each resource may appear once per transaction');
      return dataRepo.structuralLock.withLock(() =>
        dataRepo.resourceLocks.withLocks(entries.map((e) => e.key), async () => {
          const prepared = entries.map((e, i) => {
            const text = dataRepo.readText(e.relPath);
            const current = text === null ? null : sha256(text);
            checkRevision(current, changes[i].ifRevision);
            return { relPath: e.relPath, content: serialize(changes[i].data), expectBefore: current };
          });
          const byRel = new Map(entries.map((e) => [e.relPath, e]));
          const op = await dataRepo.mutate({
            action: 'resource.transaction',
            keys: entries.map((e) => e.key),
            changes: prepared,
            message: `manage: update ${entries.map((e) => e.key).join(', ')}`,
            validate: (rel, content) => validatorFor(byRel.get(rel))(rel, content),
            idempotencyKey
          });
          return {
            keys: entries.map((e) => e.key),
            revisions: Object.fromEntries(entries.map((e) => [e.key, sha256(dataRepo.readText(e.relPath) || '')])),
            persistence: persistenceOf(op)
          };
        })
      );
    },

    /** Comparison mode: legacy source vs canonical copy. Read-only. */
    compare(key) {
      const e = entryFor(key, { admin: true });
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
      const targetText = dataRepo.readText(e.relPath);
      const report = compareDataset(
        e,
        { text: sourceText, label: { repository: e.source.repository, path: e.source.path, ...(sourceNote ? { note: sourceNote } : {}) } },
        { text: targetText, label: { repository: 'bmb-data', path: e.relPath } }
      );
      return report;
    }
  });
}

