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

## Dependency changes

Dependencies are installed as part of setup, not by deploys. If
`package-lock.json` changes, run `npm ci --omit=dev` in the affected checkout
and redeploy. The operational UI ships pre-built (`apps/manage/dist`, committed).

## Updating Argus itself

Until self-hosting is automated (Stage 7): `git -C /infrastructure/argus pull --ff-only`,
`npm ci --omit=dev` if needed, `pm2 restart argus`.
