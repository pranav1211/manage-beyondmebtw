// Argus — deployment/infrastructure execution service.
//
// STAGE 1 SCOPE: entry point + local/test mode ONLY.
//   - Binds to localhost exclusively (never public).
//   - Exposes /health and an operations endpoint that REFUSES every privileged
//     operation with NOT_IMPLEMENTED.
//   - Performs NO Git sync, NO PM2 action, NO Nginx action, NO shell execution.
// Real execution (webhook verification, locks, deploy, PM2/Nginx, health) is
// implemented in Stage 3 against the locked contract.

import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from '../../shared/config/index.js';
import { ERROR_CODES, sanitizeError } from '../../shared/errors.js';
import { ARGUS_OPERATIONS, isKnownOperation } from '../../shared/contracts/manage-argus.js';

// Hard guard: Argus must never perform a privileged action in Stage 1.
function refusePrivileged(operation) {
  return {
    status: 501,
    body: {
      code: ERROR_CODES.NOT_IMPLEMENTED,
      message: `Argus operation '${operation}' is not implemented in Stage 1 (execution is disabled)`
    }
  };
}

export function createApp(config = loadConfig()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'argus',
      mode: 'local-test',
      env: config.nodeEnv,
      executionEnabled: false,
      operations: ARGUS_OPERATIONS
    });
  });

  // Typed operation endpoint. No arbitrary command endpoint exists by design.
  app.post('/operations', (req, res) => {
    const operation = req.body && req.body.operation;
    if (!isKnownOperation(operation)) {
      return res.status(400).json({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Unknown or missing operation',
        details: { allowed: ARGUS_OPERATIONS }
      });
    }
    const { status, body } = refusePrivileged(operation);
    return res.status(status).json(body);
  });

  app.use((_req, res) => {
    res.status(404).json({ code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json(sanitizeError(err));
  });

  return app;
}

export function start(config = loadConfig()) {
  const app = createApp(config);
  // Bind to localhost ONLY — enforced here and validated in loadConfig.
  const server = app.listen(config.argusPort, config.argusBind, () => {
    console.log(`[argus] listening on ${config.argusBind}:${config.argusPort} (local-test, execution disabled)`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start();
}
