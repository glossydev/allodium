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

## Layout

npm-workspaces monorepo, plain TypeScript, ESM-only, NodeNext resolution
(internal imports need `.js` extensions). `npm run build|typecheck|test` fan out
via `--workspaces --if-present`. Node >= 20.

| Package | Version | State |
|---|---|---|
| `packages/db` | 0.1.1 | **live in prod** — pool factory (`createDb`/`singleton`), money/numeric, wire mappers (`toWireRow`, pg timestamp normalizer family), `isUniqueViolation` (cause-chain walking) |
| `packages/auth` | 0.1.0 | **live in prod** — all factories, zero env reads/framework imports: argon2id passwords (Directus-hash compatible), `createSessionStore` (atomic single-use rotation, origin scoping), reset/state tokens, session cookies, rate limiter. `test/integration.mjs` = 36-check battery (needs `DATABASE_URL`) |
| `packages/storage` | 0.1.0 | **live in prod** — bytes-only disk driver (metadata belongs in the consumer's DB; a sidecar-JSON scaffold was rejected — don't reintroduce), safe-serving helpers (svg-excluded inline set, RFC 5987, cache split) |
| `packages/admin` | 0.1.0 | **live in prod** — `createTableRegistry` (runtime Drizzle metadata + FK graph + secret masking). Second half = the generated-UI lane (future minor) |
| `packages/from-directus` | 0.0.1 | deliberate stub — needs a live test Directus instance + dedicated effort |
| `packages/allodium` | 0.0.1 | npm name reservation; becomes the CLI |

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
