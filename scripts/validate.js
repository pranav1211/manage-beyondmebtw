// Deterministic schema/config validation gate (npm run validate).
// Validates the repo's own argus.deploy.json plus fixtures against their
// expected outcomes. Exits non-zero if any expectation is violated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateRegistryEntry,
  validateArgusDeploy,
  validateCatalogEntry
} from '../shared/schemas/index.js';
import { loadConfig } from '../shared/config/index.js';

function read(relToRepo) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../${relToRepo}`, import.meta.url)), 'utf8'));
}

const checks = [
  ['argus.deploy.json (self)', () => validateArgusDeploy(read('argus.deploy.json')).valid, true],
  ['fixtures/registry.valid', () => validateRegistryEntry(read('tests/fixtures/registry.valid.json')).valid, true],
  ['fixtures/registry.invalid-type', () => validateRegistryEntry(read('tests/fixtures/registry.invalid-type.json')).valid, false],
  ['fixtures/registry.invalid-unknown-key', () => validateRegistryEntry(read('tests/fixtures/registry.invalid-unknown-key.json')).valid, false],
  ['fixtures/declaration.valid', () => validateArgusDeploy(read('tests/fixtures/declaration.valid.json')).valid, true],
  ['fixtures/catalog.valid', () => validateCatalogEntry(read('tests/fixtures/catalog.valid.json')).valid, true],
  ['fixtures/catalog.invalid-traversal', () => validateCatalogEntry(read('tests/fixtures/catalog.invalid-traversal.json')).valid, false]
];

let failures = 0;
for (const [name, run, expected] of checks) {
  let actual;
  try {
    actual = run();
  } catch (err) {
    console.error(`✗ ${name} — threw: ${err.message}`);
    failures++;
    continue;
  }
  if (actual === expected) {
    console.log(`✓ ${name} (valid=${actual})`);
  } else {
    console.error(`✗ ${name} — expected valid=${expected}, got valid=${actual}`);
    failures++;
  }
}

// Config loader must boot with local defaults.
try {
  loadConfig({ env: {} });
  console.log('✓ config loads with local defaults');
} catch (err) {
  console.error(`✗ config load failed: ${err.message}`);
  failures++;
}

if (failures > 0) {
  console.error(`\nvalidate: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nvalidate: all checks passed');
