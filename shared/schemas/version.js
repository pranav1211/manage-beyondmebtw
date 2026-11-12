// Single source of truth for the contract schema version shared by Manage,
// Argus, and the Config Repo manifest. Bump when a contract changes shape in a
// non-backward-compatible way. Consumers reject unsupported versions.

export const SCHEMA_VERSION = 1;

// Versions this build knows how to consume.
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);

export function isSupportedSchemaVersion(v) {
  return SUPPORTED_SCHEMA_VERSIONS.includes(v);
}
