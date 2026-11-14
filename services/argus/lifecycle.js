// Argus operation lifecycle.
//
//   receive → authenticate → identify → validate → acquire lock → sync →
//   (node: generate PM2 → Config Repo persist → read back → reconcile) →
//   health check → record
//
// Fail-fast: the first failing stage stops the operation and is recorded with
// sanitized diagnostics. There is NO automatic rollback.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../shared/errors.js';
import { validateArgusDeploy, compareDeclaration } from '../../shared/schemas/index.js';
import { resolveWithinRoot } from '../../shared/validation/paths.js';
import {
  loadManifest,
  resolvePm2File,
  persistOwnedFiles,
  upsertPm2Entry,
  renderManifest,
  _internal as configRepoInternal
} from '../../shared/config-repo/index.js';
import { entryHash } from './registry.js';
import { syncRepository } from './git-sync.js';
import { buildPm2Metadata, renderEcosystem, parseEcosystem, sha256 } from './pm2-gen.js';
import { reconcileApp, controlApp, describe } from './pm2.js';
import { assertHealthy, nodeHealthUrl } from './health.js';
import { validateCandidate, applyCandidate } from './nginx.js';

// Ports already used by production/legacy services (and Argus itself).
// A managed app may not declare one of these.
export const RESERVED_PORTS = Object.freeze([6009, 6011, 6021, 6030, 6040, 7000, 7004, 7005, 7014, 7020]);

const PROJECTS_PREFIX = '/projects/';

/**
 * Can Argus execute against this registry entry in the current mode?
 * production: developer-declared allowlist only, never test entries, enabled only.
 * isolated-test: enabled entries (isolated roots are enforced by config).
 * @returns {{ok:boolean, code?:string, reason?:string}}
 */
export function executability(entry, { mode, allowlist = [] }) {
  if (!entry) return { ok: false, code: 'UNKNOWN_TARGET', reason: 'Application is not registered' };
  if (entry.enabled !== true) return { ok: false, code: 'TARGET_DISABLED', reason: 'Target is disabled' };
  if (mode === 'production') {
    if (entry.environment === 'test') return { ok: false, code: 'TARGET_NOT_ALLOWED', reason: 'Test entries are never executed in production mode' };
    if (!allowlist.includes(entry.application)) {
      return { ok: false, code: 'TARGET_NOT_ALLOWED', reason: 'Application is not on the production execution allowlist' };
    }
  }
  return { ok: true };
}

export function createLifecycle(ctx) {
  const { store } = ctx;
  // Argus owns its (isolated) projects root; establish it on first use so a
  // first-ever Build on a fresh root works.
  if (ctx.projectsRoot) mkdirSync(ctx.projectsRoot, { recursive: true });

  // Server-form `/projects/<app>` -> isolated local path under projectsRoot.
  function translateCwd(serverPath) {
    if (typeof serverPath !== 'string' || !serverPath.startsWith(PROJECTS_PREFIX)) {
      throw new AppError('PATH_VIOLATION', 'Deployment paths must live under /projects/');
    }
    return resolveWithinRoot(ctx.projectsRoot, serverPath.slice(PROJECTS_PREFIX.length));
  }

  function deploymentDir(entry) {
    if (entry.deploymentPath !== `${PROJECTS_PREFIX}${entry.application}`) {
      throw new AppError('PATH_VIOLATION', 'deploymentPath must be /projects/<application>', {
        deploymentPath: entry.deploymentPath
      });
    }
    return translateCwd(entry.deploymentPath);
  }

  function assertExecutable(entry) {
    const r = executability(entry, { mode: ctx.mode, allowlist: ctx.allowlist });
    if (!r.ok) throw new AppError(r.code, r.reason);
    return entry;
  }

  const bootstrapNames = ctx.bootstrapNames || new Set(['argus']);
  // Secrets: apps with an env file load their own; only isolated tests inject.
  const secretEnvFor = (proc) => (proc.envFile ? {} : ctx.secretEnv(proc.envRefs || []));

  function managedNames(registry) {
    return new Set(registry.nodeApplications().map((e) => e.application));
  }

  function readDeclaration(dir) {
    const p = join(dir, 'argus.deploy.json');
    if (!existsSync(p)) throw new AppError('VALIDATION_FAILED', 'Repository has no argus.deploy.json');
    let decl;
    try {
      decl = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      throw new AppError('VALIDATION_FAILED', 'argus.deploy.json is not valid JSON');
    }
    const { valid, errors } = validateArgusDeploy(decl);
    if (!valid) throw new AppError('VALIDATION_FAILED', 'argus.deploy.json failed validation', { errors });
    return decl;
  }

  function checkRuntime(entry, decl, dir) {
    if (entry.type !== 'node') return;
    if (!decl.runtime) throw new AppError('VALIDATION_FAILED', 'Node app declaration is missing a runtime block');
    resolveWithinRoot(dir, decl.runtime.script, { allowedExtensions: ['.js', '.cjs', '.mjs'] });
    if (RESERVED_PORTS.includes(decl.runtime.port)) {
      throw new AppError('VALIDATION_FAILED', 'Declared port is reserved by another service', { port: decl.runtime.port });
    }
  }

  function readGeneratedEcosystem(entry) {
    const { manifest } = loadManifest(ctx.configRepo.root);
    const abs = resolvePm2File(ctx.configRepo.root, manifest, entry.pm2Config);
    if (!existsSync(abs)) throw new AppError('CONFIG_MISSING', 'No generated PM2 config for this application yet');
    return parseEcosystem(readFileSync(abs, 'utf8'));
  }

  // ── Deploy / Build ────────────────────────────────────────────────────────
  async function deploy(job) {
    const id = job.operationId;
    let stage = 'identify';
    const result = {};
    try {
      store.stage(id, stage);
      const registry = ctx.loadRegistry();
      const entry = registry.get(job.application);
      assertExecutable(entry);

      stage = 'load-config';
      store.stage(id, stage);
      const dir = deploymentDir(entry);
      const registryHash = entryHash(entry);

      // Idempotency: same commit + unchanged desired state + healthy runtime = no side effect.
      const deployed = store.getDeployed(entry.application);
      if (job.commit && deployed && deployed.commit === job.commit && deployed.registryHash === registryHash && deployed.healthy) {
        let runtimeOk = true;
        if (entry.type === 'node') {
          const procs = await describe([entry.application]);
          runtimeOk = procs.length > 0 && procs.every((p) => p.status === 'online');
        }
        if (runtimeOk) {
          return store.succeed(id, { noop: true, reason: 'already-deployed', revision: job.commit });
        }
      }

      stage = 'sync';
      store.stage(id, stage);
      const { revision, cloned } = await syncRepository({
        remoteUrl: ctx.resolveRemote(entry),
        branch: entry.branch,
        dir,
        commit: job.commit
      });
      Object.assign(result, { revision, cloned });

      stage = 'validate-declaration';
      store.stage(id, stage);
      const decl = readDeclaration(dir);
      result.declaration = compareDeclaration(entry, decl); // mismatch surfaced, registry stays authoritative
      checkRuntime(entry, decl, dir);

      let healthUrl;
      if (entry.type === 'node') {
        stage = 'deploy';
        store.stage(id, stage);
        const meta = buildPm2Metadata(entry, decl);
        const text = renderEcosystem(meta);
        const { manifest } = loadManifest(ctx.configRepo.root);
        const relPath = `${manifest.configRoots.pm2}/${entry.pm2Config}`;
        const nextManifest = upsertPm2Entry(manifest, entry.application, entry.pm2Config);
        const persisted = await persistOwnedFiles({
          root: ctx.configRepo.root,
          branch: ctx.configRepo.branch,
          expectedRemote: ctx.configRepo.expectedRemote,
          lock: ctx.infraLock,
          message: `argus: generate PM2 config for ${entry.application} @ ${revision.slice(0, 12)}`,
          files: [
            { relPath, content: text },
            { relPath: configRepoInternal.MANIFEST_REL, content: renderManifest(nextManifest) }
          ]
        });
        // Reconcile from the READ-BACK file, re-validated — not from memory.
        const parsed = parseEcosystem(persisted.readBack[0].content);
        result.generatedConfig = {
          path: relPath,
          commit: persisted.commit,
          changed: persisted.changed,
          pushed: persisted.pushed,
          sha256: sha256(persisted.readBack[0].content),
          readBackVerified: true
        };

        stage = 'pm2-reconcile';
        store.stage(id, stage);
        const proc = parsed.meta.processes[0];
        result.pm2 = await reconcileApp({
          application: entry.application,
          ecosystem: parsed.ecosystem,
          translateCwd,
          secretEnv: secretEnvFor(proc),
          revision,
          managedNames: managedNames(registry),
          bootstrapNames,
          settleMs: ctx.pm2SettleMs
        });
        healthUrl = nodeHealthUrl(proc.port, decl.runtime.healthPath);
      } else {
        healthUrl = ctx.staticHealthUrl(entry);
      }

      stage = 'health-check';
      store.stage(id, stage);
      result.health = await assertHealthy(healthUrl, ctx.healthOpts);

      store.setDeployed(entry.application, { commit: revision, registryHash, healthy: true, healthUrl });
      return store.succeed(id, result);
    } catch (err) {
      // Stop, record, report. No rollback.
      return store.fail(id, stage, err, result);
    }
  }

  // ── Other typed operations ────────────────────────────────────────────────
  async function simple(job, stage, fn) {
    const id = job.operationId;
    try {
      store.stage(id, stage);
      return store.succeed(id, await fn());
    } catch (err) {
      return store.fail(id, stage, err);
    }
  }

  function requireEntry(application) {
    return assertExecutable(ctx.loadRegistry().get(application));
  }

  async function runOperation(job) {
    switch (job.operation) {
      case 'deploy':
      case 'build':
        return deploy(job);
      case 'sync':
        return simple(job, 'sync', async () => {
          const entry = requireEntry(job.application);
          return syncRepository({ remoteUrl: ctx.resolveRemote(entry), branch: entry.branch, dir: deploymentDir(entry) });
        });
      case 'pm2.reconcile':
      case 'pm2.start':
        return simple(job, 'pm2-reconcile', async () => {
          const registry = ctx.loadRegistry();
          const entry = requireEntry(job.application);
          const parsed = readGeneratedEcosystem(entry);
          const deployed = store.getDeployed(entry.application) || {};
          return reconcileApp({
            application: entry.application,
            ecosystem: parsed.ecosystem,
            translateCwd,
            secretEnv: secretEnvFor(parsed.meta.processes[0]),
            revision: deployed.commit || 'unknown',
            managedNames: managedNames(registry),
            bootstrapNames,
            settleMs: ctx.pm2SettleMs
          });
        });
      case 'pm2.stop':
      case 'pm2.restart':
      case 'pm2.reload':
        return simple(job, 'pm2-reconcile', async () => {
          const entry = requireEntry(job.application);
          const parsed = readGeneratedEcosystem(entry);
          return { results: await controlApp(job.operation.slice(4), parsed.ecosystem.apps.map((a) => a.name)) };
        });
      case 'nginx.validate':
      case 'nginx.apply':
        return simple(job, 'deploy', async () => {
          if (ctx.mode === 'production') {
            throw new AppError('TARGET_NOT_ALLOWED', 'Nginx operations are not enabled in production mode yet (ingress cutover stage)');
          }
          if (!ctx.nginxRunner) throw new AppError('CONFIG_MISSING', 'No isolated Nginx environment configured');
          const file = job.params && job.params.file;
          const { manifest } = loadManifest(ctx.configRepo.root);
          const abs = resolveWithinRoot(join(ctx.configRepo.root, manifest.configRoots.nginx), String(file), {
            allowedExtensions: ['.conf']
          });
          if (!existsSync(abs)) throw new AppError('RESOURCE_NOT_FOUND', 'Candidate Nginx config not found in the Config Repo');
          const content = readFileSync(abs, 'utf8');
          const fn = job.operation === 'nginx.apply' ? applyCandidate : validateCandidate;
          return ctx.infraLock.withLock(() => fn({ runner: ctx.nginxRunner, manifest, file, content }));
        });
      case 'health':
        return simple(job, 'health-check', async () => {
          const deployed = store.getDeployed(job.application);
          if (!deployed || !deployed.healthUrl) throw new AppError('RESOURCE_NOT_FOUND', 'Application has not been deployed');
          return assertHealthy(deployed.healthUrl, ctx.healthOpts);
        });
      default:
        throw new AppError('UNSUPPORTED_OPERATION', 'Unsupported operation');
    }
  }

  /** Read-only application status for Manage (no side effects). */
  async function appStatus(application) {
    const entry = ctx.loadRegistry().get(application);
    if (!entry) throw new AppError('UNKNOWN_TARGET', 'Application is not registered');
    const exec = executability(entry, { mode: ctx.mode, allowlist: ctx.allowlist });
    let declaration = null;
    try {
      const dir = deploymentDir(entry);
      if (existsSync(join(dir, 'argus.deploy.json'))) declaration = compareDeclaration(entry, readDeclaration(dir));
    } catch (err) {
      declaration = { error: err.code || 'INTERNAL' };
    }
    let processes = null;
    if (entry.type === 'node') {
      try {
        processes = await describe([entry.application]);
      } catch {
        processes = null; // unknown — never guessed
      }
    }
    return {
      application,
      executable: exec,
      declaration, // null = not deployed / not checked
      processes, // null = unknown
      deployed: store.getDeployed(application)
    };
  }

  return { runOperation, deploy, translateCwd, appStatus };
}
