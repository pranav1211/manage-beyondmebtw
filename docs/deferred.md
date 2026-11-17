# Deferred decisions and hardening

Items the developer has consciously parked. Each has enough context to pick up later.

## Per-repository deploy keys (security hardening)

**Status:** deferred by the developer, 17 November 2026 (priority: ship). Good practice; do when there is room.

**Today:** the VM authenticates every `git fetch`/`git push` with one SSH key (`~pvr/.ssh/id_ed25519`) registered on the developer's GitHub account. GitHub treats the server as the developer: it can read and write every repository the account can reach. Commit author labels such as "minis-private bot", "manage" and "minis" are cosmetic; they do not limit access.

**Target:** one deploy key per repository, attached to that repository only:

| Repository | Access | Used by |
|---|---|---|
| bmb-data | read + write | Manage data/registry writes, webhook sync |
| bmb-infrastructure | read + write | Argus PM2-config commits |
| minis | read + write | Minis backup push; Argus deploys |
| minis-private | read + write | its storage sync; Argus deploys |
| manage-beyondmebtw (Argus bootstrap + Manage checkouts) | read-only | Argus deploys, bootstrap updates |
| f1-titles-data, Beyondmebtw, PhotosBMB, beyond-money | read-only | Argus deploys |

**Plan:**
1. Generate one ed25519 key per repository on the VM (`~pvr/.ssh/deploy/<repo>`, mode 600). Never print private keys.
2. Add `~pvr/.ssh/config` host aliases (`github-<repo>`, `IdentitiesOnly yes`).
3. Developer adds each public key under the repo's Settings → Deploy keys ("Allow write access" only for the write repos).
4. Switch each checkout's `origin` to its alias and update the expected-remote settings that check the remote (Manage `DATA_REPO_REMOTE`, Config Repo expected remote). Registry `repository` values remain `git@github.com:...` as identities.
5. Verify per repository: fetch, push where applicable, a webhook-driven deploy, Manage write + read-back, Argus PM2-config commit.
6. Only then may the developer remove the account-level key from GitHub. Keep it until every path is verified.

## Blog / projects / homepage editor

**Status:** deferred until the backend migration is finished.

Today the Manage dashboard Data page is the only editor for `blog.*`, `projects` and `home.latest`. A future editor application (with its own server) would receive a narrowly scoped Manage token.

## Skip Node restarts when a push changes nothing the process uses

**Status:** deferred by the developer, 17 November 2026.

**Today:** static apps (beyondmebtw, photos, beyond-money) are only synced and health-checked on push; nothing restarts. Every new commit to a Node app with auto-deploy on (manage-beyondmebtw, f1-titles-data) recreates its PM2 process, even when only docs or content changed. minis and minis-private have auto-deploy off because their own content commits would otherwise restart them.

**Proposal:** after fetching, Argus lists `git diff --name-only <deployed>..<new>`. An app may declare `noRestartPaths` globs in its `argus.deploy.json` (e.g. `["content/**", "**/*.md"]`). If every changed path matches, Argus syncs the files and skips the PM2 reconcile (the operation records `restart: skipped` with the path list); otherwise it restarts as today. No declaration = current behaviour, so it cannot reduce safety. A change to `package.json`/`package-lock.json` is flagged, since dependencies are installed by hand. Payoff: minis/minis-private can turn auto-deploy back on, so code pushes deploy themselves while content pushes do not restart them. Needs tests (all-match skip, mixed change restarts, no declaration, first deploy, declaration change itself restarts).

## Argus production Nginx operations

**Status:** remain disabled. Any future proposal must define allowed operations, validation (`nginx -t`), authorization, recovery and production boundaries.
