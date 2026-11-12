// Manage <-> Argus internal contract (DEFINITIONS ONLY — not wired in Stage 1).
//
// Boundary rules (locked architecture):
// - Manage API is the only caller of Argus. The browser never calls Argus.
// - Argus listens on localhost only and authenticates every call with a shared
//   token (ARGUS_INTERNAL_TOKEN).
// - Argus exposes a fixed set of typed operations. There is NO arbitrary
//   shell/command endpoint.
// - Long-running operations return an operationId; Manage polls status.

// The explicit, closed set of Argus operations.
export const ARGUS_OPERATIONS = Object.freeze([
  'build',
  'deploy',
  'sync',
  'pm2.reconcile',
  'pm2.start',
  'pm2.stop',
  'pm2.restart',
  'pm2.reload',
  'nginx.validate',
  'nginx.apply',
  'health'
]);

// Operation lifecycle states surfaced to Manage.
export const OPERATION_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  BLOCKED: 'blocked'
});

// Deployment pipeline stages (fail-fast; no automatic rollback).
export const DEPLOY_STAGES = Object.freeze([
  'identify',
  'load-config',
  'validate-declaration',
  'sync',
  'deploy',
  'pm2-reconcile',
  'health-check'
]);

/**
 * Shape of an operation request Manage sends to Argus.
 * (Reference shape for Stage 2 implementation — not validated here yet.)
 * @typedef {Object} ArgusOperationRequest
 * @property {string} operation  one of ARGUS_OPERATIONS
 * @property {string} application  registry application identity
 * @property {object} [params]  operation-specific, non-secret parameters
 */

/**
 * Shape of Argus's response.
 * @typedef {Object} ArgusOperationResponse
 * @property {string} operationId
 * @property {string} status  one of OPERATION_STATUS
 * @property {string} [stage]  current/last DEPLOY_STAGES value
 * @property {object} [result]  sanitized result (no secrets)
 * @property {object} [error]  sanitized error (code + message)
 */

export function isKnownOperation(op) {
  return ARGUS_OPERATIONS.includes(op);
}
