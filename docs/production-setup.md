# Production setup — Manage + Argus (Stage 5)

How the new control plane is established on the VM. **No secret values appear
here**: env files hold them and live only in `/infrastructure/env/` (restored
separately; private recovery copies are developer-held).

## Layout on the VM

| Path | What | Owner |
|---|---|---|
| `/infrastructure/argus` | Argus **bootstrap checkout** of `manage-beyondmebtw` (Decision 9) | `pvr` |
| `/projects/manage-beyondmebtw` | Manage **deployment** checkout (Argus Build/Deploy) | `pvr` |
| `/infrastructure/bmb-infrastructure` | Config Repo checkout (PM2 + Nginx desired config) | `pvr` |
| `/infrastructure/bmb-data` | Data repo checkout (registry; canonical data from Stage 6) | `pvr` |
| `/infrastructure/env/` | `argus.env`, `manage-beyondmebtw.env` — `chmod 600`, dir `700` | `pvr` |
| `/infrastructure/logs/` | Argus operation records + audit (not Git) | `pvr` |

Argus runs separately from Manage, so a Manage redeploy never touches the
running Argus, and Manage can deploy itself through Argus.

## Ports (loopback only)

- Argus: `127.0.0.1:6040` — never proxied publicly.
- Manage: `127.0.0.1:7100` — published only via `manage.conf` (nginx).

## `/infrastructure/env/argus.env`

```ini
NODE_ENV=production
ARGUS_PORT=6040
ARGUS_BIND=127.0.0.1
ARGUS_EXECUTION_ENABLED=true
ARGUS_MODE=production
# Developer-declared: the ONLY apps Argus may execute against.
ARGUS_EXECUTION_ALLOWLIST=manage-beyondmebtw
PROJECTS_ROOT=/projects
ARGUS_STATE_ROOT=/infrastructure/logs/argus
LOGS_ROOT=/infrastructure/logs
CONFIG_REPO_ROOT=/infrastructure/bmb-infrastructure
CONFIG_REPO_BRANCH=main
DATA_REPO_ROOT=/infrastructure/bmb-data
# Secret (generate: openssl rand -hex 32). Same value in manage-beyondmebtw.env.
ARGUS_INTERNAL_TOKEN=<secret>
```

## `/infrastructure/env/manage-beyondmebtw.env`

The filename is fixed: the Argus-generated PM2 config starts Manage with
`node --env-file=/infrastructure/env/<application>.env`.

```ini
NODE_ENV=production
MANAGE_API_PORT=7100
ARGUS_PORT=6040
DATA_REPO_ROOT=/infrastructure/bmb-data
DATA_REPO_BRANCH=main
CONFIG_REPO_ROOT=/infrastructure/bmb-infrastructure
LOGS_ROOT=/infrastructure/logs
# Secrets
MANAGE_SESSION_SECRET=<secret>            # openssl rand -hex 32
ARGUS_INTERNAL_TOKEN=<same as argus.env>
MANAGE_ADMIN_PASSWORD_HASH='<scrypt hash>' # node scripts/hash-password.mjs — keep the single quotes ($ in hash)
```

## Steps

1. (root) `mkdir -p /infrastructure/env /infrastructure/logs && chown -R pvr:pvr /infrastructure && chmod 700 /infrastructure/env && chown pvr:pvr /projects`
2. Clone `bmb-infrastructure`, `bmb-data`, and `manage-beyondmebtw` (→ `/infrastructure/argus`); `npm ci --omit=dev` in `/infrastructure/argus`.
3. Create both env files (`chmod 600`).
4. (root) Install `projects-guard.conf` + `legacy-manage.conf`; `nginx -t`; reload.
5. `pm2 start /infrastructure/bmb-infrastructure/infrastructure/config/pm2/argus.config.js` (bootstrap exception).
6. Ask Argus: `sync manage-beyondmebtw` → `npm ci --omit=dev` in `/projects/manage-beyondmebtw` → `build manage-beyondmebtw` (Argus generates + commits `manage-beyondmebtw.config.js`, reads it back, starts PM2, health-checks).
7. Verify via SSH tunnel: `ssh -L 7100:127.0.0.1:7100 beyondmebtw` → `http://localhost:7100`.
8. `pm2 save` (after comparing the process list).
9. (root) Install `manage.conf` for `manage.beyondmebtw.com`; `nginx -t`; reload.

## Webhooks (live)

| Repo | URL | Handler |
|---|---|---|
| `manage-beyondmebtw` (and later each code app) | `https://manage.beyondmebtw.com/webhooks/argus` | nginx exact `POST` location → Argus `127.0.0.1:6040/webhook` (HMAC-verified, deploys) |
| `bmb-data` | `https://manage.beyondmebtw.com/api/v1/webhooks/bmb-data` | Manage: HMAC-verified fast-forward of `/infrastructure/bmb-data` under the data Git lock; never deploys anything |

Secret: `WEBHOOK_DEFAULT_SECRET` in **both** `argus.env` and
`manage-beyondmebtw.env` (per-app overrides: registry `webhookSecretRef`;
bmb-data override: `BMB_DATA_WEBHOOK_SECRET`). A push to `manage-beyondmebtw`
`main` deploys production Manage.

## Canonical data (bmb-data)

- Catalog: `bmb-data/catalog/catalog.json` + `catalog/schemas/*.schema.json`
  (developer-authored, changed by commits to bmb-data; the webhook syncs them).
  Resources live under `data/` or `content/`; `registry/` is separate.
- Manage is the only application writer. Every write (registry or data) is a
  journaled operation under one Git lock: validate → atomic replace → exact-path
  commit → push (never forced) → remote read-back. State, journal and history:
  `$LOGS_ROOT/manage` (= `/infrastructure/logs/manage`; override `MANAGE_STATE_ROOT`).
- Interrupted operations are recovered at Manage start-up, before it serves.
- A failed push = `pending-push` (HTTP 202, not "saved"); retry from the Data
  page or `POST /api/v1/data/operations/:id/retry`. Divergence = `blocked`; fix
  by hand (never reset/force automatically).
## Applications: data access and env (dashboard → Applications → <app>)

- **Env:** every app's env lives in `/infrastructure/env/<application>.env`
  (0600). The app loads it at start (`node --env-file`, set in its
  Argus-generated PM2 config when `argus.deploy.json` has `runtime.envFile: true`).
  The dashboard adds/changes/removes variables (values are write-only) and can
  ask Argus to restart the app. `argus.env` and `manage-beyondmebtw.env` are
  control-plane files and are only edited by hand.
- **Manage API token:** "Issue token" creates a per-app token scoped to
  resource keys or families (`f1.season.*`, read and/or write) and Manage writes
  `MANAGE_API_TOKEN` + `MANAGE_API_URL` (`http://127.0.0.1:7100/api/v1`) into
  that app's env file. Only the token's SHA-256 is kept
  (`bmb-data/registry/api-clients.json`). Rotating replaces it; revoking removes
  it from the env file.
- **Using it from an app:** `Authorization: Bearer $MANAGE_API_TOKEN` on
  `GET|PUT|DELETE $MANAGE_API_URL/data/resources/<key>` (and `/items/<id>`).
  Send `ifRevision` (from the last read) on writes; a 409 means someone else
  changed it. 200 = saved and on GitHub; 202 = committed, push pending.
- **Collections:** a catalog entry with `collection.idPattern` and `{id}` in its
  path is a family of documents (`f1.season.<year>` → `data/f1ta/<year>.json`);
  apps create members with `PUT` and remove them with `DELETE`.
- Public resources stay readable without a token (CORS for `*.beyondmebtw.com`).

## Operational notes (learned establishing Stage 5 live)

- **Entry points:** PM2 runs `services/argus/main.js` and
  `services/manage-api/main.js`. Never point PM2 at `argus.js` / `index.js`:
  they are libraries and do not start a server (under PM2 fork mode
  `process.argv[1]` is PM2's container, so "is main module" checks never fire).
- **Argus starts apps with an empty inherited env** (`filter_env: ['']` + a fixed
  system allowlist). Do not change this: Argus itself runs under PM2, and any
  inherited `pm_*`/`name` keys make PM2 treat a new app as Argus's own entry.
  If `pm2 jlist` ever shows `argus` carrying another app's `PORT` or
  `ARGUS_CONFIG_HASH`, the entry was hijacked: `pm2 delete argus`, kill any
  orphaned `node /infrastructure/argus/services/argus/main.js`, start from
  `argus.config.js` again.
- **Nginx convention on this VM is inverted:** real files live in
  `/etc/nginx/sites-enabled/`, and `sites-available/` holds symlinks into it.
  Replace a host's file in place in `sites-enabled`; keep backups **outside**
  `sites-enabled` (nginx includes `sites-enabled/*`).
- `~/.pm2/dump.pm2.pre-stage5` is the pre-Stage-5 resurrect list (9 legacy apps).

## Dependency changes

Dependencies are installed as part of setup, not by deploys. If
`package-lock.json` changes, run `npm ci --omit=dev` in the affected checkout
and redeploy. The operational UI ships pre-built (`apps/manage/dist`, committed).

## Updating Argus itself

Until self-hosting is automated (Stage 7): `git -C /infrastructure/argus pull --ff-only`,
`npm ci --omit=dev` if needed, `pm2 restart argus`.
