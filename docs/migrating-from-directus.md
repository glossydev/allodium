# Migrating from Directus

The playbook for moving an application off Directus and onto Allodium, in the order that
worked for real. It was written during ChapterHub's exit (July 2026: ~110 files touching
the SDK, 29 tables, three login modes, file serving, a billing integration) and generalised
afterwards. Nothing here is theory; every rule below was a bug first.

Directus keeps your data in plain Postgres tables, which is what makes leaving tractable:
the database stays, the application keeps running, and the platform is removed one layer at
a time with the old one still live until the last step.

## The shape of it

Seven phases, each shippable on its own, each verified before the next. Directus keeps
running until the second-to-last one. Nothing is renamed in the database until the end.

| Phase | What changes | Verified by |
|---|---|---|
| **0 · Freeze and back up** | Pin the Directus image by digest. Take a full dump plus the uploads directory, and **restore-test it** into a local Postgres — that restored copy becomes your development database. Put a nightly backup on a timer; there is almost certainly none. | A restore that boots the app locally |
| **1 · Schema as code** | Pull the schema into Drizzle (`drizzle-kit pull`), filtering out `directus_*` system tables. Commit it. Point local development at the restored copy. | The pulled schema diffs clean against the live database |
| **2 · Data layer and one exemplar** | A pool on `@allodium/db`, one query module for one domain, one route converted end to end. Write down the idiom map (below) as you go. | The exemplar passes the route's existing smoke test with byte-identical JSON |
| **3 · The route sweep** | Convert the rest in vertical slices, carving out credential writes (signup, password set, invites, reset) — those stay on Directus until phase 4 or new users could not sign in. Delete the object-or-id defences per converted slice. Port any Directus Flows into the code path they decorated. | Per slice: smoke + build + **negative-authorization probes** (user A cannot read tenant B) |
| **4 · Auth cutover** | Sessions, login, refresh, logout, reset and SSO on `@allodium/auth`, behind a flag so both systems run at once. Password hashes port unchanged (Directus uses argon2id); a **session bridge** exchanges live Directus cookies for first-party sessions so nobody is logged out. Register your new OAuth redirect URI *before* the flip. | Every login mode and the bridge, verified with the flag off, then on |
| **5 · Files** | Copy the uploads directory into your storage root; serve through your own route with the safe headers; re-point upload routes and URL sites. Keep the `directus_files` name until phase 6 so the old `/assets` keeps working meanwhile. | Every stored file id resolves; gated files require auth; an SVG serves as an attachment |
| **6 · Decommission** | Stop the container. In **one transaction**: rename `directus_users`, `directus_files`, `directus_roles` to your names, drop the columns only Directus used, drop every remaining `directus_*` table — explicitly, never with a blind `CASCADE`. Remove the SDK and the scripts. Close the ports. | The full smoke suite with the container gone; a restore drill on the final pre-phase snapshot |
| **7 · Mothball rehearsal** | Run production with the container *stopped* but still on disk for an observation window before destroying anything. Reversible in one command. | Logs clean of the old port for the window |

Phases 1–3 carry near-zero user-facing risk: same database, same responses, verified per
slice. Phase 4 is where the risk concentrates, which is why it gets a flag, a bridge and a
snapshot immediately before. Phases 6 and 7 can be swapped — rehearse the mothball first if
you want the safety blanket longer.

## The iron rules

1. **The wire shape is the contract.** A converted route returns byte-identical JSON to what
   it returned before: same field names (snake_case), same nesting, same types. Drizzle's
   camelCase properties are mapped back by the query module; routes never see them.
2. **One query module per domain.** Routes call typed functions. No inline `select` in a
   route handler.
3. **Relations come back as typed nested objects, always** — never the object-or-id
   ambiguity. When a converted route no longer needs an `idOf()` defence, delete it, in that
   route only.
4. **Credential writes stay on Directus until the auth cutover.** Reads and profile-field
   writes of users may convert earlier.
5. **Every slice gets negative-authorization tests.** Directus role enforcement no longer
   applies on converted paths; your query module's scoping is now the enforcement, and a
   smoke test proving a feature works does not prove isolation still holds.
6. **Multi-write sequences get a transaction.** Read-then-create idempotency checks become
   unique constraints plus upserts.
7. **Do not hand-edit the pulled schema casually.** Sequences that look like cruft
   (`directus*IdSeq`) must stay until phase 6 or the next generate emits a `DROP SEQUENCE`
   against live tables.

## The idiom map

| Directus (SDK or REST) | Drizzle |
|---|---|
| `readItems('t', { filter: { a: { _eq: v } } })` | `db.select().from(t).where(eq(t.a, v))` |
| `_neq / _gt / _gte / _lt / _lte` | `ne / gt / gte / lt / lte` |
| `_in: [..]` | `inArray(t.a, [..])` |
| `_null: true` / `_nnull: true` | `isNull(t.a)` / `isNotNull(t.a)` |
| `_between: [x, y]` | `between(t.a, x, y)` |
| `_and: [...]` / `_or: [...]` (and sibling keys, which imply AND) | `and(...)` / `or(...)` |
| `sort: ['-date', 'id']` | `orderBy(desc(t.date), asc(t.id))` |
| `limit: -1` | omit `.limit()` |
| `limit: 1` + `rows?.[0]` | `.limit(1)` + `rows[0] ?? null` |
| `fields: ['a', 'b']` | `db.select({ a: t.a, b: t.b })` — exactly the wire fields |
| dot expansion `fields: ['user_id.first_name']` | an explicit `leftJoin` and a nested object in the mapper — **always include the id** |
| `aggregate({ count: '*' })` / `meta=filter_count` | `db.select({ n: count() })` |
| `createItem` / `updateItem` / `deleteItem` | `insert(...).values(...).returning()` / `update(...).set(...).where(...).returning()` / `delete(...).where(...)` |
| `errors[0].message` parsing | query modules throw a plain `Error`; routes keep their existing catch |
| `cache: 'no-store'` | nothing — a query is never cached |

## Gotchas that each cost a day

- **NUMERIC arrives as a string** from the driver. Map with `numeric()` from `@allodium/db`
  and match what the route emitted before — some routes sent the string, some a number.
- **Timestamps.** `date` columns arrive as `YYYY-MM-DD` strings, as before. `timestamp`
  columns arrive as `Date` objects where Directus sent ISO strings; mappers convert. The
  admin runtime already selects DATE columns as text for exactly this reason.
- **Id comparisons as strings** (`String(a) === String(b)`) keep working during the sweep;
  simplify after.
- **Enum casing drift** in old rows (`published` beside `Published`) — preserve any existing
  double-query defence when converting, then fix the data.
- **The users table** was filtered out of the pull along with the system tables. For reads
  before the cutover, declare a minimal table object by hand outside the generated schema,
  or postpone those reads to phase 4.
- **Foreign-key cycles break TypeScript inference** on a pulled schema (TS7022). Casts do
  not sever the cycle; annotate the cyclic tables' extras callbacks `(table): any[] =>`.
- **Flows hide logic.** Audit the Flows list before the sweep; one of them is usually
  load-bearing (ChapterHub's issued the invoice email) and has to move into code with the
  route it decorated.
- **Build clean on deploy.** An incremental build cache once shipped a silently broken
  bundle during the cutover. The deploy script should start from nothing.

## The auth cutover, specifically

- **Hashes port unchanged.** Directus stores argon2id, which `verifyPassword` accepts as is.
  Audit the hash prefixes anyway; nobody is forced to reset a password.
- **Run both systems behind a flag.** Converted routes resolve identity through the same
  users rows either way, so the sweep can finish before the flip.
- **Bridge live sessions.** Middleware that sees the legacy cookies exchanges them once
  through the still-running `/auth/refresh`, mints a first-party session, clears the old
  cookies. Beta users never notice.
- **Register the new SSO redirect URI before flipping**, and verify `@allodium/auth/oidc`
  against the provider with the flag off. In-flight reset links die at the flip; say so in
  the release note.
- **Rate limiting arrives here** — Directus's limiter was probably never enabled, so
  per-email and per-IP throttles on login and reset are a strict upgrade.
- **Keep the old cookie names** if you like; the session store does not care. Rename them
  once nothing legacy is left.

## The decommission transaction

The shape that worked, applied to the local copy first and to production immediately
before deploying the code that uses the new names:

```sql
begin;

alter table directus_users rename to users;
alter table directus_files rename to files;
alter table directus_roles rename to roles;         -- kept: the app still joins role names

alter table users
  drop column if exists token, drop column if exists tfa_secret, drop column if exists auth_data,
  drop column if exists last_page, drop column if exists language, drop column if exists appearance,
  drop column if exists theme_dark, drop column if exists theme_light,
  drop column if exists theme_light_overrides, drop column if exists theme_dark_overrides,
  drop column if exists text_direction, drop column if exists tags, drop column if exists avatar,
  drop column if exists email_notifications;
alter table roles drop column if exists icon, drop column if exists description, drop column if exists parent;
alter table files drop column if exists folder, drop column if exists tus_id, drop column if exists tus_data,
  drop column if exists focal_point_x, drop column if exists focal_point_y;

-- Guard: nothing outside directus_* may still reference anything inside it.
-- Then drop the directus_* tables in dependency order, one pass at a time,
-- letting a still-referenced table fail quietly and succeed on a later pass.
-- No CASCADE anywhere: a blind cascade is how you lose a table you meant to keep.
do $$
declare bad int; remaining int; t record; pass int := 0;
begin
  select count(*) into bad from pg_constraint c
    join pg_class child on c.conrelid = child.oid join pg_class parent on c.confrelid = parent.oid
    join pg_namespace n on child.relnamespace = n.oid
   where c.contype = 'f' and n.nspname = 'public'
     and parent.relname like 'directus\_%' and child.relname not like 'directus\_%';
  if bad > 0 then raise exception 'app tables still reference directus_* (% FKs)', bad; end if;
  loop
    pass := pass + 1; remaining := 0;
    for t in select tablename from pg_tables where schemaname = 'public' and tablename like 'directus\_%' loop
      begin execute format('drop table %I', t.tablename);
      exception when dependent_objects_still_exist then remaining := remaining + 1; end;
    end loop;
    exit when remaining = 0;
    if pass > 10 then raise exception '% directus_* tables could not be dropped', remaining; end if;
  end loop;
end $$;

commit;
```

Prerequisites: a final snapshot, any enum choices that lived in `directus_fields` moved into
code, and the container stopped — it cannot run against the renamed schema, which is what
closes the resurrection window.

## What Allodium gives you at each step

- **Phase 2:** `@allodium/db` — the pool, `money`/`numeric`, timestamp normalisers,
  `isUniqueViolation`.
- **Phase 4:** `@allodium/auth` — passwords, the session store, the four routes, the grant
  model with row filters (your old permissions matrix maps onto `role_permissions`), and
  the optional `/reset`, `/oidc` and `/passkeys` entry points.
- **Phase 5:** `@allodium/storage` — the disk driver and `assetContentHeaders`; and
  `@allodium/admin`'s `_files` routes if you mount the admin runtime.
- **Phase 5.5, optional:** the developer console over your schema, and the admin runtime
  for the screens your team used Studio for. ChapterHub kept a Studio-equivalent console
  running before it decommissioned, and so should you.

- **Phases 1, 4, 5 and 6:** [`@allodium/from-directus`](../packages/from-directus/README.md)
  — `inspect` is the inventory (fields with their notes and choices, relations, roles and
  permission filters, flows, user and file counts, and the warnings list); `planViews`
  drafts the admin screens from the metadata; `planGrants` translates permissions into
  `role_permissions` exactly or leaves them out and says why; `planDecommission` generates
  the transaction above from the live schema, with the drops ordered from the real FK graph;
  `fileManifest`/`checkFiles` prove the uploads copy. Everything it produces is JSON or SQL
  you review; it runs nothing. Phases 2 and 3 stay yours by design.
