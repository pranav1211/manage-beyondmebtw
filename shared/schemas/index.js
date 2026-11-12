// Schema compilation + validators + registry/declaration comparison.
// Uses ajv. JSON schemas are read from disk (no import-attribute dependency).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

function loadSchema(name) {
  const url = new URL(`./${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

const registrySchema = loadSchema('application-registry.schema.json');
const argusDeploySchema = loadSchema('argus-deploy.schema.json');
const catalogEntrySchema = loadSchema('catalog-entry.schema.json');

const ajv = new Ajv({ allErrors: true, strict: false });

const _validateRegistry = ajv.compile(registrySchema);
const _validateArgusDeploy = ajv.compile(argusDeploySchema);
const _validateCatalogEntry = ajv.compile(catalogEntrySchema);

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

export const validateRegistryEntry = wrap(_validateRegistry);
export const validateArgusDeploy = wrap(_validateArgusDeploy);
export const validateCatalogEntry = wrap(_validateCatalogEntry);

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

export const schemas = Object.freeze({
  registry: registrySchema,
  argusDeploy: argusDeploySchema,
  catalogEntry: catalogEntrySchema
});
