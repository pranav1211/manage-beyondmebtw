// API clients: per-application bearer tokens for Manage's data API.
//
// Manage issues a token for an application, scoped to resource keys (exact, or
// a "prefix.*" family) with read and/or write access. The token is returned /
// written to the app's env ONCE; only its SHA-256 is stored, in
// bmb-data/registry/api-clients.json (private, Git-backed, written through the
// shared DataRepo like the registry). Tokens are 256-bit random, so a plain
// SHA-256 is an adequate verifier; comparison is constant-time.

import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { readTextOrNull } from '../../shared/data/durable.js';

export const CLIENTS_REL = 'registry/api-clients.json';
const TOKEN_RE = /^bmbm_(c_[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const SCOPE_RE = /^[a-z0-9]+([._-][a-z0-9]+)*(\.\*)?$/;
const ACCESS = ['read', 'write'];
const LOCK_KEY = '@api-clients';

const hashToken = (t) => createHash('sha256').update(t).digest('hex');

/** Does any scope grant `need` ('read'|'write') on `key`? */
export function scopeAllows(scopes, key, need) {
  return (scopes || []).some(
    (s) => s.access.includes(need) && (s.resource === key || (s.resource.endsWith('.*') && key.startsWith(s.resource.slice(0, -1))))
  );
}

export function validateScopes(scopes) {
  // [] = sign-in-only client (Sign in with Manage), no data access.
  if (!Array.isArray(scopes) || scopes.length > 20) throw new AppError('VALIDATION_FAILED', 'scopes must be a list of 0-20 entries');
  return scopes.map((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new AppError('VALIDATION_FAILED', 'Each scope is { resource, access }');
    const unknown = Object.keys(s).filter((k) => k !== 'resource' && k !== 'access');
    if (unknown.length) throw new AppError('UNKNOWN_KEY', 'Unknown key(s) in scope', { unknown });
    if (typeof s.resource !== 'string' || !SCOPE_RE.test(s.resource)) throw new AppError('VALIDATION_FAILED', 'scope.resource must be a resource key or "prefix.*"', { resource: s.resource });
    if (!Array.isArray(s.access) || s.access.length < 1 || s.access.some((a) => !ACCESS.includes(a))) {
      throw new AppError('VALIDATION_FAILED', 'scope.access must be a non-empty subset of ["read","write"]');
    }
    return { resource: s.resource, access: [...new Set(s.access)].sort() };
  });
}

const publicView = ({ tokenHash: _h, ...rest }) => rest;

/**
 * @param {object} p
 * @param {object} p.dataRepo shared bmb-data DataRepo
 */
export function createApiClients({ dataRepo }) {
  const path = join(dataRepo.root, CLIENTS_REL);
  let cache = null;

  function readDoc() {
    if (!existsSync(path)) return { clients: [] };
    const st = statSync(path);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.stamp === stamp) return cache.doc;
    let doc;
    try {
      doc = JSON.parse(readTextOrNull(path));
    } catch {
      throw new AppError('DATA_INTEGRITY', 'api-clients.json is not valid JSON');
    }
    if (!doc || !Array.isArray(doc.clients)) throw new AppError('DATA_INTEGRITY', 'api-clients.json must contain a "clients" array');
    cache = { stamp, doc };
    return doc;
  }

  async function write(clients, message) {
    const op = await dataRepo.mutate({
      action: 'api-clients.update',
      keys: ['api-clients'],
      changes: [{ relPath: CLIENTS_REL, content: JSON.stringify({ clients }, null, 2) + '\n' }],
      message
    });
    if (op.status === 'blocked' || op.status === 'failed') {
      throw new AppError(op.lastError ? op.lastError.code : 'OPERATION_FAILED', op.lastError ? op.lastError.message : 'Could not persist API clients', { operationId: op.operationId });
    }
    return { operationId: op.operationId, status: op.status, commit: op.commit || null, pending: op.status === 'pending-push' };
  }

  const newToken = (id) => `bmbm_${id}_${randomBytes(32).toString('base64url')}`;
  const locked = (fn) => dataRepo.resourceLocks.withLocks([LOCK_KEY], fn);

  return Object.freeze({
    list: () => readDoc().clients.map(publicView),

    /** @returns {object|null} the active client for a presented token */
    verify(token) {
      const m = TOKEN_RE.exec(String(token || ''));
      if (!m) return null;
      const c = readDoc().clients.find((x) => x.id === m[1]);
      if (!c || c.revoked) return null;
      const a = Buffer.from(hashToken(token), 'hex');
      const b = Buffer.from(String(c.tokenHash), 'hex');
      return a.length === b.length && timingSafeEqual(a, b) ? publicView(c) : null;
    },

    /**
     * One active token per application: issuing again rotates it (old token
     * stops working) and replaces the scopes.
     * @returns {Promise<{client:object, token:string, persistence:object}>}
     */
    issueForApp: (application, scopes, description = '') =>
      locked(async () => {
        const clean = validateScopes(scopes);
        const clients = readDoc().clients.map((c) => ({ ...c }));
        let c = clients.find((x) => x.application === application && !x.revoked);
        const now = new Date().toISOString();
        if (!c) {
          c = { id: `c_${randomBytes(6).toString('hex')}`, application, createdAt: now, revoked: false };
          clients.push(c);
        }
        const token = newToken(c.id);
        Object.assign(c, { description: String(description).slice(0, 200), scopes: clean, tokenHash: hashToken(token), issuedAt: now });
        const persistence = await write(clients, `manage: issue API token for ${application}`);
        return { client: publicView(c), token, persistence };
      }),

    revoke: (id) =>
      locked(async () => {
        const clients = readDoc().clients.map((c) => ({ ...c }));
        const c = clients.find((x) => x.id === id);
        if (!c) throw new AppError('RESOURCE_NOT_FOUND', 'API client not found');
        if (c.revoked) return { client: publicView(c), persistence: { status: 'noop' } };
        Object.assign(c, { revoked: true, revokedAt: new Date().toISOString() });
        const persistence = await write(clients, `manage: revoke API token for ${c.application}`);
        return { client: publicView(c), persistence };
      })
  });
}
