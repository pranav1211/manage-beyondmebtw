// Authoritative application registry (Manage-owned) as read by Argus.
//
// Stage 3+4: Manage's registry CRUD API is Stage 5, so Argus reads the
// registry from the Manage-owned canonical store (data/registry/applications.json).
// The whole registry fails closed: one invalid entry rejects the load.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { validateRegistryEntry } from '../../shared/schemas/index.js';

export function loadRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    throw new AppError('CONFIG_MISSING', 'Application registry not found');
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    throw new AppError('REGISTRY_INVALID', 'Application registry is not valid JSON');
  }
  const apps = Array.isArray(doc && doc.applications) ? doc.applications : null;
  if (!apps) throw new AppError('REGISTRY_INVALID', 'Registry must contain an "applications" array');

  const byName = new Map();
  for (const entry of apps) {
    const { valid, errors } = validateRegistryEntry(entry);
    if (!valid) {
      throw new AppError('REGISTRY_INVALID', 'Registry entry failed validation', {
        application: entry && entry.application,
        errors
      });
    }
    if (byName.has(entry.application)) {
      throw new AppError('REGISTRY_INVALID', 'Duplicate registry application', { application: entry.application });
    }
    byName.set(entry.application, Object.freeze({ ...entry }));
  }
  return Object.freeze({
    entries: byName,
    get: (name) => byName.get(name) || null,
    // Match a GitHub `owner/repo` full name to its registry entry.
    findByFullName(fullName) {
      const want = `git@github.com:${String(fullName || '').toLowerCase()}.git`;
      for (const e of byName.values()) {
        if (e.repository.toLowerCase() === want) return e;
      }
      return null;
    },
    nodeApplications: () => [...byName.values()].filter((e) => e.type === 'node')
  });
}

// Stable hash of a registry entry's desired deployment state (idempotency key).
export function entryHash(entry) {
  const keys = Object.keys(entry).sort();
  const canonical = JSON.stringify(entry, keys);
  return createHash('sha256').update(canonical).digest('hex');
}
