# @allodium/from-directus

The exit ramp. Point it at a Directus database and it hands back, as data you review,
everything the migration playbook asks you to recover by hand: what the fields meant,
who could see which rows, where the files are, and the one transaction that makes the
database yours.

> Companion to **[docs/migrating-from-directus.md](../../docs/migrating-from-directus.md)**,
> the seven-phase playbook from a real exit. The playbook is the method; this package is
> the tooling for phases 1 (inventory), 4 (auth), 5 (files) and 6 (decommission).
> Phases 2 and 3, converting your application's call sites, are yours: there is no
> compatibility shim, on purpose. A shim is a query compiler, and the point of leaving is
> to stop depending on one.

```sh
npm install -D @allodium/from-directus pg
```

## Why leaving is easier than it looks

Directus stores your content in plain PostgreSQL tables: the tables you designed, with the
columns you named. What it keeps *outside* them is the metadata, in `directus_*` system
tables: field notes, enum choices, which interface edited what, the relation graph,
roles, policies, permission filters, flows. Most of the fear of leaving is the fear of
losing that. So that is what this package reads.

## The four steps

Everything is read-only. The outputs are JSON and SQL for you to inspect, commit and run.

```ts
import pg from 'pg';
import { inspect, planViews, planGrants, planDecommission, fileManifest, checkFiles } from '@allodium/from-directus';

const pool = new pg.Pool({ connectionString: process.env.DIRECTUS_DATABASE_URL });

// 1. Inventory — save it; it is the record of what you are leaving.
const inventory = await inspect(pool);
console.log(inventory.warnings);          // active flows, per-user policies, non-local storage, odd hashes…

// 2. Admin screens — one .view.json per collection, plus the notes as schema comments.
const views = planViews(inventory);
for (const v of views.views) await writeFile(v.file, JSON.stringify(v.definition, null, 2));
await writeFile('migration/comments.sql', views.commentsSql);

// 3. Permissions — roles + role_permissions, row filters translated exactly or left out.
const grants = planGrants(inventory);
await writeFile('migration/grants.sql', grants.sql);
console.table(grants.unexpressible);      // each one is a decision for a person

// 4. The cutover — one transaction, run once the container is stopped.
const cutover = planDecommission(inventory);
await writeFile('migration/decommission.sql', cutover.sql);

// Files: copy the uploads directory into your storage root, then prove it.
const manifest = await fileManifest(pool);
const check = await checkFiles(manifest, '/srv/uploads');
console.log(check.present, check.missing.length, check.sizeMismatch.length);
```

### `inspect(db)` → `Inventory`

Merges the Postgres catalog with `directus_fields`, `directus_relations`,
`directus_collections`, the roles/policies/permissions/access tables, flows and
operations, and user and file counts. Every collection carries its fields in Directus
form order with `special`, `interface`, `options` (choices), `note`, `required`,
`hidden`, `readonly`, the SQL type and nullability. Alias fields (m2m, o2m) are kept with
`sqlType: null`. The result is plain JSON: save it, diff it between runs, hand it to a
reviewer or an agent.

`warnings` is the audit list the playbook says to make first: active flows (logic outside
the schema), policies attached to users rather than roles, role inheritance, non-argon2
hashes, files in a non-local storage location, tables Directus never saw.

### `planViews(inventory, options?)` → `ViewsPlan`

One `.view.json` draft per collection, in `@allodium/admin`'s view contract, built from
the decisions someone already made in Directus:

| Directus kept | The draft gets |
|---|---|
| `display_template: "{{title}}"` | `display: "{title}"` |
| `select-dropdown` with choices | `widget: "select"` with `options` (labels kept) |
| `input-rich-text-md`, `tags`, `datetime`, `boolean`… | the matching widget; json behind a tags interface gets `json` |
| m2o relation + `display_options.template` | a `relation` field with its own `display`; `directus_users` → `users`, `directus_files` → `files` with the `file` widget |
| m2m alias + junction relations | an `m2m` field (`through`, `near`, `far`, `farTable`) |
| o2m alias | a `related` list on the owning view |
| `user-created`, `date-updated`… | `readOnly: true` |
| `note` on a field or collection | **a `COMMENT ON`** in `commentsSql`, not a `help` string: the admin reads the column comment, so the note is written once |

Junction tables get no view (their owners' m2m field edits them). Archive settings become
a note, not a hidden filter, so archived rows stay reachable until you decide. Drafts for
`users` and `files` are included so relations to them resolve a display. Every draft
validates against `view.schema.json`; the live test battery checks that.

### `planGrants(inventory, options?)` → `GrantsPlan`

Directus attaches policies to roles, each permission carrying its own filter per action.
Allodium has one row per role × table with four flags and **one** row filter, checked on
every read and after every write. Translating between them is exact or it does not
happen:

- a role's policies are unioned, as Directus does at request time;
- an unfiltered permission beats a filtered one for the same action;
- two different filters for one table × action is an OR, which cannot be stated: the grant
  is **left out** and listed in `unexpressible`;
- when actions on one table carry different filters, the grant takes the read filter and
  refuses the others rather than widen them;
- `$CURRENT_USER` becomes `$actor.userId`; `{ author: { user: { _eq } } }` becomes the FK
  path `author.user`, which the grant loader walks; `_or`, `_nin`, `_ncontains`,
  `_between`, `$NOW`, `$CURRENT_ROLE` are refused with the path of the clause.

A role with `admin_access` bypassed permissions entirely, so it gets no rows and a note:
map its users onto your console-lane role. The `sql` is idempotent (`insert … on conflict`)
and ends with the refused permissions as comments, so the file itself is the review list.

### `planDecommission(inventory, options?)` → `DecommissionPlan`

Phase 6 as SQL: one transaction that refuses to run twice, then

1. `directus_users` → `users`: `password` → `password_hash` (**argon2id verifies unchanged
   with `@allodium/auth`**, so nobody resets anything), `tfa_secret` → `mfa_secret`,
   `display_name` built from the names, statuses mapped onto the `user_status` enum,
   `provider` and `external_identifier` kept for the `/oidc` entry point, fifteen
   Studio-only columns dropped;
2. `directus_roles` → `roles` with a `key` slug and a `public` row; `directus_users.role`
   → `user_roles`; an empty `role_permissions` for the grants plan to fill;
3. `directus_files` → `files` with `@allodium/storage`'s column names and **ids
   preserved**, so every FK and every stored URL keeps resolving;
4. every remaining `directus_*` table dropped **explicitly, children first**, in an order
   taken from the FK graph the inventory recorded (no `CASCADE` anywhere);
5. a final check that nothing named `directus_*` remains.

`keepAuditTables: true` keeps `directus_activity` and `directus_revisions` as
`archive_*` instead. Foreign keys from your tables to users and files follow the renames
on their own; Postgres rewrites the constraint.

### `fileManifest(db)` and `checkFiles(manifest, root)`

Directus wrote each upload to `<uploads>/<filename_disk>`; the disk driver reads
`<root>/<disk_name>`, and the cutover keeps the value. Copying the directory is the
migration; `checkFiles` proves it: present, missing, size mismatch (a truncated copy), and
rows with no disk name at all.

## What it refuses to do

- **Run anything.** It never writes to the database or the disk. You run the SQL after a
  snapshot, with the container stopped.
- **Approximate a permission.** A filter that cannot be stated exactly is omitted and
  reported. Fail closed is the only safe default for a grant.
- **Shim the API.** Convert your call sites to typed queries; the playbook's idiom map is
  the guide.
- **Guess a widget it cannot justify.** A field the map does not cover gets no `widget`
  and the admin defaults it from the SQL type.

## Running the live battery

`npm test` runs the pure filter battery everywhere and the live battery only when
`DIRECTUS_DATABASE_URL` is set. The live battery inspects a real Directus 11, validates
every draft against the admin's schema, verifies an argon2 hash through `@allodium/auth`,
and runs the generated cutover and grants SQL inside a transaction it rolls back. CI does
this on every push; locally, against the dev Postgres from `docs/getting-started.md`:

```sh
docker exec allodium-dev-pg psql -U allodium -d postgres -c 'create database directus_test'
docker run -d --name directus-test -p 8055:8055 \
  -e KEY=test-key-0123456789 -e SECRET=test-secret-0123456789abcdef \
  -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASSWORD=adminpassword \
  -e DB_CLIENT=pg -e DB_HOST=host.docker.internal -e DB_PORT=5433 \
  -e DB_DATABASE=directus_test -e DB_USER=allodium -e DB_PASSWORD=localdev \
  directus/directus:11
node test/fixture.mjs                       # waits for health, then builds the fixture
DIRECTUS_DATABASE_URL=postgresql://allodium:localdev@localhost:5433/directus_test npm test
```

## License

MIT. No CLA. The software is free forever; that is what the name means.
