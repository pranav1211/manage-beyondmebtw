// Argus — deployment/infrastructure execution service (Stage 3+4).
//
// Boundaries (locked):
//   - Binds to 127.0.0.1 only (enforced in shared/config).
//   - Private API: every privileged route requires the ARGUS_INTERNAL_TOKEN
//     bearer token (fails closed when no token is configured).
//   - Typed operations only, schema-validated, unknown fields rejected.
//     There is NO arbitrary shell/command endpoint.
//   - Execution is DISABLED by default. It is only enabled by the explicit
//     isolated-test configuration (ARGUS_MODE=isolated-test + non-production
//     PROJECTS_ROOT) — see shared/config.
//   - The browser never talks to Argus; only the Manage API does.
//
// Bootstrap exception: Argus is the one process that is started by hand (its
// own PM2 entry is part of the documented bootstrap). It is never used to
// hand-author another application's PM2 config — those are Argus-generated.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { loadConfig } from '../../shared/config/index.js';
import { AppError, ERROR_CODES, sanitizeError } from '../../shared/errors.js';
import { ARGUS_OPERATIONS } from '../../shared/contracts/manage-argus.js';
import { validateOperationRequest } from '../../shared/schemas/index.js';
import { assertKnownKeys } from '../../shared/validation/paths.js';
import { resolveConfigRepoRoot } from '../../shared/config-repo/index.js';
import { loadRegistry } from './registry.js';
import { parseWebhook } from './webhook.js';
import { OperationStore } from './operations.js';
import { Mutex, AppScheduler } from './locks.js';
import { createLifecycle } from './lifecycle.js';
import { createNginxRunner } from './nginx.js';

const PARAM_KEYS = Object.freeze({
  deploy: ['commit'],
  build: [],
  'nginx.validate': ['file'],
  'nginx.apply': ['file']
});

const STATUS_FOR = {
  SIGNATURE_INVALID: 401,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  UNKNOWN_TARGET: 404,
  RESOURCE_NOT_FOUND: 404,
  TARGET_DISABLED: 409,
  EXECUTION_DISABLED: 503,
  NOT_IMPLEMENTED: 501
};

function statusFor(err) {
  return (err && STATUS_FOR[err.code]) || (err instanceof AppError ? 400 : 500);
}

export function buildContext(config, overrides = {}) {
  const s = config.argus;
  const env = overrides.env || process.env;
  return {
    config,
    env,
    store: new OperationStore(s.stateRoot),
    infraLock: new Mutex(),
    loadRegistry: () => loadRegistry(resolve(s.registryPath)),
    resolveRemote: (entry) => entry.repository,
    projectsRoot: s.projectsRoot,
    configRepo: {
      root: resolveConfigRepoRoot(config.configRepoRoot),
      branch: s.configRepoBranch,
      expectedRemote: undefined
    },
    // Resolve ONLY the declared secret names, in memory, at reconcile time.
    secretEnv: (refs) => Object.fromEntries(refs.filter((r) => env[r] !== undefined).map((r) => [r, env[r]])),
    staticHealthUrl: (entry) => `https://${entry.domain}/index.html`,
    healthOpts: { attempts: 10, intervalMs: 500 },
    pm2SettleMs: 2500,
    nginxRunner: s.nginxBin && s.nginxPrefix ? createNginxRunner({ bin: s.nginxBin, prefix: s.nginxPrefix }) : null,
    ...overrides
  };
}

export function createApp(config = loadConfig(), overrides = {}) {
  const app = express();
  const executionEnabled = config.argus.executionEnabled;
  // Context is only built when execution is enabled (no state/registry/repo
  // access in the default disabled mode).
  const ctx = executionEnabled ? buildContext(config, overrides) : null;

  let scheduler = null;
  const appLocks = new Map();
  const appLock = (name) => {
    if (!appLocks.has(name)) appLocks.set(name, new Mutex());
    return appLocks.get(name);
  };
  let lifecycle = null;
  if (ctx) {
    lifecycle = createLifecycle(ctx);
    scheduler = new AppScheduler(
      (job) => appLock(job.application).withLock(() => lifecycle.runOperation(job), 30 * 60_000),
      (superseded, by) =>
        ctx.store.block(superseded.operationId, 'SUPERSEDED', 'Superseded by a newer pending commit', {
          supersededBy: by.operationId
        })
    );
  }

  // Exposed for tests / graceful shutdown only.
  app.locals.argus = { ctx, scheduler, appLock };

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'argus',
      mode: config.argus.mode,
      env: config.nodeEnv,
      executionEnabled,
      operations: ARGUS_OPERATIONS
    });
  });

  // ── GitHub webhook (signature-authenticated, not token) ──────────────────
  app.post('/webhook', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    if (!ctx) {
      return res.status(503).json({ code: ERROR_CODES.EXECUTION_DISABLED, message: 'Argus execution is disabled' });
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    let parsed;
    try {
      parsed = parseWebhook({ headers, rawBody: req.body, registry: ctx.loadRegistry(), env: ctx.env });
    } catch (err) {
      ctx.store.audit({ kind: 'webhook-rejected', code: err.code || 'INTERNAL', delivery: headers['x-github-delivery'] || null });
      return res.status(statusFor(err)).json(sanitizeError(err));
    }

    if (parsed.kind === 'ping') return res.status(200).json({ message: 'pong', application: parsed.application });

    const record = ctx.store.create({
      operation: 'deploy',
      application: parsed.application,
      params: { commit: parsed.commit, ref: parsed.ref, trigger: 'webhook', delivery: headers['x-github-delivery'] || null }
    });

    if (parsed.kind === 'noop') {
      ctx.store.succeed(record.operationId, { noop: true, reason: parsed.reason });
      return res.status(200).json({ operationId: record.operationId, noop: true, reason: parsed.reason });
    }

    const submitted = scheduler.submit({
      operationId: record.operationId,
      operation: 'deploy',
      application: parsed.application,
      commit: parsed.commit
    });
    return res.status(202).json({ operationId: record.operationId, ...submitted });
  });

  // ── Private, token-authenticated API ─────────────────────────────────────
  const requireToken = (req, res, next) => {
    const token = process.env.ARGUS_INTERNAL_TOKEN || (overrides.env && overrides.env.ARGUS_INTERNAL_TOKEN);
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    const ok =
      Boolean(token) &&
      given.length === token.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) return res.status(401).json({ code: ERROR_CODES.UNAUTHENTICATED, message: 'Authentication required' });
    return next();
  };

  app.post('/operations', requireToken, express.json({ limit: '64kb', strict: true }), (req, res) => {
    const body = req.body || {};
    const { valid, errors } = validateOperationRequest(body);
    if (!valid) {
      return res.status(400).json({ code: ERROR_CODES.VALIDATION_FAILED, message: 'Invalid operation request', details: { errors } });
    }
    try {
      assertKnownKeys(body.params || {}, PARAM_KEYS[body.operation] || []);
    } catch (err) {
      return res.status(400).json(sanitizeError(err));
    }
    if (!ctx) {
      return res.status(501).json({ code: ERROR_CODES.NOT_IMPLEMENTED, message: 'Argus execution is disabled in this configuration' });
    }

    const record = ctx.store.create({ operation: body.operation, application: body.application, params: body.params });
    const job = { operationId: record.operationId, operation: body.operation, application: body.application, params: body.params || {} };

    if (body.operation === 'deploy' || body.operation === 'build') {
      if (body.params && body.params.commit) job.commit = body.params.commit;
      const submitted = scheduler.submit(job);
      return res.status(202).json({ operationId: record.operationId, ...submitted });
    }
    // Other typed operations serialize on the same per-app lock.
    appLock(body.application)
      .withLock(() => lifecycle.runOperation(job), 30 * 60_000)
      .catch((err) => ctx.store.fail(record.operationId, null, err));
    return res.status(202).json({ operationId: record.operationId, started: true });
  });

  app.get('/operations/:id', requireToken, (req, res) => {
    if (!ctx) return res.status(501).json({ code: ERROR_CODES.NOT_IMPLEMENTED, message: 'Argus execution is disabled' });
    try {
      const rec = ctx.store.get(req.params.id);
      if (!rec) return res.status(404).json({ code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Operation not found' });
      return res.json(rec);
    } catch (err) {
      return res.status(statusFor(err)).json(sanitizeError(err));
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Not found' });
  });


  app.use((err, _req, res, _next) => {
    res.status(statusFor(err)).json(sanitizeError(err));
  });

  return app;
}

export function start(config = loadConfig()) {
  const app = createApp(config);
  // Bind to localhost ONLY — enforced here and validated in loadConfig.
  return app.listen(config.argusPort, config.argusBind, () => {
    console.log(
      `[argus] listening on ${config.argusBind}:${config.argusPort} (mode=${config.argus.mode}, execution=${config.argus.executionEnabled ? 'ENABLED' : 'disabled'})`
    );
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start();
}
