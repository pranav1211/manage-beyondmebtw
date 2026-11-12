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
  // Registry / declaration
  REGISTRY_INVALID: 'REGISTRY_INVALID',
  DECLARATION_MISMATCH: 'DECLARATION_MISMATCH',
  // Path / resource safety
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  DISALLOWED_EXTENSION: 'DISALLOWED_EXTENSION',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  // Operation lifecycle
  OPERATION_FAILED: 'OPERATION_FAILED',
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
