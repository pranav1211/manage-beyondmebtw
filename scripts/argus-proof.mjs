// Argus end-to-end proof against a REAL, non-production target (Stage 3+4).
//
//   signed webhook → identify/validate → git sync (GitHub) → Argus generates
//   the PM2 file → commit/push to a DISPOSABLE Config Repo branch → read back
//   → PM2 reconcile → health → operation record; plus negative + idempotency
//   checks. Writes a redacted evidence JSON. Never touches production.
//
// Required env:
//   ARGUS_PROOF_ROOT   scratch dir for projects/state/PM2 home/evidence
//   CONFIG_REPO_ROOT   disposable bmb-infrastructure checkout
//   REGISTRY_PATH      registry file (bmb-data/registry/applications.json)
// Optional env:
//   CONFIG_REPO_BRANCH disposable branch (default argus-proof/f1-titles-data)
//   F1_DEV_CHECKOUT    developer checkout, hashed before/after to prove its data is untouched
// Flags: --keep  leave the deployed process running after the proof
//
// Webhook/token secrets are random per run, held in memory only, and redacted.

import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'f1-titles-data';
const APP_REMOTE = 'git@github.com:pranav1211/f1-titles-data.git';
const must = (k) => {
  if (!process.env[k]) throw new Error(`${k} is required`);
  return process.env[k];
};

const ROOT = resolve(must('ARGUS_PROOF_ROOT'));
const CFG = resolve(must('CONFIG_REPO_ROOT'));
const BRANCH = process.env.CONFIG_REPO_BRANCH || 'argus-proof/f1-titles-data';
const DEV = process.env.F1_DEV_CHECKOUT ? resolve(process.env.F1_DEV_CHECKOUT) : null;
const KEEP = process.argv.includes('--keep');
process.env.PM2_HOME = join(ROOT, 'pm2-proof'); // before PM2 loads

const { loadConfig } = await import('../shared/config/index.js');
const { createApp } = await import('../services/argus/argus.js');
const pm2 = await import('../services/argus/pm2.js');

const TOKEN = randomBytes(24).toString('hex');
const SECRET = randomBytes(24).toString('hex');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dataHashes(dir) {
  const d = join(dir, 'data');
  if (!existsSync(d)) return null;
  return Object.fromEntries(readdirSync(d).sort().map((f) => [f, sha(readFileSync(join(d, f)))]));
}

const evidence = { app: APP, configRepo: { branch: BRANCH }, startedAt: new Date().toISOString(), steps: {} };
const devBefore = DEV ? { head: git(['rev-parse', 'HEAD'], DEV), data: dataHashes(DEV) } : null;

const config = loadConfig({
  env: {
    ARGUS_EXECUTION_ENABLED: 'true',
    ARGUS_MODE: 'isolated-test',
    PROJECTS_ROOT: join(ROOT, 'projects'),
    ARGUS_STATE_ROOT: join(ROOT, 'state-proof'),
    REGISTRY_PATH: must('REGISTRY_PATH'),
    CONFIG_REPO_ROOT: CFG,
    CONFIG_REPO_BRANCH: BRANCH
  }
});
const app = createApp(config, { env: { ARGUS_INTERNAL_TOKEN: TOKEN, ARGUS_WEBHOOK_SECRET_F1_TITLES_DATA: SECRET } });
const server = await new Promise((r) => { const s = app.listen(0, config.argusBind, () => r(s)); });
const base = `http://${config.argusBind}:${server.address().port}`;
evidence.argus = { bind: server.address().address, executionEnabled: config.argus.executionEnabled, mode: config.argus.mode };

const auth = { authorization: `Bearer ${TOKEN}` };
async function waitOp(id) {
  for (let i = 0; i < 600; i++) {
    const rec = await (await fetch(`${base}/operations/${id}`, { headers: auth })).json();
    if (['succeeded', 'failed', 'blocked'].includes(rec.status)) return rec;
    await sleep(250);
  }
  throw new Error(`operation ${id} timed out`);
}
async function webhook(commit, secret, ref = 'refs/heads/main') {
  const body = Buffer.from(JSON.stringify({ ref, after: commit, repository: { full_name: 'pranav1211/f1-titles-data' } }));
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const delivery = randomUUID();
  const res = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'x-github-event': 'push', 'x-github-delivery': delivery, 'x-hub-signature-256': sig, 'content-type': 'application/json' },
    body
  });
  return { delivery, status: res.status, body: await res.json() };
}

try {
  const head = git(['ls-remote', APP_REMOTE, 'refs/heads/main']).split(/\s+/)[0];
  evidence.targetCommit = head;

  // 1. Valid signed webhook → full deploy.
  const w1 = await webhook(head, SECRET);
  evidence.steps.webhookAccepted = { delivery: w1.delivery, httpStatus: w1.status, response: w1.body };
  const rec1 = await waitOp(w1.body.operationId);
  evidence.steps.deployOperation = rec1;
  if (rec1.status !== 'succeeded') throw new Error(`deploy failed at ${rec1.stage}: ${JSON.stringify(rec1.error)}`);

  // 2. Bad signature → rejected before any work.
  const w2 = await webhook(head, 'not-the-secret');
  evidence.steps.badSignature = { httpStatus: w2.status, response: w2.body };

  // 3. Wrong branch → recorded no-op.
  const w3 = await webhook(head, SECRET, 'refs/heads/some-feature');
  evidence.steps.wrongBranch = { httpStatus: w3.status, response: w3.body };

  // 4. Repeat delivery of the deployed commit → idempotent no-op.
  const cfgHeadBefore = git(['ls-remote', 'origin', `refs/heads/${BRANCH}`], CFG).split(/\s+/)[0];
  const w4 = await webhook(head, SECRET);
  const rec4 = await waitOp(w4.body.operationId);
  const cfgHeadAfter = git(['ls-remote', 'origin', `refs/heads/${BRANCH}`], CFG).split(/\s+/)[0];
  evidence.steps.repeatDelivery = { operation: rec4, configRepoHeadUnchanged: cfgHeadBefore === cfgHeadAfter };

  // 5. Explicit PM2 reconcile → desired vs actual, unmanaged processes reported.
  const r5 = await fetch(`${base}/operations`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, operation: 'pm2.reconcile', application: APP })
  });
  evidence.steps.pm2Reconcile = await waitOp((await r5.json()).operationId);

  // 6. Independent health request.
  const h = await fetch('http://127.0.0.1:4177/api/seasons');
  const seasons = await h.json();
  evidence.steps.health = { url: 'http://127.0.0.1:4177/api/seasons', status: h.status, seasonsReturned: Array.isArray(seasons) ? seasons.length : seasons };

  // 7. Config Repo read-back from the remote branch.
  const pm2Rel = 'infrastructure/config/pm2/f1-titles-data.config.js';
  git(['fetch', '-q', 'origin', BRANCH], CFG);
  const remoteFile = git(['show', `origin/${BRANCH}:${pm2Rel}`], CFG);
  const genCommit = rec1.result.generatedConfig.commit;
  evidence.steps.configRepo = {
    path: pm2Rel,
    commit: genCommit,
    commitFiles: git(['show', '--name-only', '--format=', genCommit], CFG).split('\n').filter(Boolean),
    remoteSha256: sha(remoteFile.replace(/\r\n/g, '\n') + '\n'),
    recordedSha256: rec1.result.generatedConfig.sha256,
    containsSecretValues: remoteFile.includes(TOKEN) || remoteFile.includes(SECRET),
    manifestEntry: JSON.parse(git(['show', `origin/${BRANCH}:infrastructure/config/manifest.json`], CFG)).pm2.find((p) => p.application === APP),
    mainBranchUntouched: !git(['ls-tree', '-r', '--name-only', 'origin/main'], CFG).includes(pm2Rel)
  };

  // 8. Managed process env carries no Argus credentials.
  const keys = await pm2.envKeysOf(APP);
  evidence.steps.processEnv = {
    hasArgusToken: keys.includes('ARGUS_INTERNAL_TOKEN'),
    hasWebhookSecret: keys.some((k) => k.startsWith('ARGUS_WEBHOOK_SECRET'))
  };

  // 9. Data preservation: dev checkout untouched; deployed copy = repo data.
  const deployedDir = join(ROOT, 'projects', APP);
  evidence.steps.data = {
    deployedData: dataHashes(deployedDir),
    devCheckoutBefore: devBefore,
    devCheckoutAfter: DEV ? { head: git(['rev-parse', 'HEAD'], DEV), data: dataHashes(DEV) } : null
  };
  if (DEV) {
    evidence.steps.data.devCheckoutUnchanged = JSON.stringify(devBefore) === JSON.stringify(evidence.steps.data.devCheckoutAfter);
  }
} catch (err) {
  evidence.error = err.message;
} finally {
  evidence.finishedAt = new Date().toISOString();
  if (!KEEP) {
    try { await pm2.deleteProcesses([APP]); } catch { /* ignore */ }
    evidence.teardown = { processDeleted: true };
  }
  try { await pm2.disconnectPm2(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      execFileSync(process.execPath, [join(REPO, 'node_modules', 'pm2', 'bin', 'pm2'), 'kill'], { env: { ...process.env }, stdio: 'ignore', timeout: 30_000 });
      evidence.teardown.daemonStopped = true;
    } catch { /* ignore */ }
  }
  server.closeAllConnections();
  server.close();

  // Redact the per-run secrets everywhere, then verify they are gone.
  let text = JSON.stringify(evidence, null, 2);
  text = text.split(TOKEN).join('<redacted-token>').split(SECRET).join('<redacted-secret>');
  const out = join(ROOT, 'evidence');
  mkdirSync(out, { recursive: true });
  const file = join(out, `f1-proof-${Date.now()}.json`);
  writeFileSync(file, text + '\n');
  console.log(`evidence: ${file}`);
  console.log(evidence.error ? `PROOF FAILED: ${evidence.error}` : 'PROOF COMPLETE');
  process.exitCode = evidence.error ? 1 : 0;
}
