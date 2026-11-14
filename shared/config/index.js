// Configuration loading + validation.
// - Reads from process.env. Production services start with
//   `node --env-file=/infrastructure/env/<service>.env`, so secrets arrive as
//   real environment variables and never pass through PM2 or Git.
// - Non-secret defaults are provided so services can boot in local/test mode.
// - Secrets are validated for PRESENCE only; their values are never logged or
//   echoed. Missing required secrets throw AppError(CONFIG_MISSING).
// - data / content / config-repo / data-repo / logs are SEPARATE path roots.

import { resolve, isAbsolute, join } from 'node:path';
import { AppError } from '../errors.js';

const DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  MANAGE_API_PORT: '7100',
  ARGUS_PORT: '6040',
  ARGUS_BIND: '127.0.0.1',
  DATA_ROOT: './data',
  CONTENT_ROOT: './content',
  // Config Repo / data repo checkout locations — configuration, never a
  // hardcoded absolute path. Default to sibling checkouts for local dev.
  CONFIG_REPO_ROOT: '../bmb-infrastructure',
  DATA_REPO_ROOT: '../bmb-data',
  DATA_REPO_BRANCH: 'main',
  DATA_REPO_REMOTE: 'git@github.com:pranav1211/bmb-data.git',
  LOGS_ROOT: './logs',
  // ── Argus execution ──
  // OFF by default. Enabled only in an explicit mode:
  //   isolated-test — non-production projects root (Stage 3+4 proofs/tests)
  //   production    — developer-declared, restricted to ARGUS_EXECUTION_ALLOWLIST
  ARGUS_EXECUTION_ENABLED: 'false',
  ARGUS_MODE: 'local',
  ARGUS_STATE_ROOT: './logs/argus',
  CONFIG_REPO_BRANCH: 'main'
});

const MODES = Object.freeze(['local', 'isolated-test', 'production']);

// Secrets each service needs outside local/test mode. Names only.
const SERVICE_SECRETS = Object.freeze({
  argus: ['ARGUS_INTERNAL_TOKEN'],
  manage: ['MANAGE_SESSION_SECRET', 'ARGUS_INTERNAL_TOKEN', 'MANAGE_ADMIN_PASSWORD_HASH'],
  // Unspecified service (shared tooling/tests): the common pair.
  default: ['MANAGE_SESSION_SECRET', 'ARGUS_INTERNAL_TOKEN']
});
const REQUIRED_SECRETS = SERVICE_SECRETS.default;

function toPort(name, raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new AppError('CONFIG_INVALID', `Invalid port for ${name}`, { name });
  }
  return n;
}

// Git/runtime roots must be distinct locations — each has a different owner
// and lifecycle.
function assertDistinctRoots(roots) {
  const seen = new Map();
  for (const [name, value] of Object.entries(roots)) {
    const key = resolve(value);
    if (seen.has(key)) {
      throw new AppError('CONFIG_INVALID', 'Path roots must be distinct', {
        roots: [seen.get(key), name]
      });
    }
    seen.set(key, name);
  }
}

function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Argus execution settings. Fails closed.
function loadArgusSettings(get, env, isProd, dataRepoRoot) {
  const executionEnabled = get('ARGUS_EXECUTION_ENABLED') === 'true';
  const mode = get('ARGUS_MODE');
  if (!MODES.includes(mode)) {
    throw new AppError('CONFIG_INVALID', 'ARGUS_MODE must be local, isolated-test or production', { name: 'ARGUS_MODE' });
  }
  const projectsRoot = env.PROJECTS_ROOT && env.PROJECTS_ROOT.trim() !== '' ? env.PROJECTS_ROOT : null;
  const executionAllowlist = parseAllowlist(env.ARGUS_EXECUTION_ALLOWLIST);

  if (executionEnabled) {
    if (mode === 'local') {
      throw new AppError('CONFIG_INVALID', 'Argus execution requires ARGUS_MODE=isolated-test or production');
    }
    if (!projectsRoot || !isAbsolute(projectsRoot)) {
      throw new AppError('CONFIG_INVALID', 'Argus execution requires an absolute PROJECTS_ROOT');
    }
    if (mode === 'isolated-test') {
      if (isProd) {
        throw new AppError('CONFIG_INVALID', 'isolated-test mode cannot run with NODE_ENV=production');
      }
      const norm = resolve(projectsRoot).replace(/\\/g, '/').replace(/\/+$/, '');
      if (norm === '/projects' || norm.endsWith(':/projects')) {
        throw new AppError('CONFIG_INVALID', 'isolated-test PROJECTS_ROOT must not be the production /projects root');
      }
    }
    if (mode === 'production' && executionAllowlist.length === 0) {
      // Production execution is developer-declared, app by app.
      throw new AppError('CONFIG_INVALID', 'production mode requires ARGUS_EXECUTION_ALLOWLIST', { name: 'ARGUS_EXECUTION_ALLOWLIST' });
    }
  }

  return Object.freeze({
    executionEnabled,
    mode,
    executionAllowlist: Object.freeze(executionAllowlist),
    projectsRoot,
    stateRoot: get('ARGUS_STATE_ROOT'),
    registryPath: env.REGISTRY_PATH || join(dataRepoRoot, 'registry', 'applications.json'),
    configRepoBranch: get('CONFIG_REPO_BRANCH'),
    nginxBin: env.NGINX_BIN || null,
    nginxPrefix: env.NGINX_PREFIX || null
  });
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] environment source (default process.env)
 * @param {boolean} [opts.requireSecrets] enforce presence of production secrets
 * @param {'argus'|'manage'} [opts.service] which service's secrets to require
 * @returns {Readonly<object>} frozen, non-secret-echoing config
 */
export function loadConfig({ env = process.env, requireSecrets, service } = {}) {
  const get = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : DEFAULTS[k]);

  const nodeEnv = get('NODE_ENV');
  const isProd = nodeEnv === 'production';
  const enforce = requireSecrets ?? isProd;

  if (enforce) {
    const required = SERVICE_SECRETS[service] || SERVICE_SECRETS.default;
    const missing = required.filter((k) => !env[k] || env[k].trim() === '');
    if (missing.length > 0) {
      // Names only — never the values.
      throw new AppError('CONFIG_MISSING', 'Required secret(s) are not set', { missing });
    }
  }

  const argusBind = get('ARGUS_BIND');
  if (argusBind !== '127.0.0.1' && argusBind !== 'localhost') {
    // Argus must never be public. Guard the invariant at config load.
    throw new AppError('CONFIG_INVALID', 'ARGUS_BIND must be localhost', { name: 'ARGUS_BIND' });
  }

  const pathRoots = Object.freeze({
    data: get('DATA_ROOT'),
    content: get('CONTENT_ROOT'),
    configRepo: get('CONFIG_REPO_ROOT'),
    dataRepo: get('DATA_REPO_ROOT'),
    logs: get('LOGS_ROOT')
  });
  assertDistinctRoots(pathRoots);

  const argus = loadArgusSettings(get, env, isProd, pathRoots.dataRepo);
  const argusPort = toPort('ARGUS_PORT', get('ARGUS_PORT'));

  return Object.freeze({
    argus,
    manage: Object.freeze({
      // Manage reaches Argus over loopback only.
      argusUrl: `http://127.0.0.1:${argusPort}`,
      dataRepoRoot: pathRoots.dataRepo,
      dataRepoBranch: get('DATA_REPO_BRANCH'),
      dataRepoRemote: get('DATA_REPO_REMOTE'),
      registryPath: argus.registryPath,
      secureCookies: isProd
    }),
    nodeEnv,
    isProd,
    manageApiPort: toPort('MANAGE_API_PORT', get('MANAGE_API_PORT')),
    argusPort,
    argusBind,
    // Individual roots (back-compat) + the grouped, validated set.
    dataRoot: pathRoots.data,
    contentRoot: pathRoots.content,
    configRepoRoot: pathRoots.configRepo,
    dataRepoRoot: pathRoots.dataRepo,
    logsRoot: pathRoots.logs,
    pathRoots,
    // Presence flags only — values are intentionally NOT surfaced here.
    hasSessionSecret: Boolean(env.MANAGE_SESSION_SECRET),
    hasArgusToken: Boolean(env.ARGUS_INTERNAL_TOKEN),
    hasAdminPasswordHash: Boolean(env.MANAGE_ADMIN_PASSWORD_HASH)
  });
}

export { REQUIRED_SECRETS, SERVICE_SECRETS, DEFAULTS, MODES };
