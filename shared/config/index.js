// Configuration loading + validation.
// - Reads from process.env (a `.env` loader can be layered later; Stage 1 keeps
//   it dependency-free and reads the real environment).
// - Non-secret defaults are provided so services can boot in local/test mode.
// - Secrets are validated for PRESENCE only; their values are never logged or
//   echoed. Missing required secrets throw AppError(CONFIG_MISSING).

import { AppError } from '../errors.js';

const DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  MANAGE_API_PORT: '7000',
  ARGUS_PORT: '6040',
  ARGUS_BIND: '127.0.0.1',
  DATA_ROOT: './data',
  CONTENT_ROOT: './content'
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

  return Object.freeze({
    nodeEnv,
    isProd,
    manageApiPort: toPort('MANAGE_API_PORT', get('MANAGE_API_PORT')),
    argusPort: toPort('ARGUS_PORT', get('ARGUS_PORT')),
    argusBind,
    dataRoot: get('DATA_ROOT'),
    contentRoot: get('CONTENT_ROOT'),
    // Presence flags only — values are intentionally NOT surfaced here.
    hasSessionSecret: Boolean(env.MANAGE_SESSION_SECRET),
    hasArgusToken: Boolean(env.ARGUS_INTERNAL_TOKEN)
  });
}

export { REQUIRED_SECRETS };
