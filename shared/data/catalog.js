// Canonical data catalog (bmb-data/catalog/catalog.json + catalog/schemas/).
//
// The catalog is the ONLY way to address canonical data: clients name a stable
// key; the catalog maps it to one approved file under `data/` or `content/` of
// the bmb-data checkout. `registry/` and `catalog/` themselves are never
// reachable as resources. Every entry is schema-validated and its path is
// containment-checked (traversal, encoded traversal, absolute, symlink escape).
// The catalog is developer-authored config: it changes by commits to bmb-data
// (synced by the bmb-data webhook), never through the generic resource API.

import { statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { AppError } from '../errors.js';
import { validateCatalogEntry } from '../schemas/index.js';
import { resolveWithinRoot, assertSafeCatalogKey, assertSafeIdentifier } from '../validation/paths.js';
import { readTextOrNull, sha256 } from './durable.js';

export const CATALOG_REL = 'catalog/catalog.json';
const EXT_FOR = { json: '.json', markdown: '.md' };
const OPERATIONS = ['read', 'replace', 'create', 'delete', 'create-item', 'update-item', 'delete-item'];
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message, details) {
  return new AppError('CATALOG_INVALID', message, details);
}

/** Parse + validate a catalog document against a checkout. Pure (no caching). */
export function parseCatalog(root, text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw invalid('catalog.json is not valid JSON');
  }
  if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.resources)) {
    throw invalid('catalog.json must be { "schemaVersion": 1, "resources": [...] }');
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const entries = new Map();
  const paths = new Set();
  for (const e of doc.resources) {
    const { valid, errors } = validateCatalogEntry(e);
    if (!valid) throw invalid('Catalog entry failed validation', { key: e && e.key, errors });
    assertSafeCatalogKey(e.key);
    if (entries.has(e.key)) throw invalid('Duplicate catalog key', { key: e.key });
    if (!e.path.toLowerCase().endsWith(EXT_FOR[e.format])) throw invalid('Path extension does not match format', { key: e.key });
    const rel = `${e.root}/${e.path}`;
    const placeholders = (e.path.match(/\{id\}/g) || []).length;
    let idRe = null;
    if (e.collection) {
      // One {id}, in the file name only: members are siblings in one directory.
      if (placeholders !== 1 || e.path.slice(e.path.lastIndexOf('/') + 1).indexOf('{id}') === -1) {
        throw invalid('A collection path needs exactly one {id}, in the file name', { key: e.key });
      }
      try {
        idRe = new RegExp(e.collection.idPattern);
      } catch {
        throw invalid('Collection idPattern is not a valid regular expression', { key: e.key });
      }
      if (e.items && e.operations && !e.operations.includes('read')) throw invalid('Collections must be readable', { key: e.key });
    } else if (placeholders) {
      throw invalid('{id} is only allowed in collection paths', { key: e.key });
    }
    resolveWithinRoot(root, rel.replace('{id}', 'member'), { allowedExtensions: [EXT_FOR[e.format]] });
    if (paths.has(rel)) throw invalid('Two catalog keys map to the same file', { key: e.key });
    paths.add(rel);
    const ops = e.operations || ['read'];
    if (e.writable === false && ops.some((o) => o !== 'read')) throw invalid('Read-only entry lists write operations', { key: e.key });
    if (ops.some((o) => o.endsWith('-item')) && !e.items) throw invalid('Item operations need an "items" definition', { key: e.key });
    let validate = null;
    if (e.schemaRef) {
      assertSafeIdentifier(e.schemaRef, 'schemaRef');
      const schemaText = readTextOrNull(join(root, 'catalog', 'schemas', `${e.schemaRef}.schema.json`));
      if (schemaText === null) throw invalid('Referenced resource schema is missing', { key: e.key, schemaRef: e.schemaRef });
      try {
        validate = ajv.compile(JSON.parse(schemaText));
      } catch {
        throw invalid('Resource schema does not compile', { key: e.key, schemaRef: e.schemaRef });
      }
    }
    entries.set(e.key, Object.freeze({ ...e, operations: ops, status: e.status || 'mapped', relPath: rel, validate, idRe }));
  }
  return { entries, revision: sha256(text) };
}

/**
 * Catalog view over a checkout; re-reads when catalog.json changes on disk
 * (e.g. after a webhook sync). A broken catalog fails closed with CATALOG_INVALID.
 */
export function createCatalog(root) {
  let cache = null;
  function load() {
    const file = join(root, CATALOG_REL);
    if (!existsSync(file)) return { entries: new Map(), revision: null, missing: true };
    const st = statSync(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.stamp === stamp) return cache.value;
    const value = parseCatalog(root, readTextOrNull(file));
    cache = { stamp, value };
    return value;
  }
  /** A collection member: "<collectionKey>.<id>" -> path with {id}; status reflects the file. */
  function member(c, id) {
    const relPath = c.relPath.replace('{id}', id);
    return Object.freeze({
      ...c,
      key: `${c.key}.${id}`,
      collectionKey: c.key,
      memberId: id,
      relPath,
      status: existsSync(resolveWithinRoot(root, relPath)) ? 'imported' : 'absent'
    });
  }

  function resolveMember(key) {
    const i = key.lastIndexOf('.');
    if (i < 1) return null;
    const c = load().entries.get(key.slice(0, i));
    const id = key.slice(i + 1);
    if (!c || !c.collection || !MEMBER_ID_RE.test(id) || !c.idRe.test(id)) return null;
    return member(c, id);
  }

  function members(c) {
    const pattern = c.relPath.slice(c.relPath.lastIndexOf('/') + 1);
    const dir = join(root, c.relPath.slice(0, c.relPath.lastIndexOf('/')));
    const [pre, post] = pattern.split('{id}');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith(pre) && f.endsWith(post) && f.length > pre.length + post.length)
      .map((f) => f.slice(pre.length, f.length - post.length))
      .filter((id) => MEMBER_ID_RE.test(id) && c.idRe.test(id))
      .sort()
      .map((id) => member(c, id));
  }

  return Object.freeze({
    load,
    get(key) {
      assertSafeCatalogKey(key);
      const e = load().entries.get(key);
      if (e) return e;
      const m = resolveMember(key);
      if (!m) throw new AppError('RESOURCE_NOT_FOUND', 'Unknown resource key');
      return m;
    },
    /** Plain resources, collections, and every existing collection member. */
    list: () => [...load().entries.values()].flatMap((e) => (e.collection ? [e, ...members(e)] : [e])),
    OPERATIONS
  });
}

export { OPERATIONS };
