# CLAUDE.md — Allodium

Operational guide for working in this repo. Read this first.

## What this is

**Allodium** is a sovereign, MIT-licensed headless-CMS toolkit for Next.js + Postgres,
published as `@allodium/*` on npm (org account `glossydev`). It is extracted,
module by module, from **ChapterHub** (github.com/glossydev/ChapterHub-app, production:
chapterhub.app) — the reference deployment and first customer. Every 0.1.x package is
code ChapterHub runs in production; nothing ships here that hasn't survived live traffic.

A GlossyDev project (Adam's dev business); ChapterHub is a separate LLC that consumes it.
Agent brain (memories/setup, private): `glossydev/allodium-agent-brain`.

## Where you are

The VS Code workspace root is `projects/allodium/`, which holds **two sibling repos plus
shared agent state**:

```
projects/allodium/          <- workspace root (not a repo itself)
  .brain/                   <- agent brain, its own repo (glossydev/allodium-agent-brain)
  .claude/                  <- Claude Code settings
  allodium/                 <- THIS repo: the library + console
  allodium-site/            <- the site, separate repo with its own session
```

You own `allodium/`. The site reads `docs/` and `packages/*/README.md` from here at build
time and never authors documentation of its own — so anything the site says about the
console changes by changing the console. Leave `allodium-site/` to its session.

Shell cwd is no longer the repo root, so prefer absolute paths or an explicit `cd`.

## Layout

npm-workspaces monorepo (`packages/*` + `apps/*`), plain TypeScript, ESM-only,
NodeNext resolution (internal imports need `.js` extensions). `npm run build|typecheck|test`
fan out via `--workspaces --if-present`. Node >= 20.

**`apps/console`** — the developer console (the *build-the-site* lane). `npm run console`
→ http://localhost:3180. Catalog-driven (reads pg_catalog per request, not a Drizzle
registry), six silos + an Admin Builder placeholder. Dev harness today; pieces graduate
into `@allodium/admin` as they stabilize. **Read `apps/console/ARCHITECTURE.md` before
touching it** — it carries the safety model, silo file ownership, and hard-won
conventions. Local Postgres: container `allodium-dev-pg` on 5433, db `allodium_dev`,
seeded by `dev/seed/*.sql` (run 001→004 in order on a fresh database).

| Package | Version | State |
|---|---|---|
| `packages/db` | 0.2.0 | **live in prod** (ChapterHub on 0.1.1, unchanged code) — pool factory (`createDb`/`singleton`), money/numeric, wire mappers (`toWireRow`, pg timestamp normalizer family), `isUniqueViolation` (cause-chain walking) |
| `packages/auth` | 0.3.0 | **live in prod** — all factories, zero env reads/framework imports: argon2id passwords, `createSessionStore` (atomic single-use rotation, origin scoping, active-user + origin checks on rotate, revoke by either token), `createAuthRoutes` (login/logout/refresh/me, CSRF-gated), `createAccessPolicy`/`createGrantLoader` (role × table × action + row filters, fail-closed), reset/state tokens, cookies, rate limiter, `createActAs`. OIDC/passkeys/reset routes: planned entry points, NOT built |
| `packages/storage` | 0.2.0 | **live in prod** — bytes-only disk driver (metadata belongs in the consumer's DB; a sidecar-JSON scaffold was rejected — don't reintroduce), safe-serving helpers (svg-excluded inline set, RFC 5987, cache split) |
| `packages/admin` | 0.4.0 | **live in prod** — root: `createTableRegistry`. `./view`: the `.view.json` contract + JSON Schema (parity-tested), filters, links. `./server`: resolver (grants, masking, related lists, gated labels/pickers/memberships, post-write grant check), `createAdminRoutes` (+ `_files` uploads), `createFileViewStore`. `./react`: hooks + unstyled components incl. the file widget |
| `packages/from-directus` | 0.0.1 | deliberate stub — needs a live test Directus instance + dedicated effort. The compat shim idea was dropped 2026-10 (it is a query compiler); the migration playbook is docs |
| `packages/allodium` | 0.0.1 | npm name reservation; becomes the CLI |

Versions are independent (db/storage move only when they change). Consumers: ChapterHub
(0.1.x line), AdamAronoff.com (first from-scratch consumer, 0.3/0.4). Releases: tag `vX.Y.Z`
→ `publish.yml` publishes by trusted publishing (OIDC + provenance); no npm token exists.
Bump the console's `@allodium/*` caret ranges BEFORE `npm version`, or npm installs a
registry copy under `apps/console/node_modules`.

## Conventions

- **drizzle-orm / pg / argon2 are PEER dependencies** — never regular deps.
- **Factories over singletons**: packages read no env vars and import no framework;
  consumers bind config once and re-export. Env-driven values are passed as thunks
  (`() => process.env.X`) to keep call-time semantics.
- **Publish flow**: bump version in `packages/<name>/package.json` → `npm run build`
  → unit-smoke the dist → `npm publish --access public` **from the package dir, never
  the repo root** (a stray persisted `cd` once installed a package into itself).
  Token: repo-root `.npmrc`, gitignored — never in any repo; rotation is a standing
  owner item.
- **The verification bar** (how every extraction shipped; hold it for changes too):
  unit-smoke the built dist → integration test against live pg where semantics live →
  ChapterHub consumes from npm with every export name preserved → golden byte-diff of
  its API surface pre/post → prod deploy + sanity. ChapterHub's swap **is** the test
  suite; coordinate breaking releases with its agent (glossy-suite a2a).
- **Public copy** (README, package descriptions): positive-only — what Allodium does,
  never callouts of other vendors by name. Owner directive.

## GDS registry & agent brain

Registered in the GlossyDevServer registry as external **deployment 16** (registry of
record only; nothing hosted, no analytics — it's a library). Agent brain:
`git@github.com:glossydev/allodium-agent-brain.git` — update and push when you learn
something durable. Suite work bucket: **Allodium (id 14, GlossyDev client)** —
`list_open_tasks` via the glossy-suite MCP. After significant package/API changes, refresh the
project guide via the glossy-deploy MCP action `submit_site_brief`
(deployment_id=16, include `source_commit`).

## History

Extracted July 2026 during ChapterHub's Directus exit (its `docs/DIRECTUS_EXIT_PLAN.md`
and `docs/DIRECTUS_TO_DRIZZLE_COOKBOOK.md` are the archaeology; the cookbook is the
source text for `from-directus`). Phase C split 2026-07-28: own repo, own agent, own
brain. Roadmap next: auth later-minor (passkeys, OIDC glue, middleware single-flight
refresh factory), the admin generated-UI lane (ChapterHub's future customer-service
dashboard at admin.chapterhub.app is its first customer), `from-directus` for real,
then the CLI.
