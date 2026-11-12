# Component Ledger — Phase 3 Stage 0

**Status:** Stage 0 source reconciliation. Prepared locally from supplied inventories + live repository source. No production change is authorized by this document.

**Evidence tiers** (per directive §2):
- **[src]** confirmed by reading current source code (live local repos: `Beyondmebtw`, `Minis`).
- **[snap]** confirmed by the supplied 10–11 Nov 2026 read-only inventory set (`all-files.zip`: pm2/nginx/route/persistent-data/shellfile/infra maps) and the directive's live snapshot.
- **[inf]** inference from the above; not directly observed.
- **[?]** unresolved — needs live confirmation before the related cutover.

**Evidence locations:** inventory set extracted read-only to the session scratchpad (`…/phase3-evidence/`): `pm2-runtime-inventory.txt`, `nginx-inventory.txt`, `final-route-inventory.txt`, `persistent-data-inventory.txt`, `deployment-script-map.txt`, `all-deployment-shellfiles.txt`, `beyond-me-infrastructure-detail.txt`, `project-onboarding-map.txt`, `projects-deployment-map.txt`, `bmb.txt` (full fs dump). Legacy source read from `Beyondmebtw/manage/manageserver.js`, `Beyondmebtw/{beyondgitman,multigitman}.js`, `Minis/{minisgitman.js,backend/**}`.

**Disposition legend:** `migrate` (move as-is to new owner) · `replace` (rebuild against new contract) · `retire` (remove after cutover) · `preserve for RTF` (out of Phase 3 scope) · `verify` (evidence gap to close).

---

## 1. Repositories / applications

| Component | Current owner / location | Responsibility | Evidence | Target owner / component | Disposition | Unresolved |
|---|---|---|---|---|---|---|
| Beyondmebtw (main site) | `/bmbsifi/Beyondmebtw` · `git@github.com:pranav1211/Beyondmebtw` | Static site (home/about/blog/projects/photos/music) + currently hosts `manage/`, `beyondgitman.js`, `multigitman.js`, canonical JSON data | [src][snap] | App stays its own repo at `/projects/beyondmebtw` (static); Manage + Argus + canonical data extract to new repo | migrate (deploy path) + extract Manage/data | Final `/projects/beyondmebtw` cutover is Stage 10+, not now |
| Manage (new) | *this repo* `manage-beyondmebtw` (empty) → `/projects/manage` | Control/data plane: auth, registry, canonical data, operation tracking; hosts Argus | [src] legacy ref | `services/manage-api` + `apps/manage` + `data/` + `content/` | replace (rebuild from legacy reference) | — |
| Minis | `/minisbmb/minis` · `git@github.com:pranav1211/minis.git` | Independent Astro static frontend + Express backend (public post editor) + `minisgitman.js` | [src][snap] | `/projects/minis` (type `node`); canonical Markdown ownership moves to Manage | migrate (deploy) + refactor (content workflow) | — |
| Minis Private | `/minisbmb/minis-private` · own repo | Private encrypted content app (port 7005) | [snap] | `/projects/minis-private` (Argus-managed deploy); **content stays private, NOT in Manage store** | migrate (deploy only) | Runtime/port/health specifics [?] |
| Beyond Money | `/bmbmoney/beyond-money` · own repo | Independent product (static `dist/` + `bmbmoneygitman.js` webhook); uses Supabase | [snap] | `/projects/beyond-money` (Argus-managed deploy); product data stays its own boundary | migrate (deploy) + verify | Supabase/env ownership [?] |
| Room Temperature Film (RTF) | `/rtf/roomtemperaturefilm` · own repo | Independent tenant: own gitman, PM2, `rtf.sh` (fetch+reset+npm+pm2 restart), own data/config | [src][snap] | **Unchanged** | preserve for RTF | — |
| General Projects | `/projects/<app>` (+ `.checkouts/`) | Small static/node apps deployed via multigitman wildcard | [src][snap] | `/projects/<app>` via Argus | migrate per registry | Full per-project inventory [?] |

---

## 2. PM2 processes (9 online, 18d uptime, 0 restarts) — [snap] `pm2-runtime-inventory.txt`

| Process | Script path (cwd) | Role | Port | Target | Disposition |
|---|---|---|---|---|---|
| `beyondgitman` | `/bmbsifi/Beyondmebtw/beyondgitman.js` | Webhook `/bmbg`; HMAC (`beyondmegitkey`); runs `beyond.sh` (git pull main site) | **6009** [src+nginx] | Argus deploy (static, beyondmebtw) | replace with Argus |
| `multigitman` | `/bmbsifi/Beyondmebtw/multigitman.js` | Webhook `/multig`; HMAC (`multigitkey`); registry-driven fetch+reset+clean; per-folder lock; serve-symlink layout; state in `/gitlogs` | **6030** [src] | **Argus** (direct ancestor) | replace with Argus |
| `manageserver` | `/bmbsifi/Beyondmebtw/manage/manageserver.js` | Legacy Manage HTTP API (auth, blog/projects/photos/category CRUD, deploy registry, data persistence) | **7000** [src+nginx] | `services/manage-api` | replace |
| `bmbmoney-webhook` | `/bmbmoney/beyond-money/bmbmoneygitman.js` | Beyond Money deploy webhook | **7020** [nginx `/beyondmoneyg`] | Argus deploy (beyond-money) | verify, then replace deploy role |
| `minisgitman` | `/minisbmb/minis/minisgitman.js` | Webhook `/minisg`; HMAC (`minisgitkey`); runs `minis.sh` (git pull) | **6011** [src] | Argus deploy (minis) | replace |
| `minisbackend` | `/minisbmb/minis/backend/server.js` | Minis public editor API + HTML publish | **7004** [nginx `/api/`,`/editor`,`/health`] | Stays Minis app; CRUD re-points to Manage API | refactor (keep process) |
| `minis-private` | `/minisbmb/minis-private/server.js` | Private Minis app | **7005** [nginx `/p/`,`/private`,`/minisg-private`] | `/projects/minis-private` via Argus | migrate (deploy only) |
| `rtf-git` | `/rtf/roomtemperaturefilm/gitman.js` | RTF webhook `/rtfg` | **6021** [nginx] | Unchanged | preserve for RTF |
| `rtf-web` | `/rtf/roomtemperaturefilm/manage/server.js` | RTF web/manage app | **7014** [nginx] | Unchanged | preserve for RTF |

**Casing note:** inventory shows `minisbackend` (lowercase); directive mentioned possible `minisBackend` variant. Live `pm2-runtime-inventory.txt` shows a single `minisbackend` — **no duplicate confirmed** [snap]. Final `pm2 jlist` vs ecosystem-file confirmation remains [?].

---

## 3. Legacy Manage API endpoints — [src] `manage/manageserver.js` (port 7000)

All write endpoints gated by a single shared `managekey` (plaintext compare, from `/etc/environment`). CORS `*`. Target: versioned `/api/v1/*` under `services/manage-api`, server-validated sessions.

| Endpoint (method) | Handler role | Target capability | Disposition |
|---|---|---|---|
| `/loginauth` (POST) | Validates shared key | `/api/v1/auth` session login + server-side authz | replace |
| `/category` (GET/POST) | Category manifest read; add/update/delete category + subcategory; cascades `secondaryCategory` refs | `/api/v1/blog/categories` + structural ops | replace |
| `/latestdata` (POST) | Homepage featured/main-post/featuredProjects/featuredMinis update; merges from **public** `beyondmebtw.com/manage/latest.json` | `/api/v1/home` (or `about`) domain resource | replace; migrate data |
| `/blogdata` (POST/PUT/DELETE) | Blog post CRUD per category; also project create/update/delete; writes per-category JSON + `latest.json`; runs `jsonupdatebmb.sh` | `/api/v1/blog/:category/posts` + canonical persistence | replace (parity required) |
| `/blogposts` (GET) | Returns in-memory blog data (loaded via HTTP from **public** `beyondmebtw.com/blog/*.json`) | `/api/v1/blog` reads from canonical store | replace (reverse data direction) |
| `/projectsdata` (GET/POST/PUT/DELETE) | Project catalogue CRUD → `projects/project-data.json` | `/api/v1/projects` | replace |
| `/photosdata` (GET/POST) | Photo series/image/layout CRUD → `photos.json` | `/api/v1/photos` | replace |
| `/minismetadata` (GET) | Proxies **public** `minis.beyondmebtw.com/content/metadata.json` (CORS workaround) | `/api/v1/minis/posts` derived from Manage canonical Markdown | replace |
| `/deployregistry` (POST: list/set/delete/clone) | Reads/writes `/projects/.registry.json`; `clone` runs `git clone` via execFile; serve-path symlink layout; fetches multigitman status at `localhost:6030` | Versioned application-registry endpoints (admin-only); deploy ops delegated to Argus | replace + migrate state |
| **`/searchblogpost`** | **No handler in `manageserver.js`** — but Nginx proxies it to :7000 | Versioned search API *if* a consumer needs it | **verify → retire** (dead route: Nginx `manage…:25` → :7000 with no backend handler) |

---

## 4. Shell scripts — [src] `all-deployment-shellfiles.txt`

| Script | Invoker | Side effects | Target | Disposition |
|---|---|---|---|---|
| `/shellfiles/beyond.sh` | `beyondgitman.js` webhook | `cd /bmbsifi/Beyondmebtw; git pull` + log | Argus Git sync | replace |
| `/shellfiles/minis.sh` | `minisgitman.js` webhook | `cd /minisbmb/minis; git pull` + log | Argus Git sync | replace |
| `/shellfiles/bmbpull.sh` | manual/webhook (Beyond Money) | `cd /bmbmoney/beyond-money; git pull` + log | Argus Git sync | replace |
| `/shellfiles/jsonupdatebmb.sh` | `manageserver.js` (`runScriptIgnoreError`) after data writes | `cd /bmbsifi/Beyondmebtw; git add .; commit "dataupdate"; push` | Manage scoped journaled canonical persistence (stage only owned paths) | **replace** |
| `/shellfiles/updateminis.sh` | `minisbackend` (`shellRunner`, fire-and-forget) after post CRUD | `cd /minisbmb/minis; git add .; commit "dataupdate"; push` | Manage canonical Markdown persistence (separate from HTML publish) | **replace** |
| `/shellfiles/bmbpush.sh` | manual (Beyond Money) | `cd /bmbmoney/beyond-money; git add .; commit "dataupdate"; push` | Product-owned; **not** folded into Manage | verify; do not migrate into Manage |
| `minis-private/shellfiles/minisprivate.sh` | manual | `git pull` private repo | RTF-like separate boundary | preserve (private) |
| `minis-private/shellfiles/updateminisprivate.sh` | `minis-private` server after CRUD | stages+commits+pushes **encrypted content only** (keeps code out) | Private app's own persistence | preserve (private) |
| `rtf/shellfiles/{gitpull,gitpush,rtf}.sh` | RTF gitman / manual | RTF deploy: fetch, reset --hard, `npm install`, `pm2 restart rtf-web rtf-git` | Unchanged | preserve for RTF |

**Ownership correction (directive §5):** every legacy persistence/pull script uses broad `git add .` / `git pull` against an application repo. The target must NOT carry `git add .` into Manage: canonical data commits stage only operation-owned JSON/Markdown paths; application code stays development-owned and Argus deploys code pushes.

---

## 5. Persistent / canonical data sources — [src][snap] `persistent-data-inventory.txt`

| Source path | Role | Target (Manage `data/`/`content/` or preserve) | Disposition |
|---|---|---|---|
| `Beyondmebtw/blog/categories.json` | Blog category manifest (public; read by Manage + clients) | `data/blog/categories.json` (catalog key `blog.categories`) | migrate |
| `Beyondmebtw/blog/{experience,f1arti,movietv,techarti,theretrospect,…}.json` | Per-category post data | `data/blog/<cat>.json` | migrate; **completeness vs manifest [?]** |
| `Beyondmebtw/manage/latest.json` | Homepage main/featured/projects/minis selection | `data/home/latest.json` (preserve referenced IDs) | migrate |
| `Beyondmebtw/projects/project-data.json` | Projects showcase catalogue | `data/projects/project-data.json` | migrate |
| `photos.json` | Photo series/images/layout | `data/photos/photos.json` | migrate; **path discrepancy [?]** (see below) |
| `/projects/.registry.json` | multigitman deploy registry override table | Manage authoritative application registry (reconciled w/ `argus.deploy.json`) | migrate + reconcile |
| `Minis/content/*.md` | Canonical public Minis Markdown posts (stable `mini_xxxxxx` IDs) | `content/minis/posts/<id>.md` | migrate |
| `Minis/content/metadata.json` | **Derived** listing index (regenerated from Markdown) | Rebuilt by Manage; **no competing canonical copy** | replace (derived) |
| `Minis/minis-private` content | Private encrypted content | **Stays private**, excluded from Manage | preserve (private) |
| `Beyond Money` Supabase/local state | Product data/build output | Beyond Money's own boundary | preserve separate |
| `RTF` data/config | RTF-owned | Unchanged | preserve for RTF |
| `Beyondmebtw/repo_map.json` | Dev documentation artifact | Not canonical app data | verify (likely dev-only) |

**Photos path discrepancy [?]:** `manageserver.js` constants read/write `/bmbsifi/Beyondmebtw/photos/photos.json` (with local fallback), while the persistent-data inventory also references `/projects/photos/photos.json`. Must confirm the single live source-of-truth + real consumers before choosing the canonical destination.

---

## 6. Nginx server blocks / key routes — [snap] `nginx-inventory.txt`

TLS via Certbot (wildcard/subdomain); redirects 80→443. RTF rows preserved.

| Host | Root | Key proxied routes (→ upstream) | Target treatment | Disposition |
|---|---|---|---|---|
| `beyondmebtw.com` | `/bmbsifi/Beyondmebtw` | `/bmbg`→6009 (beyondgitman), `/multig`→6030 (multigitman), `/projects/`, `/` | Move root → `/projects/beyondmebtw`; `/bmbg`,`/multig` → Argus webhook endpoint | replace after parity |
| `about.beyondmebtw.com` | `/bmbsifi/Beyondmebtw/about` | static | Move root under registered app | migrate |
| `blog.beyondmebtw.com` | `/bmbsifi/Beyondmebtw/blog` | static | Move root under registered app | migrate |
| `manage.beyondmebtw.com` | `/bmbsifi/Beyondmebtw/manage` | `/loginauth`,`/latestdata`,`/category`,`/projectsdata`,`/photosdata`,`/blogposts`,`/blogdata`,`/searchblogpost`,`/deployregistry` → **7000** | New Manage `/api/v1/` upstream; `/searchblogpost` dead → drop | replace after endpoint parity |
| `minis.beyondmebtw.com` | `/minisbmb/minis/frontend/dist` | `/api/`→7004, `/editor`→7004, `/health`→7004, `=/content/metadata.json` (special), `/minisg`→6011, `/p/`→7005, `/private`→7005, `/minisg-private`→7005 | Preserve public/editor/private split; update upstreams; drop canonical metadata proxy; **never expose Argus or private content** | migrate route-by-route |
| `projects.beyondmebtw.com` | `/bmbsifi/Beyondmebtw/projects` | static (projects *showcase page* — distinct from `/projects/` deploy root) | Keep as site section | migrate |
| `projects-wildcard` | `/projects/$sub` | wildcard subdomain → per-app folder | Keep locked wildcard default | retain target behavior |
| `beyondmoney.beyondmebtw.com` | `/bmbmoney/beyond-money/dist` | `/beyondmoneyg`→7020, `/assets/…` | Move root → `/projects/beyond-money`; webhook → Argus | verify + migrate |
| `roomtemperaturefilm.com` | `/rtf/roomtemperaturefilm` | `/`→7014, `/rtfg`→6021 | Unchanged | preserve for RTF |
| `manage.roomtemperaturefilm.com` | `/rtf/roomtemperaturefilm` | `/`→7014 | Unchanged | preserve for RTF |

---

## 7. Key confirmed findings (seed the rebuild)

1. **Auth is a shared plaintext key** [src]: `managekey` from `/etc/environment`, compared directly; the Manage frontend uses a client-side cookie. Both the main Manage API and the Minis backend (`backend/lib/auth.js`) share this one key. → **replace** with server-validated sessions; never carry forward cookie=`true`+reusable-key.
2. **Data direction is backwards** [src]: `manageserver.js` reads canonical data over HTTPS from the *public* site (`beyondmebtw.com/manage/latest.json`, `beyondmebtw.com/blog/<cat>.json`, `minis.beyondmebtw.com/content/metadata.json`). Target reverses this: Manage serves canonical data from its local store; apps consume Manage APIs.
3. **Persistence is `git add .` fire-and-forget** [src]: writes call `jsonupdatebmb.sh` via `runScriptIgnoreError` (errors swallowed). → **replace** with scoped, journaled, path-restricted persistence; separate data-only from code-deployment triggers.
4. **Minis success masks publish failure** [src]: in `backend/routes/posts.js`, canonical `writePost` + `regenerateMetadata` are awaited, but `writePostPage` (standalone HTML) and `runShellScript` (git push) are fire-and-forget `.catch()` — CRUD returns `success` even if HTML generation or push fails. → **refactor** to report canonical persistence and publication separately, with idempotent publication retry.
5. **`multigitman.js` is Argus's direct ancestor** [src]: `/multig` webhook, HMAC verify, registry override table, `fetch`+`reset --hard`+`clean -fd`, per-folder in-flight lock, latest-write-wins via lock (no queue/coalesce yet), serve-symlink layout, state in `/gitlogs`. Argus generalizes it: adds `node` type + PM2 reconcile + health check + latest-pending-commit coalescing + Nginx validation + no-rollback discipline.
6. **`/searchblogpost` is a dead route** [src+snap]: proxied by Nginx to :7000 but has no handler in `manageserver.js`.

---

## 8. Unresolved items (close before the related cutover; none block Stage 1)

| # | Item | Evidence needed | Risk if unresolved | Status |
|---|---|---|---|---|
| U1 | beyondgitman vs multigitman port mapping | `ss -tlnp` / `pm2 jlist` | low — **largely resolved**: `multigitman.js` hardcodes 6030; Nginx maps `/multig`→6030, `/bmbg`→6009 [src+snap] | near-closed; live confirm optional |
| U2 | PM2 ecosystem source for all 9 processes | only ~4 `ecosystem.config.js` found for 9 procs; need `pm2 jlist` + each process's config origin | medium — can't reproduce PM2 state without it | open |
| U3 | Photos canonical path | which of `Beyondmebtw/photos/photos.json` vs `/projects/photos/photos.json` is live + consumers | medium — wrong source → data loss on migrate | open |
| U4 | Category manifest completeness | diff `categories.json` keys vs on-disk `blog/*.json` vs rendered pages/post refs | medium — missing category data on migrate | open |
| U5 | Process-name casing / duplicate checkouts | `pm2 jlist`; `/projects/.checkouts` listing | low | open (no duplicate seen in snapshot) |
| U6 | `bmbmoney-webhook` scope | read `bmbmoneygitman.js` (not in local repos) | medium — may hold product logic beyond deploy | open |
| U7 | Each script's true invoker (cron/manual/webhook) | user crontab empty [snap]; confirm no app-triggered cron/systemd | low | mostly closed (empty crontab) |

**Resolution policy:** these are evidence gaps, not open architecture questions. They are closed by a later **read-only** pass (inventory re-read or a narrow read-only SSH check), not by guessing. VPS confirmation is deferred and is not required for Stage 1.

---

## Gate 0 assessment

Every in-scope component has an owner, responsibility, evidence pointer, target, and disposition. RTF and Minis Private are documented as preserved/out-of-scope. No unexplained active route, process, data path, or deploy side effect remains in the cutover scope — the remaining items (U1–U7) are explicit, low/medium-risk evidence gaps with a named closing method, and none blocks creating the Stage 1 skeleton. **Gate 0: met for the purpose of starting Stage 1.**
