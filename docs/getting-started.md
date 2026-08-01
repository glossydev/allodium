# Getting started

Allodium is a set of packages, not a framework. There is no `allodium init`, nothing to
scaffold, and no directory layout you have to adopt. You install the pieces you want and
call them from your own code.

That means the fastest way in depends on what you're after:

- **[Use a package](#1-use-a-package)** — add sessions, or storage, or the admin runtime
  to an app you already have.
- **[Run the developer console](#2-run-the-developer-console)** — the schema/data/roles
  tool. Not on npm yet; you clone the repo.

## Requirements

| | |
|---|---|
| **Node** | 20 or newer |
| **PostgreSQL** | 14 or newer. Any Postgres — local, Docker, RDS, Neon, Supabase. |
| **ESM** | **The packages are ESM-only.** See below; this trips people up. |

### About ESM

Every `@allodium/*` package is ESM-only. There is no CommonJS build.

If your project is CommonJS (which is what `npm init -y` gives you), `require()` fails
with an error that does not explain the real problem:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../node_modules/@allodium/db/package.json
```

That message means "this package has no CommonJS entry point", not "this package is
broken". Fix it by making your project ESM — add this to your `package.json`:

```json
{ "type": "module" }
```

…and use `import` rather than `require`. Next.js, Vite, and most modern setups are
already ESM and need no change.

## 1 · Use a package

```bash
npm install @allodium/db @allodium/auth
```

Peer dependencies (`pg`, `drizzle-orm`, `argon2`) install automatically with npm 7+. They
are peers so that you control the versions and there is never a second copy of the
driver.

### A first script

Save as `try.mjs` (the `.mjs` extension makes it ESM regardless of your package.json):

```js
import { money, numeric, pgTimestamptzToIso } from '@allodium/db';
import { hashPassword, verifyPassword } from '@allodium/auth';
import { diskExtension, INLINE_SAFE_TYPES } from '@allodium/storage';

console.log(money(19.999));                                  // 20
console.log(numeric('45.00'));                               // 45  (NUMERIC arrives as a string)
console.log(pgTimestamptzToIso('2026-01-01 12:00:00+00'));   // 2026-01-01T12:00:00.000Z

const hash = await hashPassword('hunter2');
console.log(await verifyPassword(hash, 'hunter2'));          // true

console.log(diskExtension('image/png', 'photo.PNG'));        // png
console.log(INLINE_SAFE_TYPES.has('image/svg+xml'));         // false — deliberately
```

```bash
node try.mjs
```

No database needed for any of that. When you want one:

```js
import { createDb, singleton } from '@allodium/db';
import * as schema from './schema.js';

export const { db, pool } = singleton('db', () =>
  createDb(schema, { connectionString: process.env.DATABASE_URL })
);
```

Then follow the package you actually came for:

- **[@allodium/db](../packages/db/README.md)** — pool, money, the wire boundary
- **[@allodium/auth](../packages/auth/README.md)** — sessions, passwords, [act as](./act-as.md)
- **[@allodium/storage](../packages/storage/README.md)** — files and safe serving
- **[@allodium/admin](../packages/admin/README.md)** — admin screens from a JSON file

## 2 · Run the developer console

The console is not published yet. Clone the repo:

```bash
git clone https://github.com/glossydev/allodium.git
cd allodium
npm install          # installs workspaces and links the packages
npm run build        # the console imports the packages from dist/
```

### A database to point it at

The console reads and writes a real Postgres. If you have one, skip ahead. If not,
Docker is the shortest path:

```bash
docker run -d --name allodium-dev-pg \
  -e POSTGRES_USER=allodium -e POSTGRES_PASSWORD=localdev -e POSTGRES_DB=allodium_dev \
  -p 5433:5432 postgres:16-alpine
```

Port 5433 keeps it clear of a Postgres you may already run on 5432.

### Sample data (optional, recommended)

The repo ships a fixture designed to exercise every kind of column an admin tool has to
render — enums, uuid and serial keys side by side, jsonb, arrays, self-referencing
foreign keys, nullable relations with real nulls in them, a many-to-many with payload,
and enough rows for pagination to mean anything.

```bash
for f in dev/seed/00*.sql; do
  docker exec -i allodium-dev-pg psql -U allodium -d allodium_dev -v ON_ERROR_STOP=1 < "$f"
done
```

Run them in order; each builds on the last. You get 15 tables: a blog, a small coffee
store, and an identity model with roles and permissions.

### Configure and run

```bash
cd apps/console
cp .env.example .env.local
# edit DATABASE_URL to match your database
npm run dev
```

Open **http://localhost:3180**.

> The console binds `localhost` only, on purpose. It has no authentication in v1, so
> "local only" *is* the security model — and it is enforced, not assumed. It also
> refuses cross-origin writes. Do not expose it; see
> [apps/console/ARCHITECTURE.md](../apps/console/ARCHITECTURE.md).
>
> A consequence worth knowing: `http://127.0.0.1:3180` will **not** answer. Use
> `localhost` or `[::1]`.

### What's in it

| silo | |
|---|---|
| **Schema** | Browse and edit tables — create, alter columns, foreign keys, indexes, enum types. Every change previews its SQL before running. |
| **Content** | Generic CRUD over any table, with filters, sorting, and a relation picker. |
| **Users** | User administration organised by role. |
| **Roles & Permissions** | Roles and a tables × CRUD permission matrix. |
| **Files** | Uploads, with reference tracking so you cannot delete a file still in use. |
| **SQL** | Read-only query console. |
| **Admin Builder** | Build an admin screen for a table and write it to a `.view.json` file. |

## Troubleshooting

**`ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined`** — your project is
CommonJS. Add `"type": "module"` to `package.json`, or use a `.mjs` file. See
[About ESM](#about-esm).

**`ECONNREFUSED` connecting to Postgres** — check the port. The Docker line above uses
**5433**, not the default 5432.

**The console loads but every silo says it cannot reach the database** — `DATABASE_URL`
in `apps/console/.env.local` is wrong or the container is not running
(`docker ps | grep allodium`).

**`http://127.0.0.1:3180` refuses to connect** — expected. The console binds `localhost`
(IPv6 loopback). Use `localhost`.

**Changed a package and the console does not see it** — packages are imported from
`dist/`, so run `npm run build` in the package **and restart the console**. Next caches
the resolved module.

**Pages suddenly 500 with `Cannot find module './901.js'`** — something ran
`next build` while `next dev` was running and overwrote the `.next` directory
underneath it. `npm run build` at the repository root does exactly this, because it
fans out to every workspace including the console. Stop the server, delete
`apps/console/.next`, and start again. Build first, then run — not both at once.

**`npm audit` reports high-severity vulnerabilities in the cloned repo** — and **do not
run `npm audit fix --force`**. It would "fix" them by installing `next@9.3.3`, a
downgrade of six major versions that breaks everything.

The findings are transitive through Next.js (`postcss` and `sharp` inside `next`) and
belong to the console's build tooling, not to anything you ship. There is no patched
Next release for them yet.

A project that installs only the published packages reports **0 vulnerabilities** — they
declare no runtime dependencies at all, only peers you already have.

## License

MIT, no CLA. The software is free forever — that is what the name means.
