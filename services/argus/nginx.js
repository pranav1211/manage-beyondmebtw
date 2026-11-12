// Nginx validation/application boundary.
//
// - Candidates are development-authored files (owned per the Config Repo
//   manifest `nginx` map). Argus never invents routes.
// - Validation runs `nginx -t` against a throwaway copy of the active site set
//   with the candidate swapped in. Only a passing candidate may be activated.
// - Activation = atomic file swap, then `nginx -t` on the real config, then
//   reload. An invalid candidate never replaces the active file.
// - Every invocation is pinned to an explicit isolated prefix (`-p`) and config
//   (`-c`). The runner refuses to operate without one — no bare `nginx` calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { resolveWithinRoot } from '../../shared/validation/paths.js';
import { run, tail } from './exec.js';

const SITE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.conf$/;

export function createNginxRunner({ bin, prefix }) {
  if (!bin || !existsSync(bin)) throw new AppError('CONFIG_MISSING', 'Nginx binary is not configured/available');
  if (!prefix) throw new AppError('CONFIG_MISSING', 'Isolated Nginx prefix is not configured');
  const root = resolve(prefix).replace(/\\/g, '/');
  const pfx = root.endsWith('/') ? root : `${root}/`;
  const scrub = (s) => tail(String(s).split(pfx).join('<prefix>/').split(root).join('<prefix>'));

  return Object.freeze({
    prefix: pfx,
    sitesDir: join(root, 'conf', 'sites'),
    args: (extra, conf) => ['-p', pfx, '-c', conf, ...extra],
    async test(conf = 'conf/nginx.conf') {
      const r = await run(bin, ['-p', pfx, '-c', conf, '-t'], { cwd: root, timeout: 30_000 });
      return { ok: r.code === 0, output: scrub(r.stderr || r.stdout) };
    },
    async reload(conf = 'conf/nginx.conf') {
      const r = await run(bin, ['-p', pfx, '-c', conf, '-s', 'reload'], { cwd: root, timeout: 30_000 });
      return { ok: r.code === 0, output: scrub(r.stderr || r.stdout) };
    },
    isRunning() {
      return existsSync(join(root, 'logs', 'nginx.pid'));
    }
  });
}

function assertOwned(manifest, file) {
  if (!SITE_FILE_RE.test(String(file))) throw new AppError('NGINX_INVALID', 'Invalid Nginx config filename');
  const entry = (manifest.nginx || []).find((n) => n.file === file);
  if (!entry) throw new AppError('NGINX_INVALID', 'Nginx config is not owned by the Config Repo manifest', { file });
  return entry;
}

const MAIN_CONF = (sitesSubdir) => [
  'worker_processes 1;',
  'events { worker_connections 64; }',
  'http {',
  '  include mime.types;',
  `  include ${sitesSubdir}/*.conf;`,
  '}',
  ''
].join('\n');

/** Validate a candidate in isolation (active config untouched). */
export async function validateCandidate({ runner, manifest, file, content }) {
  const entry = assertOwned(manifest, file);
  resolveWithinRoot(runner.sitesDir, file, { allowedExtensions: ['.conf'] });

  const id = randomBytes(4).toString('hex');
  const confDir = join(runner.prefix, 'conf');
  const vDir = join(confDir, `validate-${id}`);
  mkdirSync(vDir, { recursive: true });
  try {
    if (existsSync(runner.sitesDir)) {
      for (const f of readdirSync(runner.sitesDir)) {
        if (f.endsWith('.conf') && f !== file) copyFileSync(join(runner.sitesDir, f), join(vDir, f));
      }
    }
    writeFileSync(join(vDir, file), content);
    writeFileSync(join(confDir, `validate-${id}.conf`), MAIN_CONF(`validate-${id}`));
    const result = await runner.test(`conf/validate-${id}.conf`);
    return { ok: result.ok, output: result.output, owner: entry.owner, host: entry.host };
  } finally {
    rmSync(vDir, { recursive: true, force: true });
    rmSync(join(confDir, `validate-${id}.conf`), { force: true });
  }
}

/** Validate, then atomically activate and reload. Invalid = active untouched. */
export async function applyCandidate({ runner, manifest, file, content }) {
  const validation = await validateCandidate({ runner, manifest, file, content });
  if (!validation.ok) {
    throw new AppError('NGINX_INVALID', 'Candidate failed nginx -t; active config unchanged', { output: validation.output });
  }

  mkdirSync(runner.sitesDir, { recursive: true });
  const target = join(runner.sitesDir, file);
  const previous = existsSync(target) ? readFileSync(target) : null;
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);

  const full = await runner.test('conf/nginx.conf');
  if (!full.ok) {
    // Preserve the working configuration: put the previous file back.
    if (previous) writeFileSync(target, previous);
    else rmSync(target, { force: true });
    throw new AppError('NGINX_FAILED', 'Full config failed nginx -t after swap; previous config restored', { output: full.output });
  }

  let reload = { ok: true, skipped: true };
  if (runner.isRunning()) reload = await runner.reload('conf/nginx.conf');
  if (!reload.ok) throw new AppError('NGINX_FAILED', 'nginx reload failed', { output: reload.output });
  return { validated: true, activated: true, reloaded: !reload.skipped, file, host: validation.host };
}

/** Prepare an isolated Nginx prefix (conf, mime.types, sites, logs, temp). */
export function prepareIsolatedPrefix({ prefix, mimeTypesFrom }) {
  const root = resolve(prefix);
  for (const d of ['conf/sites', 'logs', 'temp']) mkdirSync(join(root, d), { recursive: true });
  if (mimeTypesFrom && !existsSync(join(root, 'conf', 'mime.types'))) {
    copyFileSync(mimeTypesFrom, join(root, 'conf', 'mime.types'));
  }
  if (!existsSync(join(root, 'conf', 'nginx.conf'))) {
    writeFileSync(join(root, 'conf', 'nginx.conf'), MAIN_CONF('sites'));
  }
  return root;
}
