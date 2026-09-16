# @allodium/admin

Admin screens described by a small JSON file, rendered by unstyled components you point
CSS at.

Two lanes: a **developer console** for building the site, and an **admin dashboard** for
running it — where the console generates the dashboard. This package is the dashboard
half plus the metadata both lanes read.

```bash
npm install @allodium/admin
npm install react          # peer, only for the /react entry
```

Requires Node 20+ and PostgreSQL.

> **Status.** Everything below is the **0.2.x** line. Published 0.1.0 contained only
> `createTableRegistry`. The format is settling — pin exactly if you adopt it early.

### Next.js: transpile this package, externalize the rest

The `/react` entry is client components. Next must compile them with **your** copy of
React, or the server render throws `Invalid hook call` while the browser quietly
recovers — tests that only look at the hydrated page pass, and the server logs fill up.

```ts
// next.config.ts
export default {
  transpilePackages: ['@allodium/admin'],
  serverExternalPackages: ['pg', 'argon2', '@allodium/db', '@allodium/auth', '@allodium/storage'],
};
```

The others carry native or Node-only code and must stay external. Putting
`@allodium/admin` in that list works under npm's hoisting and breaks under pnpm's, which
is the kind of difference that surfaces only on the second machine.

## The idea

A view definition is a JSON file **in your repo**, committed and reviewed like code:

```json
{
  "table": "posts",
  "title": "Blog posts",
  "fields": [
    { "column": "title", "label": "Headline", "help": "Shown in search results." },
    { "kind": "relation", "column": "author_id",
      "relation": { "table": "authors", "display": "name" } },
    { "kind": "m2m", "through": "post_tags", "near": "post_id",
      "far": "tag_id", "farTable": "tags", "display": "label" }
  ]
}
```

It carries **only what a human decided**. Column types, nullability, enum members, which
table a foreign key points at — all read from the live database at render time and never
duplicated here, because a definition that restated the schema would rot at your next
migration.

Omission means *sensible default*, never *off*. This is a complete, working screen:

```json
{ "table": "authors" }
```

**Why files and not database rows:** config in the database cannot be diffed, cannot be
reviewed in a pull request, and drifts between environments. Schema changes are code;
screens are too.

## Rendering

Three layers. Enter wherever a screen needs you to.

### Layer 1 — the definition

Written by hand or by the Allodium console's Admin Builder.

### Layer 2 — headless hooks

All data and behavior, no markup at all.

```tsx
import { useAdminForm } from '@allodium/admin/react';

const { fields, values, setValue, save, problems, dirty, optionsFor } =
  useAdminForm({ baseUrl: '/api/admin', view: 'posts', id });
```

Fetching, pagination, search, dirty tracking, validation, relation options, save and
delete. Render whatever you like.

### Layer 3 — unstyled components

Correct, accessible markup with **zero visual opinion** — no colours, no spacing, not one
class of our own.

```tsx
import { AdminForm, AdminList } from '@allodium/admin/react';

<AdminList config={{ baseUrl: '/api/admin', view: 'posts' }} onSelect={open} />
<AdminForm config={{ baseUrl: '/api/admin', view: 'posts' }} id={id} />
```

The entire styling contract is data attributes:

```css
[data-allodium="field"]      /* one field wrapper        */
[data-field="title"]         /* that wrapper, by column  */
[data-widget="select"]       /* that wrapper, by input   */
[data-required] [data-invalid]
```

No theme prop, no class-name API, nothing to learn beyond the attribute names. When one
screen needs to be genuinely different, drop it to the hooks — same data, same behavior,
your markup.

Labels are tied to inputs, help text is wired through `aria-describedby`, and errors use
`aria-invalid`. A generated admin that fails a screen reader would be worse than
hand-written HTML.

### Links out of the admin

A screen that edits published content needs a way to the published thing, and only your
app knows the address. So a view carries URL templates over the row, and a condition:

```json
"links": [
  { "label": "View on site", "href": "/blog/{slug}", "target": "_blank",
    "when": [{ "column": "status", "value": "published" }] },
  { "label": "Preview", "href": "/preview/posts/{id}", "in": ["form"] }
]
```

`AdminList` renders them in a trailing cell that does not open the row; `AdminForm`
renders them under the heading, for saved records only. Values are URL-encoded as they
are substituted, a row whose placeholder is empty gets no link, and the template must be
a path or an absolute http(s) URL — a definition cannot put `javascript:` on an
operator's screen. `when` is the same predicate shape as every other filter, so "one
table, two public routes" is two links with opposite conditions:

```json
{ "label": "View", "href": "/portfolio/{slug}", "when": { "kind": "professional" } },
{ "label": "View", "href": "/playground/{slug}", "when": { "kind": "playground" } }
```

Style them through `[data-allodium="link"]`, `[data-allodium="links"]` and
`[data-allodium="links-header"]`.

## The server

Framework-free: it takes anything with a pg-shaped `query` method, so it works with a
`Pool`, a `Client`, or a proxy, under any HTTP framework.

```ts
import { createViewResolver, createFileViewStore, createAdminRoutes } from '@allodium/admin/server';

// Who may do what is REQUIRED. Pass a policy from @allodium/auth's grant loader,
// or the explicit 'unrestricted' for a caller that is already the trust boundary.
const resolver = createViewResolver(pool, { access: policy });

await resolver.resolve(def);                    // definition + live catalog → a full screen spec
await resolver.list(def, { page: 1, actor });   // rows, with relation labels already joined
await resolver.read(def, id, actor);            // one record, m2m members included; null outside the grant
await resolver.create(def, values, actor);
await resolver.update(def, id, values, actor);  // columns + m2m set reconciliation
await resolver.remove(def, id, actor);
await resolver.options(def, 'author_id', { search, actor });  // a relation picker's choices
```

Every call takes the **actor** — `{ userId, roles, claims }`, or the public actor for
nobody — and the grant decides what comes back. A refusal throws (`Not permitted: …`);
a row outside a grant reads as `null`, the same as a row that does not exist, so ids
cannot be enumerated. Relation labels and picker options are reads of the *other*
table and are gated as such, row scope included: an operator who may see only their own
customer is not shown every customer's name down an orders list.

Relation labels resolve in the **same query** as the rows, so a list does not become one
query per row per relation.

### Over HTTP

```ts
const views = createFileViewStore({ dir: 'admin/views' });   // reads *.view.json, live
const routes = createAdminRoutes({
  resolver,
  views,
  actorFor: async (request) => /* resolve the session cookie, or PUBLIC_ACTOR */,
  allowOrigins: ['https://admin.example.com'],               // omit for same-origin
  onWrite: (e) => audit(e),                                  // every create/update/delete
});

// Next.js: app/api/admin/[...path]/route.ts
const handler = (req, { params }) => routes.handle(req, params.path);
export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE, handler as OPTIONS };
```

The URL contract `@allodium/admin/react` speaks, relative to the mount point:

| | |
|---|---|
| `GET <view>/view` | the resolved screen spec — gated as a read, because a table's shape is a leak |
| `GET <view>/list?page=&pageSize=&search=&sort=&direction=&filter=col:op:value&scope=…` | rows |
| `GET <view>/record/<id>` | one row, or 404 |
| `POST <view>/record` | create, 201 |
| `PATCH <view>/record/<id>` | update (`PUT` accepted) |
| `DELETE <view>/record/<id>` | |
| `GET <view>/options/<field>?search=` | a picker's choices |

`<view>` is a `.view.json` name, or a table name when no such file exists — a granted
table with no curated screen renders its implicit one. Refusals map to 403, a row
outside a grant to 404, a bad filter to 400, a constraint violation to 400 with
Postgres's own detail. Writes from an origin that is neither this host nor allowlisted,
or with a body not typed as JSON, are refused before anything else runs — CORS headers
say who may read a response, not who may send a request, and the difference is a
cross-site request forgery.

There is no separate content API. A public site mounts the same routes and the public
actor gets what its role was granted — published posts, approved comments — through the
one enforcement path.

### Files

Uploads are a relation to a files table, edited by uploading. Give the routes a byte
store and the serving headers from `@allodium/storage`:

```ts
import { createLocalDiskDriver, assetContentHeaders, diskExtension } from '@allodium/storage';

createAdminRoutes({
  …,
  uploads: {
    driver: createLocalDiskDriver({ root: () => process.env.UPLOADS_DIR! }),
    serve: assetContentHeaders,   // the stored-XSS policy lives there, not here
    extension: diskExtension,
    maxBytes: 20 * 1024 * 1024,   // default 10 MiB, enforced on the stream
    accept: ['image/*', 'application/pdf'],
  },
});
```

That adds three endpoints under the reserved name `_files`:

| | |
|---|---|
| `POST _files` | multipart with a `file` field (and optional `title`), or a raw body with an `X-Filename` header — gated as a **create** on the files table; 201 with the row |
| `GET _files/<id>` | the bytes, with `Content-Type`, `nosniff`, an inline-or-attachment disposition, and a cache policy — gated as a **read** of the row, so a file the actor may not see is a 404; `?download` forces an attachment |
| `DELETE _files/<id>` | the row and the bytes |

A raster image is checked against its own first bytes, since the browser will render it
inline; a "png" that is not one is a 415. The files table is the shape the console's
Files silo uses (`disk_name`, `filename`, `mime_type`, `filesize_bytes`, `title`);
`table` and `columns` rename it.

On the form, a relation field with `"widget": "file"` shows the current filename, an
upload control and Remove; the upload's row id becomes the field's value, and the record
saves a foreign key exactly as it would from a picker. `uploadFile(config, file)` from
`/react` is the same call for a custom form. Serve a cover image on the public site from
the same mount: `<img src="/api/content/_files/{cover_image_id}">`, with the public
granted read on `files`.

### Many-to-many

Detected as **a composite primary key whose columns are all foreign keys** — not "a table
with two foreign keys", which misreads a join table carrying extra columns
(`granted_at`, `granted_by`, `sort_order`). Writes reconcile to exactly the submitted
set: delete what is gone, insert what is new, leave untouched rows alone so join-table
payload survives an edit.

### Help text comes from your schema

`COMMENT ON COLUMN` becomes a field's default help text; `COMMENT ON TABLE` becomes a
view's description. Describe a column once, in the schema, and every screen showing it
inherits that — no second copy to keep in sync.

## Warnings, not silence

A definition that resolves but would render something useless — a select with no
options, a list column that is not a field — comes back with warnings attached. "The
dropdown is empty and I don't know why" is the failure mode this project exists to
avoid.

## Also here: the Drizzle table registry

```ts
import { createTableRegistry } from '@allodium/admin';

const registry = createTableRegistry({
  schema: appSchema,
  maskedColumns: { users: ['password'], sessions: ['access_hash', 'refresh_hash'] },
});
```

Runtime metadata from your Drizzle schema — names, SQL types, primary keys, the foreign
key graph — with secret columns masked end to end: never selected, never editable, never
on the wire. Masking is the one piece of judgment a deployment must supply.

## License

MIT. No CLA.
