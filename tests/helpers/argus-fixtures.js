// Shared fixtures for Argus tests. Everything is created under a temp root
// (ARGUS_TEST_TMP if set — e.g. a D: scratch dir — else the OS temp dir) and
// uses local bare Git repos only: no network, no production paths, dummy secrets.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

export function testBase() {
  const b = process.env.ARGUS_TEST_TMP || tmpdir();
  mkdirSync(b, { recursive: true });
  return b;
}

export function tmp(prefix) {
  return mkdtempSync(join(testBase(), prefix));
}

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost'];

function writeFiles(root, files) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

/** A work repo + its bare "origin". Returns paths + head commit. */
export function makeRepo(files, { branch = 'main' } = {}) {
  const base = tmp('repo-');
  const work = join(base, 'work');
  const bare = join(base, 'origin.git');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', branch]);
  writeFiles(work, files);
  git(work, ['add', '-A']);
  git(work, [...ID, 'commit', '-q', '-m', 'init']);
  git(base, ['clone', '-q', '--bare', work, bare]);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['fetch', '-q', 'origin']);
  git(work, ['branch', '-q', `--set-upstream-to=origin/${branch}`]);
  return { base, work, bare, branch, head: git(work, ['rev-parse', 'HEAD']) };
}

/** Commit file changes in a work repo and push to its origin. Returns new head. */
export function commitAndPush(repo, files, message = 'update') {
  writeFiles(repo.work, files);
  git(repo.work, ['add', '-A']);
  git(repo.work, [...ID, 'commit', '-q', '-m', message]);
  git(repo.work, ['push', '-q', 'origin', `HEAD:${repo.branch}`]);
  return git(repo.work, ['rev-parse', 'HEAD']);
}

export const BASE_MANIFEST = Object.freeze({
  schemaVersion: 1,
  repository: 'git@github.com:pranav1211/bmb-infrastructure.git',
  branch: 'main',
  revision: null,
  configRoots: { pm2: 'infrastructure/config/pm2', nginx: 'infrastructure/config/nginx' },
  pm2: [],
  nginx: [{ host: 'fixture.local', file: 'fixture.conf', owner: 'node-ok' }],
  excluded: ['rtf-git', 'rtf-web']
});

/** A Config Repo origin + an Argus checkout cloned from it. */
export function makeConfigRepo(extraFiles = {}) {
  const repo = makeRepo({
    'infrastructure/config/manifest.json': JSON.stringify(BASE_MANIFEST, null, 2) + '\n',
    'infrastructure/config/pm2/README.md': 'pm2 (fixture)\n',
    'infrastructure/config/nginx/README.md': 'nginx (fixture)\n',
    ...extraFiles
  });
  const checkout = join(repo.base, 'checkout');
  git(repo.base, ['clone', '-q', repo.bare, checkout]);
  return { ...repo, checkout };
}

export function nodeAppSource() {
  return [
    "const http = require('http');",
    'const port = Number(process.env.PORT);',
    'http.createServer((req, res) => {',
    "  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }",
    "  res.writeHead(404); res.end('not found');",
    "}).listen(port, '127.0.0.1');",
    ''
  ].join('\n');
}

export function registryEntry(application, { type = 'node', enabled = true, branch = 'main', secretRef } = {}) {
  const e = {
    application,
    repository: `git@github.com:fixture/${application}.git`,
    branch,
    type,
    deploymentPath: `/projects/${application}`,
    domain: `${application}.local`,
    isPrimaryDomain: false,
    pm2Config: type === 'node' ? `${application}.config.js` : null,
    nginxConfig: null,
    enabled
  };
  if (secretRef) e.webhookSecretRef = secretRef;
  return e;
}

export function declarationFor(entry, runtime) {
  const { enabled: _enabled, webhookSecretRef: _ref, ...decl } = entry;
  return runtime ? { ...decl, runtime } : decl;
}

export function writeRegistry(dir, entries) {
  const p = join(dir, 'applications.json');
  writeFileSync(p, JSON.stringify({ applications: entries }, null, 2));
  return p;
}

export function signedPush({ fullName, ref = 'refs/heads/main', after, secret }) {
  const body = Buffer.from(JSON.stringify({ ref, after, repository: { full_name: fullName } }));
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return { body, sig };
}

/** Stop the (isolated, test) PM2 daemon out-of-process via the PM2 CLI. */
export function killPm2Daemon(pm2Home) {
  const bin = fileURLToPath(new URL('../../node_modules/pm2/bin/pm2', import.meta.url));
  try {
    execFileSync(process.execPath, [bin, 'kill'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 30_000
    });
  } catch {
    /* already stopped */
  }
}

export function serve(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port, address } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        address,
        close: () => {
          server.closeAllConnections(); // drop fetch keep-alive sockets
          return new Promise((r) => server.close(r));
        }
      });
    });
  });
}

export async function waitForOp(base, token, id, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/operations/${id}`, { headers: { authorization: `Bearer ${token}` } });
    const rec = await res.json();
    if (['succeeded', 'failed', 'blocked'].includes(rec.status)) return rec;
    if (Date.now() > end) throw new Error(`operation ${id} did not finish (status=${rec.status}, stage=${rec.stage})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
