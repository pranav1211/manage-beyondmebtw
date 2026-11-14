// Read-only comparison of a source dataset (current legacy location) with its
// canonical copy. Reports differences; never normalizes them away.

import { sha256 } from './durable.js';

function itemsOf(doc, items) {
  if (!items) return null;
  const arr = items.pointer ? doc && doc[items.pointer.slice(1)] : doc;
  return Array.isArray(arr) ? arr : null;
}

function diffPaths(a, b, path = '', out = [], limit = 50) {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) {
    out.push({ path: path || '/', kind: 'type', source: ta, target: tb });
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push({ path: path || '/', kind: 'length', source: a.length, target: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}/${i}`, out, limit);
    return out;
  }
  if (ta === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    for (const k of ka) if (!(k in b)) out.push({ path: `${path}/${k}`, kind: 'missing-in-target' });
    for (const k of kb) if (!(k in a)) out.push({ path: `${path}/${k}`, kind: 'extra-in-target' });
    if (ka.filter((k) => k in b).join('\u0000') !== kb.filter((k) => k in a).join('\u0000')) {
      out.push({ path: path || '/', kind: 'key-order' });
    }
    for (const k of ka) if (k in b) diffPaths(a[k], b[k], `${path}/${k}`, out, limit);
    return out;
  }
  out.push({ path: path || '/', kind: 'value' });
  return out;
}

function describe(text, entry) {
  if (text === null) return { present: false };
  const out = { present: true, sha256: sha256(text), bytes: Buffer.byteLength(text) };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ...out, parse: 'malformed' };
  }
  out.parse = 'ok';
  if (entry.validate) {
    out.schemaValid = Boolean(entry.validate(doc));
    if (!out.schemaValid) out.schemaErrors = (entry.validate.errors || []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message}`);
  }
  const items = itemsOf(doc, entry.items);
  if (items) {
    out.count = items.length;
    out.ids = items.map((it) => (it && it[entry.items.idField] !== undefined ? String(it[entry.items.idField]) : null));
  } else if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    out.count = Object.keys(doc).length;
    out.ids = Object.keys(doc);
  } else if (Array.isArray(doc)) out.count = doc.length;
  return { ...out, doc };
}

/**
 * @param {object} entry catalog entry
 * @param {{text:string|null, label:object}} source
 * @param {{text:string|null, label:object}} target
 */
export function compareDataset(entry, source, target) {
  const s = describe(source.text, entry);
  const t = describe(target.text, entry);
  const report = {
    key: entry.key,
    status: entry.status,
    comparedAt: new Date().toISOString(),
    source: { ...source.label, ...strip(s) },
    target: { ...target.label, ...strip(t) },
    identical: s.present && t.present && s.sha256 === t.sha256
  };
  if (s.ids && t.ids) {
    const sset = new Set(s.ids);
    const tset = new Set(t.ids);
    report.ids = {
      missingInTarget: s.ids.filter((x) => !tset.has(x)),
      extraInTarget: t.ids.filter((x) => !sset.has(x)),
      duplicateInSource: s.ids.filter((x, i) => s.ids.indexOf(x) !== i),
      duplicateInTarget: t.ids.filter((x, i) => t.ids.indexOf(x) !== i),
      sameOrder: s.ids.join('\u0000') === t.ids.join('\u0000')
    };
  }
  if (s.doc !== undefined && t.doc !== undefined && !report.identical) report.differences = diffPaths(s.doc, t.doc);
  return report;
}

function strip(d) {
  const { doc: _doc, ids: _ids, ...rest } = d;
  return rest;
}
