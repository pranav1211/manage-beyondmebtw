// Manage API v1 (/api/v1). Every route except login/session requires an
// authenticated admin session; every state-changing route also requires the
// session's CSRF token. The browser only ever talks to these routes — Argus is
// called server-side through argus-client.js.

import express from 'express';
import { AppError, ERROR_CODES, sanitizeError } from '../../../shared/errors.js';
import { ARGUS_OPERATIONS } from '../../../shared/contracts/manage-argus.js';
import { validateRegistryEntry } from '../../../shared/schemas/index.js';
import { verifyPassword, parseCookies, sessionCookie, SESSION_COOKIE } from '../auth.js';

export const GLOBAL_RECONCILE_CONFIRMATION = 'RECONCILE ALL ELIGIBLE APPS';

const STATUS_FOR = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TARGET_NOT_ALLOWED: 403,
  RESOURCE_NOT_FOUND: 404,
  UNKNOWN_TARGET: 404,
  CONFLICT: 409,
  TARGET_DISABLED: 409,
  DATA_REPO_DIRTY: 409,
  DATA_REPO_DIVERGED: 409,
  DATA_REPO_UNAVAILABLE: 503,
  DATA_INTEGRITY: 500,
  CATALOG_INVALID: 500,
  OPERATION_NOT_ALLOWED: 405,
  LOCK_TIMEOUT: 503,
  INVALID_IDENTIFIER: 400,
  RATE_LIMITED: 429,
  NOT_IMPLEMENTED: 501,
  CONFIG_MISSING: 503,
  ARGUS_UNAVAILABLE: 502,
  ARGUS_UNAUTHORIZED: 502,
  ARGUS_BAD_RESPONSE: 502,
  ARGUS_TIMEOUT: 504
};

export function statusFor(err) {
  if (err && err.httpStatus && err.httpStatus >= 400) return err.httpStatus;
  return (err && STATUS_FOR[err.code]) || (err instanceof AppError ? 400 : 500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {object} deps
 * @param {import('../auth.js').SessionStore} deps.sessions
 * @param {import('../auth.js').LoginLimiter} deps.limiter
 * @param {string|null} deps.passwordHash scrypt hash (env), null if unset
 * @param {object} deps.argus argus-client instance
 * @param {object} deps.registry registry-store instance
 * @param {object} [deps.resources] resource-store instance (canonical data)
 * @param {object} [deps.dataRepo] shared bmb-data DataRepo
 * @param {boolean} deps.secureCookies
 * @param {string} deps.env node env label
 */
export function createV1Router({ sessions, limiter, passwordHash, argus, registry, resources, dataRepo, secureCookies, env }) {
  const router = express.Router();
  // Canonical documents can be larger than control-plane requests.
  router.use('/data', express.json({ limit: '2mb', strict: true }));
  router.use(express.json({ limit: '64kb', strict: true }));
  const sessionOf = (req) => sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  // ── Auth ────────────────────────────────────────────────────────────────
  router.post('/auth/login', wrap(async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ code: 'VALIDATION_FAILED', message: 'JSON body required' });
    if (!passwordHash) return res.status(503).json({ code: 'CONFIG_MISSING', message: 'Admin password is not configured' });
    const key = req.ip || 'unknown';
    const gate = limiter.check(key);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, message: 'Too many failed attempts; try again later' });
    }
    const ok = verifyPassword(req.body && req.body.password, passwordHash);
    if (!ok) {
      limiter.fail(key);
      await sleep(300);
      return res.status(401).json({ code: ERROR_CODES.UNAUTHENTICATED, message: 'Invalid password' });
    }
    limiter.reset(key);
    const { cookieValue, csrf } = sessions.create();
    res.set('Set-Cookie', sessionCookie(cookieValue, { secure: secureCookies }));
    return res.json({ authenticated: true, csrfToken: csrf });
  }));

  router.get('/auth/session', (req, res) => {
    const s = sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.json(s ? { authenticated: true, csrfToken: s.csrf } : { authenticated: false });
  });

  // ── Canonical data: public reads (private resources need a session) ─────
  // Catalog-gated: callers name a key, never a path. Private resources are
  // indistinguishable from unknown keys without an admin session.
  if (resources) {
    router.get('/data/resources', (req, res) => {
      res.json({ resources: resources.list({ admin: Boolean(sessionOf(req)) }) });
    });
    router.get('/data/resources/:key', (req, res) => {
      res.json(resources.read(req.params.key, { admin: Boolean(sessionOf(req)) }));
    });
    router.get('/data/resources/:key/items/:id', (req, res) => {
      res.json(resources.readItem(req.params.key, req.params.id, { admin: Boolean(sessionOf(req)) }));
    });
  }

  // Everything below: admin session required (+ CSRF on mutations).
  router.use((req, res, next) => {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = sessions.get(cookie);
    if (!s) return res.status(401).json({ code: ERROR_CODES.UNAUTHENTICATED, message: 'Authentication required' });
    if (MUTATING.has(req.method) && !sessions.checkCsrf(s, req.get('x-csrf-token'))) {
      return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, message: 'Missing or invalid CSRF token' });
    }
    req.session = s;
    req.sessionCookie = cookie;
    return next();
  });

  router.post('/auth/logout', (req, res) => {
    sessions.destroy(req.sessionCookie);
    res.set('Set-Cookie', sessionCookie('', { secure: secureCookies, maxAgeSec: 0 }));
    res.json({ authenticated: false });
  });

  // ── Overview ────────────────────────────────────────────────────────────
  router.get('/status', wrap(async (_req, res) => {
    let argusStatus;
    try {
      argusStatus = await argus.health();
    } catch (err) {
      argusStatus = { reachable: false, code: err.code || 'ARGUS_UNAVAILABLE' };
    }
    let registryState;
    try {
      const apps = registry.read();
      registryState = { ok: true, applications: apps.length, enabled: apps.filter((a) => a.enabled).length };
    } catch (err) {
      registryState = { ok: false, code: err.code || 'INTERNAL' };
    }
    res.json({ manage: { status: 'ok', env }, argus: argusStatus, registry: registryState });
  }));

  // ── Registry (bmb-data) ─────────────────────────────────────────────────
  router.get('/registry', (_req, res) => {
    res.json({ applications: registry.read(), source: registry.source });
  });

  router.get('/registry/:app', wrap(async (req, res) => {
    const entry = registry.get(req.params.app);
    if (!entry) throw new AppError('RESOURCE_NOT_FOUND', 'Application is not registered');
    let status;
    try {
      status = await argus.appStatus(entry.application);
    } catch (err) {
      status = { unavailable: true, code: err.code || 'ARGUS_UNAVAILABLE' };
    }
    res.json({ entry, status });
  }));

  const checkEntry = (body) => {
    const { valid, errors } = validateRegistryEntry(body);
    if (!valid) throw new AppError('VALIDATION_FAILED', 'Registry entry failed validation', { errors });
    return body;
  };

  router.post('/registry', wrap(async (req, res) => {
    res.status(201).json(await registry.create(checkEntry(req.body)));
  }));

  router.put('/registry/:app', wrap(async (req, res) => {
    res.json(await registry.replace(req.params.app, checkEntry(req.body)));
  }));

  router.patch('/registry/:app/enabled', wrap(async (req, res) => {
    res.json(await registry.setEnabled(req.params.app, req.body && req.body.enabled));
  }));

  router.post('/registry/retry-push', wrap(async (_req, res) => {
    res.json(await registry.retryPush());
  }));

  // ── Operations (forwarded to Argus) ─────────────────────────────────────
  router.get('/operations', wrap(async (req, res) => {
    const application = req.query.application ? String(req.query.application) : undefined;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
    res.json(await argus.listOperations({ application, limit }));
  }));

  router.get('/operations/:id', wrap(async (req, res) => {
    res.json(await argus.getOperation(req.params.id));
  }));

  const OPERATION_KEYS = ['operation', 'application', 'params'];

  router.post('/operations', wrap(async (req, res) => {
    const body = req.body || {};
    const unknown = Object.keys(body).filter((k) => !OPERATION_KEYS.includes(k));
    if (unknown.length) throw new AppError('UNKNOWN_KEY', 'Unknown key(s) in request', { unknown });
    if (!ARGUS_OPERATIONS.includes(body.operation)) throw new AppError('UNSUPPORTED_OPERATION', 'Unsupported operation');
    const entry = registry.get(String(body.application || ''));
    if (!entry) throw new AppError('RESOURCE_NOT_FOUND', 'Application is not registered');
    if (!entry.enabled) throw new AppError('TARGET_DISABLED', 'Application is disabled; enable it before requesting operations');
    const out = await argus.submit(body.operation, entry.application, body.params);
    res.status(202).json({ ...out, accepted: true, note: 'Accepted for execution — follow the operation for its result.' });
  }));

  // ── PM2 reconciliation ──────────────────────────────────────────────────
  router.post('/reconcile/:app', wrap(async (req, res) => {
    const entry = registry.get(req.params.app);
    if (!entry) throw new AppError('RESOURCE_NOT_FOUND', 'Application is not registered');
    if (!entry.enabled) throw new AppError('TARGET_DISABLED', 'Application is disabled');
    if (entry.type !== 'node') throw new AppError('VALIDATION_FAILED', 'Only node applications have PM2 processes');
    res.status(202).json(await argus.submit('pm2.reconcile', entry.application));
  }));

  router.post('/reconcile', wrap(async (req, res) => {
    if (!req.body || req.body.confirm !== GLOBAL_RECONCILE_CONFIRMATION) {
      throw new AppError('VALIDATION_FAILED', `Global reconcile requires confirm: "${GLOBAL_RECONCILE_CONFIRMATION}"`);
    }
    const results = [];
    const skipped = [];
    for (const entry of registry.read()) {
      if (!entry.enabled) { skipped.push({ application: entry.application, reason: 'disabled' }); continue; }
      if (entry.type !== 'node') { skipped.push({ application: entry.application, reason: 'static (no PM2)' }); continue; }
      if (entry.environment === 'test') { skipped.push({ application: entry.application, reason: 'test entry' }); continue; }
      try {
        // Independent per-app request; one failure never hides the others.
        results.push({ application: entry.application, ...(await argus.submit('pm2.reconcile', entry.application)) });
      } catch (err) {
        results.push({ application: entry.application, refused: true, error: sanitizeError(err) });
      }
    }
    res.status(202).json({ results, skipped });
  }));

  // ── Canonical data: admin writes, comparison, operations ───────────────
  if (resources && dataRepo) {
    const opts = (req) => ({
      ifRevision: req.body && req.body.ifRevision !== undefined ? req.body.ifRevision : undefined,
      idempotencyKey: req.get('idempotency-key') ? String(req.get('idempotency-key')).slice(0, 128) : undefined
    });
    // 200 = saved (on GitHub, read back); 202 = committed locally, push pending.
    const send = (res, out) => res.status(out.persistence.status === 'pending-push' ? 202 : 200).json(out);
    const opError = (out) => {
      if (out.persistence.status === 'blocked' || out.persistence.status === 'failed') {
        const e = out.persistence.error || {};
        throw new AppError(e.code || 'OPERATION_FAILED', e.message || 'Data operation did not complete', { operationId: out.persistence.operationId, status: out.persistence.status });
      }
      return out;
    };
    const bodyOf = (req, field) => {
      if (!req.body || typeof req.body !== 'object') throw new AppError('VALIDATION_FAILED', 'JSON body required');
      const unknown = Object.keys(req.body).filter((k) => k !== field && k !== 'ifRevision');
      if (unknown.length) throw new AppError('UNKNOWN_KEY', 'Unknown key(s) in request', { unknown });
      if (req.body[field] === undefined) throw new AppError('VALIDATION_FAILED', `"${field}" is required`);
      return req.body[field];
    };

    router.put('/data/resources/:key', wrap(async (req, res) => {
      send(res, opError(await resources.replace(req.params.key, bodyOf(req, 'data'), opts(req))));
    }));
    router.post('/data/resources/:key/items', wrap(async (req, res) => {
      send(res, opError(await resources.createItem(req.params.key, bodyOf(req, 'item'), opts(req))));
    }));
    router.put('/data/resources/:key/items/:id', wrap(async (req, res) => {
      send(res, opError(await resources.updateItem(req.params.key, req.params.id, bodyOf(req, 'item'), opts(req))));
    }));
    router.delete('/data/resources/:key/items/:id', wrap(async (req, res) => {
      send(res, opError(await resources.deleteItem(req.params.key, req.params.id, opts(req))));
    }));
    router.post('/data/transactions', wrap(async (req, res) => {
      send(res, opError(await resources.transaction(bodyOf(req, 'changes'), opts(req))));
    }));
    router.get('/data/resources/:key/compare', (req, res) => {
      res.json(resources.compare(req.params.key));
    });
    router.get('/data/status', wrap(async (_req, res) => {
      let catalogState;
      try {
        const list = resources.catalog.list();
        catalogState = { ok: true, resources: list.length, imported: list.filter((e) => e.status === 'imported').length };
      } catch (err) {
        catalogState = { ok: false, error: sanitizeError(err) };
      }
      res.json({ repository: await dataRepo.status(), catalog: catalogState });
    }));
    router.get('/data/operations', (req, res) => {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
      const kind = req.query.kind === 'sync' || req.query.kind === 'mutation' ? req.query.kind : undefined;
      res.json({ operations: dataRepo.listOps({ limit, kind }) });
    });
    router.get('/data/operations/:id', (req, res) => {
      const op = dataRepo.getOp(req.params.id);
      if (!op) throw new AppError('RESOURCE_NOT_FOUND', 'Data operation not found');
      res.json(op);
    });
    router.post('/data/operations/:id/retry', wrap(async (req, res) => {
      const op = await dataRepo.retry(req.params.id);
      res.status(op.status === 'pending-push' ? 202 : op.status === 'blocked' || op.status === 'failed' ? 409 : 200).json(op);
    }));
  }

  // ── Content domains: Stage 8 (legacy Manage keeps these meanwhile) ──────
  const later = (name) => (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED', message: `Not implemented yet: ${name}` });
  router.get('/home', later('GET /home'));
  router.get('/blog/categories', later('GET /blog/categories'));
  router.get('/blog/:category', later('GET /blog/:category'));
  router.get('/projects', later('GET /projects'));
  router.get('/photos', later('GET /photos'));
  router.get('/minis/posts', later('GET /minis/posts'));

  router.use((_req, res) => res.status(404).json({ code: 'RESOURCE_NOT_FOUND', message: 'Not found' }));

  router.use((err, _req, res, _next) => res.status(statusFor(err)).json(sanitizeError(err)));
  return router;
}
