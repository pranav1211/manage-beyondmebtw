# Manage — Beyond Me control & data plane

Phase 3 rebuild of the Beyond Me backend. **Manage** is the control/data plane
(authentication, application registry, canonical data, operation tracking) and
hosts **Argus**, the single deployment/execution engine for all non‑RTF apps.

> **Status: Stage 3+4 (Argus execution) implemented and proved against an
> isolated non-production target.** Argus execution is **disabled by default**;
> it only runs with `ARGUS_EXECUTION_ENABLED=true` + `ARGUS_MODE=isolated-test`
> and a non-production `PROJECTS_ROOT`. No production deployment has happened.
> The Manage operational UI/API surface is Stage 5.

## Argus (execution plane)

`services/argus/` — webhook verification (per-target HMAC secret refs, default
policy), registry-backed identification, per-app locks with latest-pending-commit
coalescing, git sync (fixed argv, no shell), Argus-generated PM2 ecosystem files
(env by name only), scoped Config Repo commit/push + remote read-back
(`shared/config-repo` `persistOwnedFiles`), PM2 reconcile of the app's own
processes only (unknown processes reported, never deleted), HTTP health gate,
isolated `nginx -t` validate/apply, sanitized operation records. No rollback.

Real end-to-end proof (non-production): `scripts/argus-proof.mjs` — needs
`ARGUS_PROOF_ROOT` (scratch dir) and `CONFIG_REPO_ROOT` (a **disposable**
bmb-infrastructure checkout on a proof branch). Real nginx tests run when
`NGINX_BIN` points at an nginx binary; otherwise they skip. Set
`ARGUS_TEST_TMP` to keep test scratch off a small system drive.

## Architecture boundary

```
Browser (apps/manage)  ──>  Manage API (services/manage-api)  ──>  Argus (services/argus)
       control plane             control / data plane                 execution plane
   never calls Argus         authoritative registry + data        localhost-only, token-auth
```

- The **frontend talks only to the Manage API** (`/api/v1`). It never calls
  Argus and holds no infrastructure credentials.
- **Manage** owns auth, authorization, validation, the application registry,
  desired state, operation tracking, and canonical data.
- **Argus** executes explicitly authorized, typed operations and reports actual
  outcomes. It is **not** a second source of truth, is bound to localhost, is
  token-authenticated, and exposes **no** arbitrary shell/command endpoint.

## Layout

```
apps/manage/          Vite + vanilla JS/HTML/CSS/ES modules frontend
services/manage-api/  Node.js + Express API (auth, registry, data, operations)
services/argus/       argus.js — deployment/infrastructure execution service
data/                 canonical JSON datasets (Git-backed)
content/minis/posts/  canonical Minis Markdown (Git-backed)
shared/               config, schemas (ajv), contracts, sanitized errors
scripts/              validate.js and other dev helpers
tests/                node:test specs + fixtures
docs/                 component-ledger.md, manage-feature-migration-map.md
argus.deploy.json     Manage's own repo-side deployment declaration (no secrets)
```

**Canonical vs runtime vs secrets:**
- `data/` and `content/` are **canonical** and Git-backed (never ignored).
- Logs, build output, journals and temp files are runtime state (gitignored).
- Secrets live only in a local `.env` (gitignored) / server-private env; never
  committed, never logged, never sent to the browser.

## Local setup

Requires Node.js ≥ 24 and npm.

```bash
npm install
cp .env.example .env     # fill local values; never commit .env

npm run dev:api          # Manage API on :7000
npm run dev:argus        # Argus on 127.0.0.1:6040 (execution disabled)
npm run dev:web          # frontend on :5180 (proxies /api -> Manage API)
```

## Verify

```bash
npm run verify           # lint + schema/config validation + tests
# or individually:
npm run lint
npm run validate
npm test
```

## Security boundary (do not regress)

- No arbitrary-command endpoint on Argus — only the typed operation set.
- Argus binds to `127.0.0.1` only (enforced in `shared/config`).
- No client-side auth-by-cookie-flag; sessions are server-validated (Stage 5).
- Canonical data commits stage only operation-owned paths (never `git add .`);
  data-only commits must not trigger code deployment (Stage 6).
