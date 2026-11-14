// Stable error codes + a sanitized error shape.
// Rule: errors never carry secret values. Messages are human-readable but must
// not echo env values, tokens, or private content. Callers map `code` to UI.

export const ERROR_CODES = Object.freeze({
  // Config / bootstrap
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
  // Auth / authorization
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  INVALID_IDENTIFIER: 'INVALID_IDENTIFIER',
  // Registry / declaration
  REGISTRY_INVALID: 'REGISTRY_INVALID',
  DECLARATION_MISMATCH: 'DECLARATION_MISMATCH',
  // Path / resource safety
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  PATH_VIOLATION: 'PATH_VIOLATION',
  ABSOLUTE_PATH: 'ABSOLUTE_PATH',
  SYMLINK_ESCAPE: 'SYMLINK_ESCAPE',
  DISALLOWED_EXTENSION: 'DISALLOWED_EXTENSION',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  // Config Repo / infrastructure
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  CONFIG_REPO_UNAVAILABLE: 'CONFIG_REPO_UNAVAILABLE',
  CONFIG_REPO_DIVERGED: 'CONFIG_REPO_DIVERGED',
  CONFIG_REPO_DIRTY: 'CONFIG_REPO_DIRTY',
  // Data repo (bmb-data)
  DATA_REPO_UNAVAILABLE: 'DATA_REPO_UNAVAILABLE',
  DATA_REPO_DIRTY: 'DATA_REPO_DIRTY',
  DATA_REPO_DIVERGED: 'DATA_REPO_DIVERGED',
  // Manage API
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  // Manage -> Argus client
  ARGUS_UNAVAILABLE: 'ARGUS_UNAVAILABLE',
  ARGUS_TIMEOUT: 'ARGUS_TIMEOUT',
  ARGUS_UNAUTHORIZED: 'ARGUS_UNAUTHORIZED',
  ARGUS_BAD_RESPONSE: 'ARGUS_BAD_RESPONSE',
  TARGET_NOT_ALLOWED: 'TARGET_NOT_ALLOWED',
  SUPERSEDED: 'SUPERSEDED',
  // Webhook / targets
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  UNKNOWN_TARGET: 'UNKNOWN_TARGET',
  TARGET_DISABLED: 'TARGET_DISABLED',
  // Execution
  EXECUTION_DISABLED: 'EXECUTION_DISABLED',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  GIT_FAILED: 'GIT_FAILED',
  PM2_FAILED: 'PM2_FAILED',
  HEALTH_CHECK_FAILED: 'HEALTH_CHECK_FAILED',
  NGINX_INVALID: 'NGINX_INVALID',
  NGINX_FAILED: 'NGINX_FAILED',
  // Operation lifecycle
  OPERATION_FAILED: 'OPERATION_FAILED',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL: 'INTERNAL'
});

export class AppError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human-readable, no secret values
   * @param {object} [details] structured, non-secret context
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.INTERNAL;
    if (details !== undefined) this.details = details;
  }
}

// Produce a client/log-safe object. Never includes stack or secrets.
export function sanitizeError(err) {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {})
    };
  }
  // Unknown error: do not leak internals.
  return { code: ERROR_CODES.INTERNAL, message: 'Internal error' };
}
