import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateRegistryEntry,
  validateArgusDeploy,
  validateCatalogEntry,
  compareDeclaration
} from '../shared/schemas/index.js';

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

test('valid registry entry passes', () => {
  assert.equal(validateRegistryEntry(fixture('registry.valid.json')).valid, true);
});

test('invalid registry type fails (enum)', () => {
  const r = validateRegistryEntry(fixture('registry.invalid-type.json'));
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test('unknown key is rejected (additionalProperties false)', () => {
  const r = validateRegistryEntry(fixture('registry.invalid-unknown-key.json'));
  assert.equal(r.valid, false);
});

test('valid argus.deploy declaration passes', () => {
  assert.equal(validateArgusDeploy(fixture('declaration.valid.json')).valid, true);
});

test("the repo's own argus.deploy.json is valid", () => {
  const own = JSON.parse(readFileSync(fileURLToPath(new URL('../argus.deploy.json', import.meta.url)), 'utf8'));
  assert.equal(validateArgusDeploy(own).valid, true);
});

test('valid catalog entry passes', () => {
  assert.equal(validateCatalogEntry(fixture('catalog.valid.json')).valid, true);
});

test('catalog path traversal is rejected', () => {
  assert.equal(validateCatalogEntry(fixture('catalog.invalid-traversal.json')).valid, false);
});

test('declaration matching registry reports match', () => {
  const registry = {
    application: 'manage-beyondmebtw',
    repository: 'git@github.com:pranav1211/manage-beyondmebtw.git',
    branch: 'main',
    type: 'node',
    deploymentPath: '/projects/manage',
    domain: 'manage.beyondmebtw.com',
    isPrimaryDomain: true,
    pm2Config: 'manage.config.js',
    nginxConfig: 'manage.conf',
    enabled: true
  };
  const { match, mismatches } = compareDeclaration(registry, fixture('declaration.valid.json'));
  assert.equal(match, true);
  assert.equal(mismatches.length, 0);
});

test('declaration mismatch is surfaced, registry stays authoritative', () => {
  const registry = {
    application: 'manage-beyondmebtw',
    repository: 'git@github.com:pranav1211/manage-beyondmebtw.git',
    branch: 'main',
    type: 'node',
    deploymentPath: '/projects/manage',
    domain: 'manage.beyondmebtw.com',
    isPrimaryDomain: true,
    pm2Config: 'manage.config.js',
    nginxConfig: 'manage.conf',
    enabled: true
  };
  const declaration = { ...fixture('declaration.valid.json'), branch: 'dev' };
  const { match, mismatches } = compareDeclaration(registry, declaration);
  assert.equal(match, false);
  const branchMismatch = mismatches.find((m) => m.field === 'branch');
  assert.ok(branchMismatch);
  assert.equal(branchMismatch.registry, 'main'); // registry value preserved
  assert.equal(branchMismatch.declaration, 'dev');
});
