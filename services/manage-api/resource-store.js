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
import { createCatalog, parseCatalog, CATALOG_REL } from '../../shared/data/catalog.js';
import { deriveHome, affectsHome } from '../../shared/data/home-derive.js';
import { sha256 } from '../../shared/data/durable.js';
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
 */
export function createResourceStore({ dataRepo }) {
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
    if (e.format !== 'json' && e.format !== 'markdown') throw new AppError('OPERATION_NOT_ALLOWED', 'This resource format is not writable through the API', { key: e.key });
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
    // Markdown documents are returned verbatim as a string.
    if (e.format === 'markdown') return { doc: text, revision: sha256(text) };
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
    if (e.format === 'markdown') {
      if (typeof doc !== 'string') throw new AppError('VALIDATION_FAILED', 'A markdown document is a string', { key: e.key });
      if (doc.length > 1_000_000 || doc.includes('\u0000')) throw new AppError('VALIDATION_FAILED', 'Markdown document too large or contains NUL', { key: e.key });
      return;
    }
    if (e.validate && !e.validate(doc)) {
      throw new AppError('VALIDATION_FAILED', 'Resulting document fails the resource schema', { key: e.key, errors: schemaErrors(e) });
    }
  }

  // Markdown is stored verbatim (byte-exact round trips); JSON is pretty-printed.
  const serialize = (e, doc) => (e.format === 'markdown' ? String(doc) : JSON.stringify(doc, null, 2) + '\n');
  const validatorFor = (e) => (_rel, content) => {
    if (e.format === 'markdown') return validateDoc(e, content);
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Staged content is not valid JSON', { key: e.key });
    }
    validateDoc(e, parsed);
  };

  // ── Derived fields of home.latest (see shared/data/home-derive.js) ──
  // Any write to blog.categories, a blog.posts.<category> or home.latest itself carries the
  // recomputed home.latest IN THE SAME COMMIT. The fields are server-owned: whatever a client
  // sends for them is replaced. Unchanged derived output is never written (no loops, no churn).
  const importedEntry = (key) => {
    try {
      const e = catalog.get(key);
      return e.status === 'imported' && e.format === 'json' ? e : null;
    } catch {
      return null;
    }
  };
  const currentDoc = (key) => {
    const e = importedEntry(key);
    if (!e) return null;
    try { return loadDoc(e); } catch { return null; }
  };
  /** overrides: Map key -> next document (null = deleted). Returns { entry, doc, current } or null. */
  function derivedHome(overrides) {
    const homeE = importedEntry('home.latest');
    if (!homeE || !importedEntry('blog.categories')) return null;
    const cur = currentDoc('home.latest');
    const base = overrides.has('home.latest') ? overrides.get('home.latest') : cur && cur.doc;
    if (!base || typeof base !== 'object') return null;
    const cats = overrides.has('blog.categories') ? overrides.get('blog.categories') : (currentDoc('blog.categories') || {}).doc;
    const posts = {};
    for (const k of Object.keys(cats || {})) {
      const key = `blog.posts.${k}`;
      posts[k] = overrides.has(key) ? overrides.get(key) : (currentDoc(key) || {}).doc || null;
    }
    return { entry: homeE, doc: deriveHome(base, cats, posts, { previous: cur && cur.doc }), current: cur };
  }
  const homeLockFor = (key) => (affectsHome(key) && key !== 'home.latest' && importedEntry('home.latest') ? ['home.latest'] : []);

  async function persist(e, action, nextDoc, { expectRevision, idempotencyKey, message, principal }) {
    let doc = nextDoc;
    const extra = []; // the derived home.latest, when this write changes it
    if (affectsHome(e.key)) {
      const d = derivedHome(new Map([[e.key, nextDoc]]));
      if (d && e.key === 'home.latest') doc = d.doc;
      else if (d && serialize(d.entry, d.doc) !== dataRepo.readText(d.entry.relPath)) {
        validateDoc(d.entry, d.doc);
        extra.push({ entry: d.entry, content: serialize(d.entry, d.doc), expectBefore: d.current ? d.current.revision : null });
      }
    }
    if (doc !== null) validateDoc(e, doc);
    const byRel = new Map([[e.relPath, e], ...extra.map((x) => [x.entry.relPath, x.entry])]);
    const op = await dataRepo.mutate({
      action,
      keys: [e.key, ...extra.map((x) => x.entry.key)],
      changes: [
        { relPath: e.relPath, content: doc === null ? null : serialize(e, doc), ...(expectRevision !== undefined ? { expectBefore: expectRevision } : {}) },
        ...extra.map((x) => ({ relPath: x.entry.relPath, content: x.content, expectBefore: x.expectBefore }))
      ],
      message: extra.length ? `${message} (+ home.latest recent posts)` : message,
      validate: (rel, content) => validatorFor(byRel.get(rel))(rel, content),
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
  const withResource = (key, principal, fn) => {
    const k = writable(key, principal).key;
    // A write that also re-derives home.latest holds its lock too.
    return dataRepo.resourceLocks.withLocks([k, ...homeLockFor(k)], () => fn(writable(key, principal)));
  };

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
      const derive = keys.some(affectsHome) && importedEntry('home.latest') !== null;
      const lockKeys = derive && !keys.includes('home.latest') ? [...keys, 'home.latest'] : keys;
      return dataRepo.structuralLock.withLock(() =>
        dataRepo.resourceLocks.withLocks(lockKeys, async () => {
          const entries = keys.map((k) => writable(k, principal));
          const prepared = entries.map((e, i) => {
            const c = changes[i];
            const text = dataRepo.readText(e.relPath);
            const current = text === null ? null : sha256(text);
            checkRevision(current, c.ifRevision);
            // { key, delete: true } removes a collection member in the same commit.
            if (c.delete === true) {
              if (!e.collectionKey) throw new AppError('OPERATION_NOT_ALLOWED', 'Only collection members can be deleted', { key: e.key });
              assertOp(e, 'delete');
              if (e.status !== 'imported') throw new AppError('RESOURCE_NOT_FOUND', 'Resource does not exist', { key: e.key });
              return { relPath: e.relPath, content: null, expectBefore: current };
            }
            assertOp(e, e.status === 'absent' ? 'create' : 'replace');
            validateDoc(e, c.data);
            return { relPath: e.relPath, content: serialize(e, c.data), expectBefore: current };
          });
          // Re-derive home.latest from the post-change state, in this same commit.
          if (derive) {
            const d = derivedHome(new Map(entries.map((e, i) => [e.key, changes[i].delete === true ? null : changes[i].data])));
            if (d) {
              const content = serialize(d.entry, d.doc);
              const at = entries.findIndex((e) => e.key === 'home.latest');
              if (at > -1) { validateDoc(d.entry, d.doc); prepared[at] = { ...prepared[at], content }; }
              else if (content !== dataRepo.readText(d.entry.relPath)) {
                validateDoc(d.entry, d.doc);
                prepared.push({ relPath: d.entry.relPath, content, expectBefore: d.current ? d.current.revision : null });
                entries.push(d.entry);
              }
            }
          }
          const allKeys = entries.map((e) => e.key);
          const byRel = new Map(entries.map((e) => [e.relPath, e]));
          const op = await dataRepo.mutate({
            action: 'resource.transaction',
            keys: allKeys,
            changes: prepared,
            message: `manage: update ${allKeys.join(', ')}`,
            validate: (rel, content) => validatorFor(byRel.get(rel))(rel, content),
            idempotencyKey,
            actor: actor(principal)
          });
          return {
            keys: allKeys,
            revisions: Object.fromEntries(entries.map((e) => [e.key, sha256(dataRepo.readText(e.relPath) || '')])),
            persistence: persistenceOf(op)
          };
        })
      );
    },

    /**
     * Recompute home.latest's derived fields from the current data and commit them only if they changed.
     * Used after a bmb-data push arrives (already committed upstream, so this is a follow-up commit) and
     * once at start-up (backfill). A second run with nothing new is a no-op: no commit, nothing pushed.
     */
    async refreshDerived() {
      if (!importedEntry('home.latest')) return { status: 'unavailable' };
      return dataRepo.resourceLocks.withLocks(['home.latest'], async () => {
        const d = derivedHome(new Map());
        if (!d || !d.current) return { status: 'unavailable' };
        const content = serialize(d.entry, d.doc);
        if (content === dataRepo.readText(d.entry.relPath)) return { status: 'noop' };
        validateDoc(d.entry, d.doc);
        const op = await dataRepo.mutate({
          action: 'resource.derive',
          keys: ['home.latest'],
          changes: [{ relPath: d.entry.relPath, content, expectBefore: d.current.revision }],
          message: 'manage: refresh home.latest (recent posts, category names)',
          validate: validatorFor(d.entry),
          actor: 'manage'
        });
        return { status: op.status, persistence: persistenceOf(op) };
      });
    },

    /**
     * Admin only: add a dataset to the catalog. A "document" is one JSON file (data/<a>/<b>.json for key "a.b");
     * a "collection" is a family of JSON files, one per member (data/<a>/<b>/{id}.json), like f1.season.
     * The new catalog is validated by the same parser that loads it, and the catalog entry plus a document's
     * first content are committed together. Existing files are never adopted or overwritten.
     */
    async createDataset(spec, { idempotencyKey, principal = ADMIN } = {}) {
      if (principal.kind !== 'admin') throw new AppError('FORBIDDEN', 'Only the admin can add datasets');
      const s = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
      const unknown = Object.keys(s).filter((k) => !['key', 'title', 'owner', 'kind', 'access', 'idPattern', 'items', 'initial', 'notes'].includes(k));
      if (unknown.length) throw new AppError('UNKNOWN_KEY', 'Unknown key(s) in dataset', { unknown });
      const key = String(s.key || '');
      if (!/^[a-z0-9]+(\.[a-z0-9-]+){0,4}$/.test(key) || key.length > 80) {
        throw new AppError('VALIDATION_FAILED', 'Key must be lower-case words separated by dots, e.g. "f1.drivers"');
      }
      if (s.kind !== 'document' && s.kind !== 'collection') throw new AppError('VALIDATION_FAILED', 'kind must be "document" or "collection"');
      if (s.access !== 'public' && s.access !== 'private') throw new AppError('VALIDATION_FAILED', 'access must be "public" or "private"');
      const kind = s.kind;
      let items = null;
      if (s.items !== undefined && s.items !== null) {
        const p = String(s.items.pointer ?? ''), f = String(s.items.idField ?? '');
        if (!/^(|\/[A-Za-z0-9_]{1,40})$/.test(p) || !/^[A-Za-z0-9_]{1,40}$/.test(f)) throw new AppError('VALIDATION_FAILED', 'items needs a pointer ("" or "/field") and an idField');
        items = { pointer: p, idField: f };
      }
      const idPattern = kind === 'collection' ? String(s.idPattern || '^[a-z0-9][a-z0-9_-]{0,63}$') : null;

      return dataRepo.structuralLock.withLock(async () => {
        // Any existing key, or a member key an existing collection would claim, is taken.
        try {
          catalog.get(key);
          throw new AppError('CONFLICT', 'That key is already in use (or belongs to an existing collection)', { key });
        } catch (err) {
          if (err.code !== 'RESOURCE_NOT_FOUND') throw err;
        }
        const parts = key.split('.');
        const path = kind === 'document' ? `${parts.join('/')}.json` : `${parts.join('/')}/{id}.json`;
        const rel = `data/${path}`;
        const dirOf = (r) => r.slice(0, r.lastIndexOf('/'));
        const memberOf = (pattern, idRe, file) => {
          const [pre, post] = pattern.split('{id}');
          return file.startsWith(pre) && file.endsWith(post) && file.length > pre.length + post.length && idRe.test(file.slice(pre.length, file.length - post.length));
        };
        const base = (r) => r.slice(r.lastIndexOf('/') + 1);
        const newIdRe = idPattern ? new RegExp(idPattern) : null;
        for (const e of catalog.load().entries.values()) {
          if (kind === 'collection' && (e.key.startsWith(`${key}.`) || (e.collection && dirOf(e.relPath) === dirOf(rel)))) {
            throw new AppError('CONFLICT', `"${e.key}" already lives under that name or folder`, { key: e.key });
          }
          if (e.collection && dirOf(e.relPath) === dirOf(rel) && memberOf(base(e.relPath), e.idRe, base(rel))) {
            throw new AppError('CONFLICT', `The file would look like a member of "${e.key}"`, { key: e.key });
          }
          if (kind === 'collection' && !e.collection && dirOf(e.relPath) === dirOf(rel) && memberOf(base(rel), newIdRe, base(e.relPath))) {
            throw new AppError('CONFLICT', `"${e.key}" would look like a member of the new collection`, { key: e.key });
          }
        }
        if (kind === 'document' && dataRepo.readText(rel) !== null) throw new AppError('CONFLICT', 'A file already exists at that path; it is never adopted silently', { path: rel });

        let initialText = null;
        if (kind === 'document') {
          const init = s.initial !== undefined ? s.initial : items ? (items.pointer === '' ? [] : { [items.pointer.slice(1)]: [] }) : {};
          if (!init || typeof init !== 'object') throw new AppError('VALIDATION_FAILED', 'Initial content must be a JSON object or array');
          if (items && !Array.isArray(items.pointer === '' ? init : init[items.pointer.slice(1)])) throw new AppError('VALIDATION_FAILED', 'Initial content must hold an array where the items live');
          initialText = JSON.stringify(init, null, 2) + '\n';
        }

        const entry = {
          key,
          title: String(s.title || key).slice(0, 200),
          owner: String(s.owner || 'manage').slice(0, 80),
          root: 'data',
          path,
          format: 'json',
          access: s.access,
          status: 'imported',
          ...(kind === 'collection' ? { collection: { idPattern } } : {}),
          operations: ['read', 'replace', ...(kind === 'collection' ? ['create', 'delete'] : []), ...(items ? ['create-item', 'update-item', 'delete-item'] : [])],
          ...(items ? { items } : {}),
          consumers: [],
          notes: String(s.notes || `Added from the Manage dashboard on ${new Date().toISOString().slice(0, 10)}.`).slice(0, 1000)
        };
        const curText = dataRepo.readText(CATALOG_REL);
        if (curText === null) throw new AppError('DATA_INTEGRITY', 'catalog.json is missing');
        const doc = JSON.parse(curText);
        doc.resources.push(entry);
        const nextText = JSON.stringify(doc, null, 2) + '\n';
        parseCatalog(dataRepo.root, nextText); // the exact validation the loader applies; throws CATALOG_INVALID

        const changes = [{ relPath: CATALOG_REL, content: nextText, expectBefore: sha256(curText) }];
        if (initialText !== null) changes.push({ relPath: rel, content: initialText, expectBefore: null });
        const op = await dataRepo.mutate({
          action: 'catalog.create',
          keys: [key],
          changes,
          message: `manage: add dataset ${key}`,
          validate: (r, content) => { if (r === CATALOG_REL) parseCatalog(dataRepo.root, content); else JSON.parse(content); },
          idempotencyKey,
          actor: actor(principal)
        });
        return { key, entry, persistence: persistenceOf(op) };
      });
    }
  });
}
