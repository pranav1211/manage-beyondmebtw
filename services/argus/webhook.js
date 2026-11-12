// GitHub push webhook handling: strict parsing, target identification,
// per-target HMAC verification, branch rule. Rejections happen BEFORE any
// deployment work. Secret values are never logged or returned.
//
// Secret policy (per-target): a registry entry may name its own secret via
// `webhookSecretRef` (custom secret for important apps); otherwise the default
// secret `WEBHOOK_DEFAULT_SECRET` applies. Values come from the server-private env.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../shared/errors.js';

const DEFAULT_SECRET_REF = 'WEBHOOK_DEFAULT_SECRET';
const SHA_RE = /^[0-9a-f]{40}$/;
const FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function secretRefFor(entry) {
  return entry.webhookSecretRef || DEFAULT_SECRET_REF;
}

export function sign(rawBody, secret) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(sign(rawBody, secret), 'utf8');
  const actual = Buffer.from(header, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * @param {object} req
 * @param {Record<string,string>} req.headers lower-cased header map
 * @param {Buffer} req.rawBody exact bytes GitHub signed
 * @param {object} registry from loadRegistry()
 * @param {Record<string,string|undefined>} env secret source
 * @returns {{kind:'ping'}|{kind:'noop', application:string, reason:string, commit:string}|{kind:'deploy', application:string, commit:string, ref:string}}
 */
export function parseWebhook({ headers, rawBody, registry, env }) {
  const event = headers['x-github-event'];
  if (!event) throw new AppError('VALIDATION_FAILED', 'Missing X-GitHub-Event header');
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Empty payload');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Malformed JSON payload');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION_FAILED', 'Payload must be an object');
  }

  const fullName = payload.repository && payload.repository.full_name;
  if (typeof fullName !== 'string' || !FULL_NAME_RE.test(fullName)) {
    throw new AppError('VALIDATION_FAILED', 'Missing or invalid repository.full_name');
  }

  // Identify the target (needed to know which secret verifies the signature).
  const entry = registry.findByFullName(fullName);
  if (!entry) throw new AppError('UNKNOWN_TARGET', 'Repository is not registered');
  if (entry.enabled !== true) throw new AppError('TARGET_DISABLED', 'Target is disabled', { application: entry.application });

  const secret = env[secretRefFor(entry)];
  if (!verifySignature(rawBody, headers['x-hub-signature-256'], secret)) {
    // Same response whether the secret is unset, the header is missing, or wrong.
    throw new AppError('SIGNATURE_INVALID', 'Webhook signature verification failed');
  }

  if (event === 'ping') return { kind: 'ping', application: entry.application };
  if (event !== 'push') {
    throw new AppError('VALIDATION_FAILED', 'Unsupported event', { event });
  }

  const { ref, after } = payload;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
    throw new AppError('VALIDATION_FAILED', 'Missing or invalid ref');
  }
  if (typeof after !== 'string' || !SHA_RE.test(after)) {
    throw new AppError('VALIDATION_FAILED', 'Missing or invalid commit (after)');
  }

  if (ref !== `refs/heads/${entry.branch}`) {
    return { kind: 'noop', application: entry.application, reason: 'branch-not-tracked', commit: after, ref };
  }
  return { kind: 'deploy', application: entry.application, commit: after, ref };
}
