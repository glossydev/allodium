# Allodium

> **al·lo·di·um** *(n.)* — land owned absolutely, owing rent, service, and fealty to no lord.

A sovereign, MIT-licensed headless CMS toolkit for **Next.js + Postgres**. No license keys. No telemetry. No revocable grants. No vendor who can relicense you into a corner — every line is MIT, and your Drizzle schema *is* the CMS config.

**Status: early.** Allodium is being extracted, module by module, from a production SaaS migrating off Directus after its second relicense in three years. Each package lands here only after it has survived that migration. Follow along; the receipts are public.

## Why

Directus went BSL in 2023, then MSCL (license keys, mandatory telemetry, an annually-revocable "free" grant) in 2026. MinIO gutted its community edition. Zitadel went Apache→AGPL. The pattern is the product. Allodium's design constraint is simple: **no component you can't own outright.** MIT license, no CLA, dependencies screened for governance risk, and everything runs on one box: your Next.js app and your Postgres. Nothing else.

## The packages

| Package | What it is | Status |
|---|---|---|
| `@allodium/db` | Postgres data-layer conventions on Drizzle + node-postgres: pooling, transactions, typed query-module patterns, migration workflow | scaffolding |
| `@allodium/auth` | First-party auth you own: argon2 passwords, session store, rotating refresh, Google/generic OIDC, WebAuthn passkeys, reset emails, org/tenant membership | scaffolding |
| `@allodium/storage` | Storage driver interface (local-disk now, S3-compatible later) + auth-aware asset serving + sharp transforms | scaffolding |
| `@allodium/admin` | The headline: schema-driven CRUD admin generated from your Drizzle schema — no parallel config language | planned |
| `@allodium/from-directus` | **The Directus exit ramp**: schema puller (captures field metadata Directus hides outside the tables), data importer (argon2 hashes port — zero password resets), compat shim for route-by-route porting | scaffolding |

## Leaving Directus?

That's how this project was born. `@allodium/from-directus` will pull your existing Directus Postgres into a typed Drizzle schema (system tables filtered, enum choices recovered from field metadata), adopt your users table with passwords intact, and give you a `readItems()`-shaped compat shim so you can port routes one at a time while everything keeps working. The full migration playbook — written while doing it for real — ships as documentation.

## Principles

1. **MIT, forever.** No CLA exists, so no one — including us — can relicense contributed code out from under you.
2. **Your schema is the config.** Define tables in Drizzle; admin UI, migrations, and types flow from it. No second schema language, no runtime schema builder, no drift.
3. **One box.** Next.js + Postgres. No sidecar services to run, patch, or license.
4. **Dependencies are screened** for the same governance risks: license, CLA, vendor concentration, relicense history.

## License

[MIT](./LICENSE) — and that's the whole point.
