import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifest,
  inspect,
  resolvePm2File,
  resolveNginxFile,
  manifestPath,
  writeConfig,
  commit,
  push,
  reconcile
} from '../shared/config-repo/index.js';

const VALID_MANIFEST = {
  schemaVersion: 1,
  repository: 'git@github.com:pranav1211/bmb-infrastructure.git',
  branch: 'main',
  revision: null,
  configRoots: { pm2: 'infrastructure/config/pm2', nginx: 'infrastructure/config/nginx' },
  pm2: [{ application: 'minis', file: null, managedByArgus: true, status: 'pending' }],
  nginx: [{ host: 'minis.beyondmebtw.com', file: 'minis.conf', owner: 'minis' }],
  excluded: ['rtf-git', 'rtf-web']
};

// Build a temporary Config Repo checkout and return its root.
function makeRepo(manifest = VALID_MANIFEST) {
  const root = mkdtempSync(join(tmpdir(), 'configrepo-'));
  mkdirSync(join(root, 'infrastructure/config/pm2'), { recursive: true });
  mkdirSync(join(root, 'infrastructure/config/nginx'), { recursive: true });
  writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2));
  return root;
}

function codeOf(fn) {
  try { fn(); return null; } catch (e) { return e.code; }
}

test('loads + inspects a valid Config Repo manifest (read-only)', () => {
  const root = makeRepo();
  try {
    const { manifest } = loadManifest(root);
    assert.equal(manifest.repository, VALID_MANIFEST.repository);
    const view = inspect(root);
    assert.equal(view.branch, 'main');
    assert.deepEqual(view.excluded, ['rtf-git', 'rtf-web']);
    assert.equal(view.pm2[0].status, 'pending'); // Argus-generated later
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolves owned PM2/Nginx files; rejects traversal and bad extensions', () => {
  const root = makeRepo();
  try {
    const { manifest } = loadManifest(root);
    const p = resolvePm2File(root, manifest, 'minis.config.js');
    assert.ok(p.includes(join('infrastructure', 'config', 'pm2')));
    assert.equal(codeOf(() => resolvePm2File(root, manifest, '../../../etc/evil.js')), 'PATH_TRAVERSAL');
    assert.equal(codeOf(() => resolveNginxFile(root, manifest, 'minis.txt')), 'DISALLOWED_EXTENSION');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported manifest version is rejected', () => {
  const root = makeRepo({ ...VALID_MANIFEST, schemaVersion: 2 });
  try {
    assert.equal(codeOf(() => loadManifest(root)), 'UNSUPPORTED_SCHEMA_VERSION');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing checkout reports CONFIG_REPO_UNAVAILABLE', () => {
  assert.equal(codeOf(() => loadManifest(join(tmpdir(), 'does-not-exist-xyz'))), 'CONFIG_REPO_UNAVAILABLE');
});

test('malformed manifest reports INVALID_MANIFEST', () => {
  const root = mkdtempSync(join(tmpdir(), 'configrepo-'));
  mkdirSync(join(root, 'infrastructure/config'), { recursive: true });
  writeFileSync(manifestPath(root), '{ not json');
  try {
    assert.equal(codeOf(() => loadManifest(root)), 'INVALID_MANIFEST');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write/commit/push/reconcile are disabled in Stage 2', () => {
  for (const fn of [writeConfig, commit, push, reconcile]) {
    assert.equal(codeOf(() => fn()), 'NOT_IMPLEMENTED');
  }
});
