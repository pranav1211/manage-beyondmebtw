// Schema compilation + validators + registry/declaration comparison.
// Uses ajv. JSON schemas are read from disk (no import-attribute dependency).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { AppError } from '../errors.js';
import { SCHEMA_VERSION, isSupportedSchemaVersion } from './version.js';

function loadSchema(name) {
  const url = new URL(`./${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

const SCHEMA_FILES = Object.freeze({
  registry: 'application-registry.schema.json',
  argusDeploy: 'argus-deploy.schema.json',
  catalogEntry: 'catalog-entry.schema.json',
  operationRequest: 'operation-request.schema.json',
  operationRecord: 'operation-record.schema.json',
  argusEvent: 'argus-event.schema.json',
  pm2AppConfig: 'pm2-app-config.schema.json',
  nginxManifest: 'nginx-manifest.schema.json',
  configRepoManifest: 'config-repo-manifest.schema.json'
});

const ajv = new Ajv({ allErrors: true, strict: false });

const compiled = {};
const rawSchemas = {};
for (const [key, file] of Object.entries(SCHEMA_FILES)) {
  const schema = loadSchema(file);
  rawSchemas[key] = schema;
  compiled[key] = ajv.compile(schema);
}

function wrap(validateFn) {
  return (obj) => {
    const valid = validateFn(obj);
    return {
      valid: Boolean(valid),
      errors: valid ? [] : (validateFn.errors || []).map((e) => ({
        path: e.instancePath || '(root)',
        keyword: e.keyword,
        message: e.message
      }))
    };
  };
}

// Existing (Stage 1) validators — unchanged signatures.
export const validateRegistryEntry = wrap(compiled.registry);
export const validateArgusDeploy = wrap(compiled.argusDeploy);
export const validateCatalogEntry = wrap(compiled.catalogEntry);

// New (Stage 2) validators.
export const validateOperationRequest = wrap(compiled.operationRequest);
export const validateOperationRecord = wrap(compiled.operationRecord);
export const validateArgusEvent = wrap(compiled.argusEvent);
export const validatePm2AppConfig = wrap(compiled.pm2AppConfig);
export const validateNginxManifest = wrap(compiled.nginxManifest);
export const validateConfigRepoManifest = wrap(compiled.configRepoManifest);

// Generic access by key, for tooling/tests.
export function getValidator(key) {
  const fn = compiled[key];
  if (!fn) throw new AppError('INTERNAL', `No validator for schema "${key}"`);
  return wrap(fn);
}

/**
 * Validate a versioned contract object: schema validity AND a supported
 * `schemaVersion`. Returns {valid, errors}. Unsupported versions fail with a
 * stable UNSUPPORTED_SCHEMA_VERSION-style error entry rather than a raw ajv one.
 */
export function validateVersioned(key, obj) {
  if (obj && typeof obj === 'object' && 'schemaVersion' in obj && !isSupportedSchemaVersion(obj.schemaVersion)) {
    return {
      valid: false,
      errors: [{ path: '/schemaVersion', keyword: 'version', message: `Unsupported schemaVersion ${obj.schemaVersion}` }]
    };
  }
  return getValidator(key)(obj);
}

// Fields the repo-side declaration mirrors (checklist). `enabled` is registry-only.
const DECLARATION_FIELDS = Object.freeze([
  'application',
  'repository',
  'branch',
  'type',
  'deploymentPath',
  'domain',
  'isPrimaryDomain',
  'pm2Config',
  'nginxConfig'
]);

/**
 * Compare a repo-side declaration against the authoritative Manage registry
 * entry. Manage is authoritative: this surfaces mismatches, it does NOT mutate
 * either side. Deployment can proceed on the registry value.
 *
 * @returns {{ match: boolean, mismatches: Array<{field:string, registry:*, declaration:*}> }}
 */
export function compareDeclaration(registryEntry, declaration) {
  const mismatches = [];
  for (const field of DECLARATION_FIELDS) {
    const r = registryEntry ? registryEntry[field] : undefined;
    const d = declaration ? declaration[field] : undefined;
    if (r !== d) {
      mismatches.push({ field, registry: r ?? null, declaration: d ?? null });
    }
  }
  return { match: mismatches.length === 0, mismatches };
}

export { SCHEMA_VERSION, isSupportedSchemaVersion };
export const schemas = Object.freeze(rawSchemas);
export const SCHEMA_FILE_NAMES = SCHEMA_FILES;
