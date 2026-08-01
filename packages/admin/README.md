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

> **Status.** The view runtime described below lands in **0.2.0**. Published 0.1.0
> contains only `createTableRegistry`. The format is settling — pin exactly if you adopt
> it early.

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

## The server

Framework-free: it takes anything with a pg-shaped `query` method, so it works with a
`Pool`, a `Client`, or a proxy, under any HTTP framework.

```ts
import { createViewResolver } from '@allodium/admin/server';

const resolver = createViewResolver(pool);

await resolver.resolve(def);            // definition + live catalog → a full screen spec
await resolver.list(def, { page: 1 });  // rows, with relation labels already joined
await resolver.read(def, id);           // one record, m2m members included
await resolver.update(def, id, values); // columns + m2m set reconciliation
```

Relation labels resolve in the **same query** as the rows, so a list does not become one
query per row per relation.

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
