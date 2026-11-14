// bmb-data GitHub webhook -> fast-forward Manage's bmb-data checkout.
//
// bmb-data has no deploy path: a push there (e.g. a developer edit on GitHub,
// or Manage's own push echoing back) only brings the checkout up to the remote,
// under the same Git lock as every data/registry write. Fast-forward only; a
// diverged or dirty checkout is reported as blocked, never reset.
// Signature: HMAC SHA-256 over the raw body, constant-time compare, secret
// BMB_DATA_WEBHOOK_SECRET if set, else the default WEBHOOK_DEFAULT_SECRET.

import { AppError, sanitizeError } from '../../shared/errors.js';
import { verifySignature } from '../argus/webhook.js';

const SHA_RE = /^[0-9a-f]{40}$/;

/** owner/repo from a GitHub remote URL (ssh or https). */
export function fullNameOf(remote) {
  const m = String(remote).match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/**
 * @param {object} p
 * @param {object} p.dataRepo
 * @param {string} p.expectedFullName e.g. 'pranav1211/bmb-data'
 * @param {string} p.branch
 * @param {Record<string,string|undefined>} p.env secret source
 * @param {(ev:object)=>void} [p.onSynced] called after a successful sync (cache reloads)
 */
export function createDataWebhookHandler({ dataRepo, expectedFullName, branch, env, onSynced = () => {} }) {
  return async (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    try {
      const event = headers['x-github-event'];
      if (!event) throw new AppError('VALIDATION_FAILED', 'Missing X-GitHub-Event header');
      const raw = req.body;
      if (!Buffer.isBuffer(raw) || raw.length === 0) throw new AppError('VALIDATION_FAILED', 'Empty payload');
      const secret = env.BMB_DATA_WEBHOOK_SECRET || env.WEBHOOK_DEFAULT_SECRET;
      if (!verifySignature(raw, headers['x-hub-signature-256'], secret)) {
        throw new AppError('SIGNATURE_INVALID', 'Webhook signature verification failed');
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError('VALIDATION_FAILED', 'Malformed JSON payload');
      }
      const fullName = payload && payload.repository && payload.repository.full_name;
      if (fullName !== expectedFullName) throw new AppError('UNKNOWN_TARGET', 'Repository is not the data repository');
      if (event === 'ping') return res.status(200).json({ message: 'pong', repository: fullName });
      if (event !== 'push') throw new AppError('VALIDATION_FAILED', 'Unsupported event', { event });
      if (payload.ref !== `refs/heads/${branch}`) return res.status(200).json({ status: 'noop', reason: 'branch-not-tracked' });
      const after = typeof payload.after === 'string' && SHA_RE.test(payload.after) ? payload.after : null;
      const op = await dataRepo.syncFromRemote({ after, delivery: headers['x-github-delivery'] || null });
      if (op.status === 'succeeded') onSynced(op);
      const code = op.status === 'blocked' ? 409 : op.status === 'failed' ? 500 : 200;
      return res.status(code).json({ operationId: op.operationId, status: op.status, result: op.result, ...(op.lastError ? { error: op.lastError } : {}) });
    } catch (err) {
      const code = err.code === 'SIGNATURE_INVALID' ? 401 : err.code === 'UNKNOWN_TARGET' ? 404 : err instanceof AppError ? 400 : 500;
      return res.status(code).json(sanitizeError(err));
    }
  };
}
