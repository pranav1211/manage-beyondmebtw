// Manage API service entry point (control plane).
// Serves the operational UI and /api/v1. Infrastructure operations are
// delegated to Argus over its private loopback API; the browser never sees
// Argus, its token, or its address.

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { loadConfig } from '../../shared/config/index.js';
import { sanitizeError } from '../../shared/errors.js';
import { createV1Router, statusFor } from './routes/v1.js';
import { SessionStore, LoginLimiter } from './auth.js';
import { createArgusClient } from './argus-client.js';
import { createRegistryStore } from './registry-store.js';
import { createResourceStore } from './resource-store.js';
import { createDataWebhookHandler, fullNameOf } from './data-webhook.js';
import { createDataRepo } from '../../shared/data/data-repo.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO_ROOT, 'apps', 'manage', 'dist');

/**
 * @param {object} config loadConfig() result
 * @param {object} [deps] test overrides: { env, argus, registry, sessions, limiter }
 */
export function createApp(config = loadConfig({ service: 'manage' }), deps = {}) {
  const env = deps.env || process.env;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // only nginx on this host may set X-Forwarded-For

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'manage-api', env: config.nodeEnv });
  });

  // Local dev without a configured secret gets a throwaway one (sessions then
  // simply don't survive restarts). Production requires it via loadConfig.
  const sessions = deps.sessions || new SessionStore({ secret: env.MANAGE_SESSION_SECRET || randomBytes(32).toString('hex') });
  const argus = deps.argus || createArgusClient({ baseUrl: config.manage.argusUrl, token: env.ARGUS_INTERNAL_TOKEN });
  // One coordinated writer for the bmb-data checkout: registry + canonical
  // data + webhook syncs share its Git lock, journal and history.
  const dataRepo =
    deps.dataRepo ||
    createDataRepo({
      root: resolve(config.manage.dataRepoRoot),
      branch: config.manage.dataRepoBranch,
      expectedRemote: config.manage.dataRepoRemote,
      stateRoot: resolve(config.manage.stateRoot)
    });
  const registry = deps.registry || createRegistryStore({ dataRepo, expectedRemote: config.manage.dataRepoRemote });
  const resources = deps.resources || createResourceStore({ dataRepo, sourceRoots: config.manage.sourceRoots });
  app.locals.dataRepo = dataRepo;

  // bmb-data webhook: raw body (exact signed bytes), before any JSON parser/session gate.
  app.post(
    '/api/v1/webhooks/bmb-data',
    express.raw({ type: () => true, limit: '1mb' }),
    createDataWebhookHandler({
      dataRepo,
      expectedFullName: deps.dataRepoFullName || fullNameOf(config.manage.dataRepoRemote),
      branch: config.manage.dataRepoBranch,
      env
    })
  );

  app.use(
    '/api/v1',
    createV1Router({
      sessions,
      limiter: deps.limiter || new LoginLimiter(),
      passwordHash: env.MANAGE_ADMIN_PASSWORD_HASH || null,
      argus,
      registry,
      resources,
      dataRepo,
      secureCookies: config.manage.secureCookies,
      env: config.nodeEnv
    })
  );

  // Operational UI (built locally, committed: apps/manage/dist).
  if (existsSync(DIST)) {
    app.use(express.static(DIST, { index: 'index.html', fallthrough: true }));
    app.get(/^\/(?!api\/|health$).*/, (_req, res) => res.sendFile(join(DIST, 'index.html')));
  }

  app.use((_req, res) => {
    res.status(404).json({ code: 'RESOURCE_NOT_FOUND', message: 'Not found' });
  });


  app.use((err, _req, res, _next) => {
    res.status(statusFor(err)).json(sanitizeError(err));
  });

  return app;
}

export async function start(config = loadConfig({ service: 'manage' })) {
  const app = createApp(config);
  // Finish or discard interrupted data operations BEFORE serving requests.
  try {
    const outcomes = await app.locals.dataRepo.recover();
    if (outcomes.length) console.log(`[manage-api] data recovery: ${JSON.stringify(outcomes)}`);
  } catch (err) {
    // Visible in /api/v1/data/status; Manage still serves reads.
    console.error(`[manage-api] data recovery failed: ${err.code || 'INTERNAL'} ${err.message}`);
  }
  // Loopback only: nginx is the sole public entry point.
  return app.listen(config.manageApiPort, '127.0.0.1', () => {
    console.log(`[manage-api] listening on 127.0.0.1:${config.manageApiPort} (${config.nodeEnv})`);
  });
}
