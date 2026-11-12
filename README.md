# Manage — Beyond Me control & data plane

Phase 3 rebuild of the Beyond Me backend. **Manage** is the control/data plane
(authentication, application registry, canonical data, operation tracking) and
hosts **Argus**, the single deployment/execution engine for all non‑RTF apps.

> **Status: Stage 1 skeleton.** Structure, contracts, config and health only.
> No production deployment behaviour is implemented yet. Argus runs in
> local/test mode and performs **no** Git/PM2/Nginx/shell action.

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
