// PM2 reconciliation via the PM2 programmatic API (no shell).
//
// - Desired state = the Argus-generated ecosystem READ BACK from the Config Repo.
// - Actual state = PM2's process list (disposable, observed).
// - Reconciles ONLY the target application's own processes. Every other process
//   is reported as `unmanaged`/`otherManaged` and never touched (never deleted).
// - A process that crashes/restarts right after start is a runtime failure.
//
// PM2 reads PM2_HOME when the library loads, so callers must set PM2_HOME in the
// environment before the first call (isolated runs point it at a scratch dir).

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { Mutex } from './locks.js';
import { tail } from './exec.js';

let pm2lib = null;
const pm2Mutex = new Mutex(); // the pm2 module is a process-wide singleton

async function lib() {
  if (!pm2lib) pm2lib = (await import('pm2')).default;
  return pm2lib;
}

function call(fn) {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

// One persistent client connection (Argus is long-running). PM2 5.x's client
// races when reconnecting immediately after a disconnect, so we connect once,
// serialize all calls on the mutex, and only reset the client after a failure.
let connected = false;
const PM2_CALL_TIMEOUT_MS = 90_000;

// PM2 5.4.3's Client.disconnectRPC races a 200 ms fallback timer against the
// pipe 'close' event and invokes its callback twice on Windows (async's
// "Callback was already called"). Close the two axon sockets directly instead:
// axon's close() marks them closing, so they neither reconnect nor double-call.
function resetClient() {
  if (pm2lib && connected) {
    const c = pm2lib.Client;
    for (const sock of [c && c.client_sock, c && c.sub_sock]) {
      try {
        if (sock && typeof sock.close === 'function') sock.close();
      } catch { /* ignore */ }
    }
    if (c) {
      c.client = null;
      c.sub = null;
    }
  }
  connected = false;
}

async function withPm2(fn) {
  return pm2Mutex.withLock(async () => {
    const pm2 = await lib();
    if (!connected) {
      await call((cb) => pm2.connect(cb));
      connected = true;
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError('PM2_FAILED', 'PM2 call timed out')), PM2_CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([fn(pm2), timeout]);
    } catch (err) {
      if (err instanceof AppError && err.message === 'PM2 call timed out') resetClient();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, 120_000);
}

/** Close the client connection (graceful shutdown / end of tests). */
export async function disconnectPm2() {
  return pm2Mutex.withLock(async () => resetClient());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Inherited env vars that must never reach a managed process.
export const FILTERED_ENV_PREFIXES = Object.freeze([
  'ARGUS_INTERNAL_TOKEN',
  'ARGUS_WEBHOOK_SECRET',
  'WEBHOOK_DEFAULT_SECRET',
  'MANAGE_SESSION_SECRET'
]);

/** Env var NAMES (never values) of a running process — for verification. */
export async function envKeysOf(name) {
  return withPm2(async (pm2) => {
    const list = await call((cb) => pm2.list(cb));
    const proc = list.find((p) => p.name === name);
    return proc ? Object.keys(envOf(proc)) : null;
  });
}

function envOf(proc) {
  const e = proc.pm2_env || {};
  return { ...(e.env || {}), ...e };
}

function summarize(proc) {
  const e = proc.pm2_env || {};
  return {
    name: proc.name,
    status: e.status || 'unknown',
    pid: proc.pid || null,
    restarts: e.restart_time ?? 0,
    unstableRestarts: e.unstable_restarts ?? 0,
    revision: envOf(proc).ARGUS_REVISION || null,
    configHash: envOf(proc).ARGUS_CONFIG_HASH || null
  };
}

function readLogTail(path) {
  try {
    if (path && existsSync(path)) return tail(readFileSync(path, 'utf8'), 800);
  } catch {
    /* ignore */
  }
  return '';
}

function hashApp(app) {
  return createHash('sha256').update(JSON.stringify(app)).digest('hex').slice(0, 16);
}

/**
 * @param {object} p
 * @param {string} p.application owning application
 * @param {{apps:object[]}} p.ecosystem parsed (read-back) ecosystem
 * @param {(serverCwd:string)=>string} p.translateCwd server path -> local path
 * @param {Record<string,string>} [p.secretEnv] resolved secret env (never persisted)
 * @param {string} p.revision deployed revision
 * @param {Set<string>} p.managedNames all Argus-managed process names
 * @param {number} [p.settleMs] wait before verifying the process stayed up
 */
export async function reconcileApp({ application, ecosystem, translateCwd, secretEnv = {}, revision, managedNames, settleMs = 2500 }) {
  for (const a of ecosystem.apps) {
    if (a.name !== application && !a.name.startsWith(`${application}-`)) {
      throw new AppError('FORBIDDEN', 'Ecosystem defines a process this application does not own', { name: a.name });
    }
  }

  return withPm2(async (pm2) => {
    const before = await call((cb) => pm2.list(cb));
    const actions = [];

    for (const app of ecosystem.apps) {
      const cwd = translateCwd(app.cwd);
      if (!isAbsolute(cwd)) throw new AppError('PATH_VIOLATION', 'Translated cwd must be absolute');
      const configHash = hashApp(app);
      const spec = {
        name: app.name,
        script: join(cwd, app.script),
        cwd,
        interpreter: app.interpreter === 'node' ? process.execPath : app.interpreter,
        exec_mode: app.exec_mode,
        instances: app.instances,
        autorestart: app.autorestart,
        max_restarts: app.max_restarts,
        // Never let Argus's own credentials leak into a managed app's env
        // (PM2 otherwise inherits the caller's environment).
        filter_env: FILTERED_ENV_PREFIXES,
        env: { ...app.env, ...secretEnv, ARGUS_CONFIG_HASH: configHash, ARGUS_REVISION: revision }
      };
      const current = before.find((p) => p.name === app.name);
      let action;
      if (!current) {
        await call((cb) => pm2.start(spec, cb));
        action = 'started';
      } else {
        const env = envOf(current);
        if (env.ARGUS_CONFIG_HASH !== configHash || env.ARGUS_REVISION !== revision) {
          await call((cb) => pm2.delete(app.name, cb));
          await call((cb) => pm2.start(spec, cb));
          action = 'recreated';
        } else if (current.pm2_env.status !== 'online') {
          await call((cb) => pm2.restart(app.name, cb));
          action = 'restarted';
        } else {
          action = 'unchanged';
        }
      }
      actions.push({ name: app.name, action, desired: { cwd, script: app.script, port: app.env.PORT, configHash, revision } });
    }

    // Verify the processes stayed up (catch crash-on-start / crash loops):
    // snapshot right after acting, wait, snapshot again. A freshly started
    // process must have 0 restarts; any process must not restart during the
    // settle window.
    const snap0 = await call((cb) => pm2.list(cb));
    if (actions.some((a) => a.action !== 'unchanged')) await sleep(settleMs);
    const after = await call((cb) => pm2.list(cb));
    const actual = [];
    for (const a of actions) {
      const proc = after.find((p) => p.name === a.name);
      if (!proc) throw new AppError('PM2_FAILED', 'Process is not present after reconcile', { name: a.name });
      const s = summarize(proc);
      actual.push(s);
      const p0 = snap0.find((p) => p.name === a.name);
      const baseline = p0 ? summarize(p0).restarts : 0;
      const fresh = a.action === 'started' || a.action === 'recreated';
      const crashed = (fresh && s.restarts > 0) || s.restarts > baseline;
      if (s.status !== 'online' || crashed || s.unstableRestarts > 0) {
        throw new AppError('PM2_FAILED', 'Process did not stay online after start', {
          process: s,
          errLog: readLogTail(proc.pm2_env.pm_err_log_path),
          outLog: readLogTail(proc.pm2_env.pm_out_log_path)
        });
      }
    }

    const owned = new Set(actions.map((a) => a.name));
    const others = after.filter((p) => !owned.has(p.name)).map(summarize);
    return {
      actions,
      actual,
      otherManaged: others.filter((p) => managedNames.has(p.name)).map((p) => p.name),
      unmanaged: others.filter((p) => !managedNames.has(p.name)).map((p) => ({ name: p.name, status: p.status }))
    };
  });
}

/** Typed manual operation on an application's own existing processes. */
export async function controlApp(op, names) {
  const fn = { stop: 'stop', restart: 'restart', reload: 'reload' }[op];
  if (!fn) throw new AppError('UNSUPPORTED_OPERATION', 'Unsupported PM2 operation', { op });
  return withPm2(async (pm2) => {
    const list = await call((cb) => pm2.list(cb));
    const results = [];
    for (const name of names) {
      if (!list.find((p) => p.name === name)) {
        results.push({ name, ok: false, reason: 'not-running' });
        continue;
      }
      await call((cb) => pm2[fn](name, cb));
      results.push({ name, ok: true });
    }
    return results;
  });
}

export async function describe(names) {
  return withPm2(async (pm2) => {
    const list = await call((cb) => pm2.list(cb));
    return list.filter((p) => !names || names.includes(p.name)).map(summarize);
  });
}

/** Test/teardown helper: delete ONLY the named processes. */
export async function deleteProcesses(names) {
  return withPm2(async (pm2) => {
    const list = await call((cb) => pm2.list(cb));
    for (const name of names) {
      if (list.find((p) => p.name === name)) await call((cb) => pm2.delete(name, cb));
    }
  });
}

/** Start an arbitrary process (tests only — simulates an operator-started process). */
export async function startRaw(spec) {
  return withPm2(async (pm2) => call((cb) => pm2.start(spec, cb)));
}

// Note: Argus never kills the PM2 daemon (it only reconciles its own apps).
// Killing the daemon from inside this process leaves the client's pipe sockets
// reconnecting forever; isolated test teardown stops it out-of-process instead.
