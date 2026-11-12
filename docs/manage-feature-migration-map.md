# Manage Feature → New Module Migration Map

**Status:** Stage 0/1 planning map. Maps each capability of the legacy `manage/` implementation to its new owner in this repository. Not a cutover authorization. Full implementation of these mappings is Stage 2+.

**Module owners:**
- `apps/manage/` — frontend presentation/interaction (Vite + vanilla JS/HTML/CSS/ES modules).
- `services/manage-api/` — authentication, authorization, validation, business rules, API contracts, canonical data operations.
- `services/argus/` — deployment/infrastructure execution (localhost-only, authenticated, no arbitrary shell).
- `data/` — canonical JSON datasets. `content/minis/posts/` — canonical Minis Markdown.
- `shared/` — schemas, contracts, config, sanitized errors.

| Legacy capability | Legacy location | Old behavior (summary) | New owner | New contract (target) | Notes |
|---|---|---|---|---|---|
| Login / auth | `manageserver.js` `/loginauth`; `authentication.js`; frontend cookie | Shared plaintext `managekey`; client-side cookie=`true` | `services/manage-api` (+ `apps/manage` UI) | `/api/v1/auth` server-validated session; secure cookie | **Do not** reuse cookie=`true`+key model |
| Homepage featured / latest | `/latestdata` + `manage/latest.json` | In-memory merge w/ public site JSON; write local + `jsonupdatebmb.sh` | `services/manage-api` + `data/home/` | `/api/v1/home` domain view over canonical resource | Preserve referenced post/project/mini IDs |
| Blog categories / subcategories | `/category` | Manifest CRUD; cascade `secondaryCategory` refs; `saveCategoriesConfig` | `services/manage-api` + `data/blog/categories.json` | `/api/v1/blog/categories` + structural ops w/ reference validation | Catalog-backed; no new route per category |
| Blog posts | `/blogdata`, `/blogposts` | Per-category JSON CRUD; reads public site JSON | `services/manage-api` + `data/blog/*.json` | `/api/v1/blog/:category` reads from canonical store | Reverse data direction (serve, don't fetch public) |
| Projects catalogue | `/projectsdata`, `/blogdata` project actions | `project-data.json` CRUD; image normalization | `services/manage-api` + `data/projects/` | `/api/v1/projects` | Separate from deploy registry |
| Photos series/images/layout | `/photosdata` | `photos.json` series/image/layout/reorder CRUD | `services/manage-api` + `data/photos/` | `/api/v1/photos` | Resolve canonical path first (ledger U3) |
| Minis listing | `/minismetadata` | Proxy public Minis `metadata.json` | `services/manage-api` + `content/minis/posts/` | `/api/v1/minis/posts` derived from canonical Markdown | Minis backend stays sole editor |
| Deploy registry / clone / onboarding | `/deployregistry`; `.registry.json`; `git clone` via execFile; serve-symlink layout; multigitman status fetch | Registry override table + direct git clone + symlink reshaping | **split**: registry/desired-state → `services/manage-api`; execution (clone/deploy/symlink) → `services/argus` | Admin-only registry endpoints; typed Argus operations over private API | Frontend never calls Argus; no arbitrary shell |
| Canonical data persistence | `jsonupdatebmb.sh` via `runScriptIgnoreError` | `git add .` + commit + push, errors swallowed | `services/manage-api` (persistence layer) | Scoped, journaled, path-restricted commits; data-only ≠ code deploy | Stage only operation-owned paths |
| Dashboard / management UI | `dashboard.html`, `index.js`, `manage.html`, `styles.css` | Vanilla JS admin UI calling legacy endpoints | `apps/manage/` | Vite vanilla-JS shell calling `/api/v1/*` only | Reuse UI patterns, new API contract |
| Deploy engine (webhook) | `multigitman.js` (+ `beyondgitman.js`, `minisgitman.js`) | Webhook → fetch+reset+clean; per-folder lock; serve symlink | `services/argus/argus.js` | Webhook → identify → validate → sync → (PM2 reconcile) → health; latest-pending-commit; no rollback | Argus is the single non-RTF engine |
