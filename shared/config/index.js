// Configuration loading + validation.
// - Reads from process.env (a `.env` loader can be layered later; the loader
//   stays dependency-free and reads the real environment).
// - Non-secret defaults are provided so services can boot in local/test mode.
// - Secrets are validated for PRESENCE only; their values are never logged or
//   echoed. Missing required secrets throw AppError(CONFIG_MISSING).
// - data / content / config-repo / logs are validated as SEPARATE path roots.

import { resolve, isAbsolute } from 'node:path';
import { AppError } from '../errors.js';

const DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  MANAGE_API_PORT: '7000',
  ARGUS_PORT: '6040',
  ARGUS_BIND: '127.0.0.1',
  DATA_ROOT: './data',
  CONTENT_ROOT: './content',
  // Config Repo checkout location — configuration, never a hardcoded absolute
  // path. Defaults to the sibling bmb-infrastructure checkout for local dev.
  CONFIG_REPO_ROOT: '../bmb-infrastructure',
  LOGS_ROOT: './logs',
  // ── Argus execution (Stage 3+4) ──
  // Execution is OFF by default. It may only be enabled in the explicit
  // isolated-test mode with a non-production projects root.
  ARGUS_EXECUTION_ENABLED: 'false',
  ARGUS_MODE: 'local',
  ARGUS_STATE_ROOT: './logs/argus',
  REGISTRY_PATH: './data/registry/applications.json',
  CONFIG_REPO_BRANCH: 'main'
});

// Secrets required only when NOT in local/test mode.
const REQUIRED_SECRETS = Object.freeze([
  'MANAGE_SESSION_SECRET',
  'ARGUS_INTERNAL_TOKEN'
]);

function toPort(name, raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new AppError('CONFIG_INVALID', `Invalid port for ${name}`, { name });
  }
  return n;
}

// The four Git/runtime roots must be distinct locations — data, content, the
// Config Repo checkout, and logs each have a different owner and lifecycle.
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

// Argus execution settings. Fails closed: enabling execution requires the
// explicit isolated-test mode, a non-production environment, and an absolute
// projects root that is NOT the production `/projects`.
function loadArgusSettings(get, env, isProd) {
  const executionEnabled = get('ARGUS_EXECUTION_ENABLED') === 'true';
  const mode = get('ARGUS_MODE');
  const projectsRoot = env.PROJECTS_ROOT && env.PROJECTS_ROOT.trim() !== '' ? env.PROJECTS_ROOT : null;

  if (executionEnabled) {
    if (isProd) {
      throw new AppError('CONFIG_INVALID', 'Argus execution cannot be enabled in production in this stage');
    }
    if (mode !== 'isolated-test') {
      throw new AppError('CONFIG_INVALID', 'Argus execution requires ARGUS_MODE=isolated-test');
    }
    if (!projectsRoot || !isAbsolute(projectsRoot)) {
      throw new AppError('CONFIG_INVALID', 'Argus execution requires an absolute PROJECTS_ROOT');
    }
    const norm = resolve(projectsRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === '/projects' || norm.endsWith(':/projects')) {
      throw new AppError('CONFIG_INVALID', 'PROJECTS_ROOT must not be the production /projects root');
    }
  }

  return Object.freeze({
    executionEnabled,
    mode,
    projectsRoot,
    stateRoot: get('ARGUS_STATE_ROOT'),
    registryPath: get('REGISTRY_PATH'),
    configRepoBranch: get('CONFIG_REPO_BRANCH'),
    nginxBin: env.NGINX_BIN || null,
    nginxPrefix: env.NGINX_PREFIX || null
  });
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] environment source (default process.env)
 * @param {boolean} [opts.requireSecrets] enforce presence of production secrets
 * @returns {Readonly<object>} frozen, non-secret-echoing config
 */
export function loadConfig({ env = process.env, requireSecrets } = {}) {
  const get = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : DEFAULTS[k]);

  const nodeEnv = get('NODE_ENV');
  const isProd = nodeEnv === 'production';
  const enforce = requireSecrets ?? isProd;

  if (enforce) {
    const missing = REQUIRED_SECRETS.filter((k) => !env[k] || env[k].trim() === '');
    if (missing.length > 0) {
      // Names only — never the values.
      throw new AppError('CONFIG_MISSING', 'Required secret(s) are not set', {
        missing
      });
    }
  }

  const argusBind = get('ARGUS_BIND');
  if (argusBind !== '127.0.0.1' && argusBind !== 'localhost') {
    // Argus must never be public. Guard the invariant at config load.
    throw new AppError('CONFIG_INVALID', 'ARGUS_BIND must be localhost', {
      name: 'ARGUS_BIND'
    });
  }

  const pathRoots = Object.freeze({
    data: get('DATA_ROOT'),
    content: get('CONTENT_ROOT'),
    configRepo: get('CONFIG_REPO_ROOT'),
    logs: get('LOGS_ROOT')
  });
  assertDistinctRoots(pathRoots);

  const argus = loadArgusSettings(get, env, isProd);

  return Object.freeze({
    argus,
    nodeEnv,
    isProd,
    manageApiPort: toPort('MANAGE_API_PORT', get('MANAGE_API_PORT')),
    argusPort: toPort('ARGUS_PORT', get('ARGUS_PORT')),
    argusBind,
    // Individual roots (back-compat) + the grouped, validated set.
    dataRoot: pathRoots.data,
    contentRoot: pathRoots.content,
    configRepoRoot: pathRoots.configRepo,
    logsRoot: pathRoots.logs,
    pathRoots,
    // Presence flags only — values are intentionally NOT surfaced here.
    hasSessionSecret: Boolean(env.MANAGE_SESSION_SECRET),
    hasArgusToken: Boolean(env.ARGUS_INTERNAL_TOKEN)
  });
}

export { REQUIRED_SECRETS, DEFAULTS };
