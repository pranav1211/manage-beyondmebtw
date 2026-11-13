// Manage API service entry point (control/data plane).
// Stage 1: boots, loads validated config, exposes /health and the /api/v1
// router scaffold. No canonical data wiring and no direct deployment execution
// — infrastructure operations are delegated to Argus (Stage 5+).

import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from '../../shared/config/index.js';
import { sanitizeError } from '../../shared/errors.js';
import { createV1Router } from './routes/v1.js';

export function createApp(config = loadConfig()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'manage-api', env: config.nodeEnv });
  });

  app.use('/api/v1', createV1Router());

  app.use((_req, res) => {
    res.status(404).json({ code: 'RESOURCE_NOT_FOUND', message: 'Not found' });
  });

  // Sanitized error boundary — never leak internals or secrets.

  app.use((err, _req, res, _next) => {
    res.status(500).json(sanitizeError(err));
  });

  return app;
}

export function start(config = loadConfig()) {
  const app = createApp(config);
  const server = app.listen(config.manageApiPort, () => {
    console.log(`[manage-api] listening on :${config.manageApiPort} (${config.nodeEnv})`);
  });
  return server;
}

// Start only when run directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start();
}
