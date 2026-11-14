// Canonical data catalog (bmb-data/catalog/catalog.json + catalog/schemas/).
//
// The catalog is the ONLY way to address canonical data: clients name a stable
// key; the catalog maps it to one approved file under `data/` or `content/` of
// the bmb-data checkout. `registry/` and `catalog/` themselves are never
// reachable as resources. Every entry is schema-validated and its path is
// containment-checked (traversal, encoded traversal, absolute, symlink escape).
// The catalog is developer-authored config: it changes by commits to bmb-data
// (synced by the bmb-data webhook), never through the generic resource API.

import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { AppError } from '../errors.js';
import { validateCatalogEntry } from '../schemas/index.js';
import { resolveWithinRoot, assertSafeCatalogKey, assertSafeIdentifier } from '../validation/paths.js';
import { readTextOrNull, sha256 } from './durable.js';

export const CATALOG_REL = 'catalog/catalog.json';
const EXT_FOR = { json: '.json', markdown: '.md' };
const OPERATIONS = ['read', 'replace', 'create-item', 'update-item', 'delete-item'];

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
    resolveWithinRoot(root, rel, { allowedExtensions: [EXT_FOR[e.format]] });
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
    entries.set(e.key, Object.freeze({ ...e, operations: ops, status: e.status || 'mapped', relPath: rel, validate }));
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
  return Object.freeze({
    load,
    get(key) {
      assertSafeCatalogKey(key);
      const e = load().entries.get(key);
      if (!e) throw new AppError('RESOURCE_NOT_FOUND', 'Unknown resource key');
      return e;
    },
    list: () => [...load().entries.values()],
    OPERATIONS
  });
}

export { OPERATIONS };
