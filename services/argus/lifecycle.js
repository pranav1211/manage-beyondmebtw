// Argus operation lifecycle.
//
//   receive → authenticate → identify → validate → acquire lock → sync →
//   (node: generate PM2 → Config Repo persist → read back → reconcile) →
//   health check → record
//
// Fail-fast: the first failing stage stops the operation and is recorded with
// sanitized diagnostics. There is NO automatic rollback.

import { readFileSync, existsSync } from 'node:fs';
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

export function createLifecycle(ctx) {
  const { store } = ctx;

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
      if (!entry) throw new AppError('UNKNOWN_TARGET', 'Application is not registered');
      if (entry.enabled !== true) throw new AppError('TARGET_DISABLED', 'Target is disabled');

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
          secretEnv: ctx.secretEnv(proc.envRefs || []),
          revision,
          managedNames: managedNames(registry),
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
    const entry = ctx.loadRegistry().get(application);
    if (!entry) throw new AppError('UNKNOWN_TARGET', 'Application is not registered');
    return entry;
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
            secretEnv: ctx.secretEnv(parsed.meta.processes[0].envRefs || []),
            revision: deployed.commit || 'unknown',
            managedNames: managedNames(registry),
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

  return { runOperation, deploy, translateCwd };
}
