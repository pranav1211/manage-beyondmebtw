// Fixtures for canonical-data tests: a local bare "origin" + checkout seeded
// with a synthetic catalog, resource schemas and data files. No network, no
// production data.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmp, git } from './argus-fixtures.js';
import { createDataRepo } from '../../shared/data/data-repo.js';

const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost'];

export const NOTES_SCHEMA = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        additionalProperties: false,
        properties: { id: { type: 'string', pattern: '^[a-z0-9-]+$' }, text: { type: 'string', maxLength: 500 } }
      }
    }
  }
};

export const LIST_SCHEMA = { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } };

export const BASE_CATALOG = {
  schemaVersion: 1,
  resources: [
    {
      key: 'notes',
      title: 'Synthetic public notes',
      owner: 'fixture',
      root: 'data',
      path: 'notes/notes.json',
      format: 'json',
      access: 'public',
      status: 'imported',
      operations: ['read', 'replace', 'create-item', 'update-item', 'delete-item'],
      items: { pointer: '/items', idField: 'id' },
      schemaRef: 'notes',
      source: { repository: 'fixture/legacy', path: 'notes.json' }
    },
    {
      key: 'secret.notes',
      root: 'data',
      path: 'private/secret-notes.json',
      format: 'json',
      access: 'private',
      status: 'imported',
      operations: ['read', 'replace'],
      schemaRef: 'notes'
    },
    {
      key: 'list',
      root: 'data',
      path: 'list/list.json',
      format: 'json',
      access: 'public',
      status: 'imported',
      operations: ['read', 'replace', 'create-item'],
      items: { pointer: '', idField: 'id' },
      schemaRef: 'list'
    },
    { key: 'mapped.only', root: 'data', path: 'mapped/mapped.json', format: 'json', access: 'public', status: 'mapped', operations: ['read'] }
  ]
};

export const j = (o) => JSON.stringify(o, null, 2) + '\n';

export function seedFiles(catalog = BASE_CATALOG) {
  return {
    'catalog/catalog.json': j(catalog),
    'catalog/schemas/notes.schema.json': j(NOTES_SCHEMA),
    'catalog/schemas/list.schema.json': j(LIST_SCHEMA),
    'data/notes/notes.json': j({ items: [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }] }),
    'data/private/secret-notes.json': j({ items: [{ id: 'p', text: 'private' }] }),
    'data/list/list.json': j([{ id: 1 }, { id: 2 }]),
    'registry/applications.json': j({ applications: [] })
  };
}

function writeAll(root, files) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

/** Bare origin + Manage checkout + a second "developer" clone. */
export function makeSeededDataRepo(files = seedFiles()) {
  const base = tmp('bmbdata-');
  const bare = join(base, 'origin.git');
  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  writeAll(seed, files);
  git(seed, ['add', '-A']);
  git(seed, [...ID, 'commit', '-q', '-m', 'seed']);
  git(base, ['clone', '-q', '--bare', seed, bare]);
  const checkout = join(base, 'checkout');
  git(base, ['clone', '-q', bare, checkout]);
  const dev = join(base, 'dev');
  git(base, ['clone', '-q', bare, dev]);
  return { base, bare, checkout, dev, stateRoot: join(base, 'state') };
}

export function devCommit(repo, files, message = 'dev edit') {
  git(repo.dev, ['pull', '-q', '--ff-only']);
  writeAll(repo.dev, files);
  git(repo.dev, ['add', '-A']);
  git(repo.dev, [...ID, 'commit', '-q', '-m', message]);
  git(repo.dev, ['push', '-q', 'origin', 'HEAD:main']);
  return git(repo.dev, ['rev-parse', 'HEAD']);
}

export function openRepo(repo, opts = {}) {
  return createDataRepo({
    root: repo.checkout,
    branch: 'main',
    expectedRemote: repo.bare,
    stateRoot: repo.stateRoot,
    pushBackoffMs: [10, 10],
    ...opts
  });
}

export const commitCount = (repo, ref = 'main') => Number(git(repo.bare, ['rev-list', '--count', ref]));
