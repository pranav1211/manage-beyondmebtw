// Reusable, tested path and key validation for trust boundaries.
//
// Rules enforced:
// - Resolve-and-contain: a candidate must resolve to a real location *inside*
//   a configured root. Never trust a string-prefix check — resolve first.
// - Reject traversal, including percent-encoded (`%2e%2e`) and mixed separators.
// - Reject absolute paths where a relative path is required.
// - Reject symlink escapes: if the path (or any existing ancestor) is a symlink
//   that resolves outside the root, it fails closed.
// - Enforce an extension allowlist.
// - Validate identifiers/keys against strict patterns.
//
// These functions throw AppError with a stable code on violation, or return a
// normalized value on success. They never include secret values in errors.

import { resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { realpathSync } from 'node:fs';
import { AppError } from '../errors.js';

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CATALOG_KEY_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

// Decode percent-encoding enough to catch encoded traversal, then normalize
// separators so Windows/Unix inputs are judged the same way.
function decodeAndNormalize(input) {
  let decoded = String(input);
  try {
    // Repeated decode to catch double-encoding (%252e -> %2e -> .)
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    // Malformed encoding is itself suspicious.
    throw new AppError('PATH_TRAVERSAL', 'Malformed percent-encoding in path');
  }
  return decoded.replace(/\\/g, '/');
}

export function assertSafeIdentifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new AppError('INVALID_IDENTIFIER', `Invalid ${label}`, { label });
  }
  return value;
}

export function assertSafeCatalogKey(value) {
  if (typeof value !== 'string' || !CATALOG_KEY_RE.test(value)) {
    throw new AppError('INVALID_IDENTIFIER', 'Invalid catalog key');
  }
  return value;
}

export function assertAllowedExtension(relPath, allowed) {
  const ext = extname(String(relPath)).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new AppError('DISALLOWED_EXTENSION', 'File extension not allowed', {
      ext: ext || '(none)'
    });
  }
  return ext;
}

// Reject only disallowed keys; `allowed` is the closed set.
export function assertKnownKeys(obj, allowed) {
  const unknown = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new AppError('UNKNOWN_KEY', 'Unknown key(s) in payload', { unknown });
  }
}

/**
 * Resolve `candidate` (a relative path) against `root` and prove containment.
 * Returns the absolute resolved path. Throws on traversal, absolute input,
 * or (when the target or an ancestor exists) a symlink that escapes the root.
 *
 * @param {string} root absolute root directory
 * @param {string} candidate relative path under the root
 * @param {object} [opts]
 * @param {string[]} [opts.allowedExtensions] if set, enforce extension allowlist
 */
export function resolveWithinRoot(root, candidate, opts = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new AppError('CONFIG_INVALID', 'Root must be an absolute path');
  }
  const normalized = decodeAndNormalize(candidate);

  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new AppError('ABSOLUTE_PATH', 'Absolute paths are not allowed here');
  }
  // Explicit traversal segments (post-normalization) fail fast.
  if (normalized.split('/').some((seg) => seg === '..')) {
    throw new AppError('PATH_TRAVERSAL', 'Path traversal is not allowed');
  }

  if (opts.allowedExtensions) {
    assertAllowedExtension(normalized, opts.allowedExtensions);
  }

  const rootResolved = resolve(root);
  const target = resolve(rootResolved, normalized);

  // Lexical containment check.
  const rel = relative(rootResolved, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new AppError('PATH_TRAVERSAL', 'Resolved path escapes the root');
  }

  // Symlink-escape check against the real filesystem where the path exists.
  // Walk from the target up to the root; the deepest existing ancestor's real
  // path must still be inside the root's real path.
  try {
    const realRoot = realpathSync(rootResolved);
    let probe = target;
    // Find the deepest existing ancestor.
    // (realpathSync throws ENOENT for non-existent paths — expected for new files.)
    for (;;) {
      try {
        const realProbe = realpathSync(probe);
        const realRel = relative(realRoot, realProbe);
        if (realRel !== '' && (realRel.startsWith('..') || isAbsolute(realRel))) {
          throw new AppError('SYMLINK_ESCAPE', 'Path escapes root via symlink');
        }
        break;
      } catch (err) {
        if (err instanceof AppError) throw err;
        // Not found at this level — step up to the parent and retry.
        const parent = resolve(probe, '..');
        if (parent === probe) break; // reached filesystem root
        probe = parent;
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // realpath of the root itself failed — treat as misconfiguration.
    throw new AppError('CONFIG_INVALID', 'Root directory is not accessible');
  }

  return target;
}

export function isWithinRoot(root, candidate, opts) {
  try {
    resolveWithinRoot(root, candidate, opts);
    return true;
  } catch {
    return false;
  }
}

// Guard: a path that points at a secret/runtime location must never be treated
// as Git-backed config. Callers pass the configured secret/log roots.
export function assertNotSecretOrRuntimePath(absPath, { secretRoots = [], logRoots = [] } = {}) {
  const p = resolve(absPath);
  for (const base of [...secretRoots, ...logRoots]) {
    if (!base) continue;
    const b = resolve(base);
    const rel = relative(b, p);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new AppError('PATH_VIOLATION', 'Path references a secret/runtime location', {});
    }
  }
  return absPath;
}

export const _internal = { IDENTIFIER_RE, CATALOG_KEY_RE, decodeAndNormalize, SEP: sep };
