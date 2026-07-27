# Allodium

> **al·lo·di·um** *(n.)* — land owned absolutely, owing rent, service, and fealty to no lord.

A sovereign, MIT-licensed headless CMS toolkit for **Next.js + Postgres**. Your Drizzle schema *is* the CMS config — the data layer, auth, storage, and admin tooling all flow from it. No license keys, no telemetry, nothing to rent, nothing that can be taken back.

**Status: early.** Allodium is being extracted, module by module, from a production SaaS. Every package earns its place by running live in that product before it lands here.

## The idea: two lanes, and one builds the other

Every CMS serves two very different kinds of users — the developers building the product and the people running it day to day — and most platforms make them share one interface, which ends up fitting neither. Allodium gives each their own lane:

- **The developer console** — lean, dense, schema-driven, zero per-table configuration. Every table in your Drizzle schema appears automatically: browsable data grids, live schema truth straight from the Postgres catalog (with drift detection against your code), relationship-following, and a SQL console that is read-only *at the database level*. It's an instrument panel for building the site — so it stays deliberately separate from your app: its own login, its own sessions, its own subdomain if you want one.
- **The bespoke admin** — a tool for *running* the site. Friendly, guided views for the people doing support and content work, created **from the console** over the same data. It shares your app's authentication by design, because its users *are* your app's users with elevated roles.

Developers get raw, fast, and honest; operators get an interface shaped like their actual job. Neither has to live in a UI designed for the other.

## Principles

1. **MIT, forever.** There is no CLA — which means no one, including us, can ever relicense contributed code out from under you. The version you install is yours for good.
2. **Your schema is the config.** Define tables in Drizzle; the console, types, and migrations flow from it. No second schema language, no runtime schema builder, no drift between what you wrote and what runs.
3. **One box.** Your Next.js app and your Postgres. No sidecar services to deploy, patch, monitor, or license.
4. **Own it outright.** Dependencies are screened for license and governance risk, everything self-hosts, and nothing phones home.

## The packages

| Package | What it is | Status |
|---|---|---|
| `@allodium/db` | Postgres data-layer conventions on Drizzle + node-postgres: pooling, transactions, typed query-module patterns, migration workflow | scaffolding |
| `@allodium/auth` | First-party auth you own: argon2 passwords, session store, rotating refresh, Google/generic OIDC, WebAuthn passkeys, reset emails, org/tenant membership | scaffolding |
| `@allodium/storage` | Storage driver interface (local-disk now, S3-compatible later) + auth-aware asset serving | scaffolding |
| `@allodium/admin` | The two-lane story above: the schema-driven developer console, and the toolkit for generating bespoke admins from it | planned |
| `@allodium/from-directus` | Migration tooling for teams arriving from Directus: schema puller (recovers field metadata into typed Drizzle), data importer (password hashes port intact — zero forced resets), and a compat shim for porting routes one at a time | scaffolding |

## Migrating from an existing CMS?

Allodium was extracted during exactly that kind of migration, and the tooling ships with it. `@allodium/from-directus` pulls an existing Directus Postgres into a typed Drizzle schema (system tables filtered, enum choices recovered from field metadata), adopts your users table with passwords intact, and provides a `readItems()`-shaped compat shim so you can port routes one at a time while everything keeps working. The full migration playbook — written while doing it for real, with per-slice verification recipes — ships as documentation.

## License

[MIT](./LICENSE) — and that's the whole point.
