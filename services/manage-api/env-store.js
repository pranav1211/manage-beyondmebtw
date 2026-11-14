// Per-application env files: /infrastructure/env/<application>.env.
//
// Apps load their env at start with `node --env-file=<this file>` (path set in
// the Argus-generated PM2 config). Manage writes these files: variables the
// developer adds on the dashboard, and the app's Manage API token. Values are
// WRITE-ONLY through the API — reads return names, never values.
//
// - Atomic: temp file created 0600 in the same dir, fsync, rename.
// - Line-preserving: comments/ordering kept; only touched keys change.
// - Control-plane env files (argus, manage-beyondmebtw) are never editable here.

import { openSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { assertSafeIdentifier } from '../../shared/validation/paths.js';
import { readTextOrNull, fsyncDir } from '../../shared/data/durable.js';

const KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const BARE_RE = /^[A-Za-z0-9_./:@,+=-]*$/;
export const PROTECTED_APPS = Object.freeze(['argus', 'manage-beyondmebtw']);
export const MANAGED_KEYS = Object.freeze(['MANAGE_API_TOKEN', 'MANAGE_API_URL']);

function parseLines(text) {
  return (text || '').split('\n').map((raw) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
    return { raw, key: m ? m[1] : null };
  });
}

/** Serialize a value so Node's --env-file parser reads it back verbatim. */
export function formatValue(value) {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new AppError('VALIDATION_FAILED', 'Env values cannot contain line breaks');
  if (v.length > 8192) throw new AppError('VALIDATION_FAILED', 'Env value too long');
  if (BARE_RE.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\')) return `"${v}"`;
  throw new AppError('VALIDATION_FAILED', 'Env value mixes quote characters; not representable safely');
}

export function createEnvStore({ envRoot }) {
  function fileFor(application) {
    assertSafeIdentifier(application, 'application');
    if (PROTECTED_APPS.includes(application)) {
      throw new AppError('FORBIDDEN', 'Control-plane env files are managed by hand, not through the dashboard', { application });
    }
    return join(envRoot, `${application}.env`);
  }

  function write(file, text) {
    mkdirSync(envRoot, { recursive: true, mode: 0o700 });
    const tmp = join(envRoot, `.${randomBytes(6).toString('hex')}.env.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try { chmodSync(tmp, 0o600); } catch { /* not supported on this platform */ }
    renameSync(tmp, file);
    fsyncDir(envRoot);
  }

  return Object.freeze({
    /** Names only — values never leave the server. */
    list(application) {
      const file = fileFor(application);
      const lines = parseLines(readTextOrNull(file));
      const keys = lines.filter((l) => l.key).map((l) => ({ name: l.key, managedByManage: MANAGED_KEYS.includes(l.key) }));
      return { application, file, exists: existsSync(file), keys };
    },

    /**
     * @param {string} application
     * @param {{set?:Record<string,string>, unset?:string[]}} change
     * @param {{allowManaged?:boolean}} [opts] Manage itself may write MANAGE_* keys
     */
    update(application, { set = {}, unset = [] } = {}, { allowManaged = false } = {}) {
      const file = fileFor(application);
      if (typeof set !== 'object' || Array.isArray(set) || !Array.isArray(unset)) throw new AppError('VALIDATION_FAILED', '{ set: {KEY: value}, unset: [KEY] }');
      const touched = [...Object.keys(set), ...unset];
      if (!touched.length) throw new AppError('VALIDATION_FAILED', 'Nothing to change');
      for (const k of touched) {
        if (!KEY_RE.test(k)) throw new AppError('VALIDATION_FAILED', 'Env names are UPPER_SNAKE_CASE', { name: k });
        if (!allowManaged && MANAGED_KEYS.includes(k)) throw new AppError('FORBIDDEN', `${k} is written by Manage (issue/rotate the API token instead)`, { name: k });
      }
      const formatted = Object.fromEntries(Object.entries(set).map(([k, v]) => [k, formatValue(v)]));
      const lines = parseLines(readTextOrNull(file)).filter((l, i, all) => !(i === all.length - 1 && l.raw === ''));
      const out = [];
      const done = new Set();
      for (const l of lines) {
        if (l.key && unset.includes(l.key)) continue;
        if (l.key && l.key in formatted) {
          if (!done.has(l.key)) out.push(`${l.key}=${formatted[l.key]}`);
          done.add(l.key);
          continue;
        }
        out.push(l.raw);
      }
      for (const [k, v] of Object.entries(formatted)) if (!done.has(k)) out.push(`${k}=${v}`);
      write(file, out.join('\n') + '\n');
      return this.list(application);
    }
  });
}
