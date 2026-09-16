# Allodium

> **al·lo·di·um** *(n.)* — land owned absolutely, owing rent, service, and fealty to no lord.

A sovereign, MIT-licensed headless CMS toolkit for **Next.js + Postgres**. A set of packages, not a framework: install the pieces you want, call them from your own code, and the data layer, auth, storage and admin screens flow from the database you already have. No license keys, no telemetry, nothing to rent, nothing that can be taken back.

**Status: real, and in use.** Every package was extracted from a production SaaS and verified against live traffic before it was published. The admin runtime and the permission model shipped in 0.2.0; the first application built on Allodium from a blank repo, by someone with nothing but the docs, went from install to a working back office in an afternoon and shaped the two releases that followed.

```bash
npm install @allodium/db @allodium/auth @allodium/storage @allodium/admin
```

Start with **[docs/getting-started.md](./docs/getting-started.md)**.

## The idea: two lanes, and one builds the other

Every CMS serves two very different kinds of users — the developers building the product and the people running it day to day — and most platforms make them share one interface, which fits neither. Allodium gives each their own lane:

- **The developer console** *builds* the site. Schema editing with every change previewed as SQL before it runs, users, roles and a permission matrix, files, a read-only SQL console, and the Admin Builder. It runs on your machine against your database, binds to localhost only, and is never deployed.
- **The admin dashboard** *runs* the site. Friendly, guided screens for the people doing content and support work, rendered by your app from small JSON files the console writes. It shares your app's authentication, because its users *are* your app's users with elevated roles.

Nothing passes between the lanes except those files. A screen is a `.view.json` in your repo — committed, diffed and reviewed like any other code:

```json
{
  "table": "posts",
  "title": "Blog posts",
  "fields": [
    { "column": "title", "label": "Headline", "help": "Shown in search results." },
    { "column": "status", "widget": "radio" },
    { "kind": "relation", "column": "author_id", "relation": { "table": "authors", "display": "name" } },
    { "kind": "m2m", "through": "post_tags", "near": "post_id", "far": "tag_id", "farTable": "tags", "display": "label" }
  ],
  "related": [{ "table": "comments", "foreignKey": "post_id" }],
  "links": [{ "label": "View on site", "href": "/blog/{slug}", "when": { "status": "published" } }]
}
```

It records only what a human decided. Column types, nullability, enum members, which table a foreign key points at — all read from the live catalog at render time, never duplicated, so a definition cannot rot at your next migration. `{ "table": "authors" }` alone is a complete, working screen.

## There is no separate content API

The same route handlers serve the back office and the public site. A visitor fetching published posts and an operator listing orders are the same request against the same resolver, differing only in **who is asking** — and anonymous is an actor with a role and grants of its own. One enforcement path, or two that drift.

What that path enforces, and refuses to get wrong:

- **Grants are role × table × action, with optional row filters** — `customer_id = $actor.customerId` is "your own orders". A claim the actor does not carry denies; a filter that cannot be read refuses the whole grant rather than widening it to every row.
- **A row outside your grant reads as absent**, not forbidden, so ids cannot be enumerated. The *shape* of a table you may not read is a leak too, and is gated.
- **Secret columns are masked end to end** — never selected, never returned, never sortable, filterable or searchable. `select *` does not exist in this codebase.
- **Relation labels, pickers and memberships are reads of the other table** and are gated as such, row scope included.
- **Writes check the request, not just the response.** A cross-site write is refused before any grant is consulted; CORS headers say who may read an answer, not who may send one.
- **Logins do not leak.** A wrong password and an unknown email answer identically, in the same time. Refresh rotation is single-use and atomic; logout revokes by whichever token is live and never pretends.

## The packages

| Package | What it is | Version |
|---|---|---|
| `@allodium/db` | Postgres conventions on Drizzle + node-postgres: pooling, a wire boundary that keeps timestamps and numerics honest, unique-violation classification | 0.2 |
| `@allodium/auth` | First-party auth you own, all factories: argon2id passwords, a session store with atomic refresh rotation and cross-surface scoping, the four auth routes as `Request → Response` handlers, the grant model and its loader, reset tokens, rate limiting, [act as](./docs/act-as.md) | 0.3 |
| `@allodium/storage` | A three-method byte store (local disk now, S3-compatible later) and the headers that stop an upload becoming a script on your origin | 0.2 |
| `@allodium/admin` | The dashboard lane: the view format and its JSON Schema, a resolver that turns a definition plus the caller's grants into SQL, route handlers, uploads, and unstyled React hooks and components you point CSS at | 0.4 |
| `@allodium/from-directus` | Tooling for arriving from an existing CMS: schema puller, data importer with password hashes intact, a compat shim for porting routes one at a time | scaffolding |

Every package is ESM, reads no environment variables, and declares no runtime dependencies — only peers you already have. Releases are published from CI by trusted publishing, with a signed provenance attestation on every tarball linking it to the commit that built it. No publishing token exists anywhere.

## Principles

1. **MIT, forever.** There is no CLA — no one, including us, can ever relicense contributed code out from under you. The version you install is yours for good.
2. **Your database is the config.** Screens, permissions and types are read from the live catalog. No second schema language, no drift between what you wrote and what runs.
3. **One box.** Your Next.js app and your Postgres. No sidecar services to deploy, patch, monitor or license.
4. **Omission means the sensible default, never "off".** A definition that names only a table renders a usable screen; a deployment that forgets to configure something gets the safe branch.
5. **Own it outright.** Everything self-hosts and nothing phones home.

## Where to read next

- **[Getting started](./docs/getting-started.md)** — requirements, the ESM gotcha, a first script, running the console against a seeded database.
- **[@allodium/admin](./packages/admin/README.md)** — the view format, the three rendering layers, the server, the HTTP contract, links and uploads.
- **[@allodium/auth](./packages/auth/README.md)** — sessions, the four routes, grants, act as.
- **[The console's architecture](./apps/console/ARCHITECTURE.md)** — the safety model, required before changing it.

## License

[MIT](./LICENSE) — and that's the whole point.
