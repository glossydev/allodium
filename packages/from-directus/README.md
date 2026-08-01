# @allodium/from-directus

The exit ramp.

> **Status: scaffolding.** This package is a deliberate placeholder — the name is
> reserved and the plan is written, but building it credibly needs a live Directus
> instance to test against, and that is its own piece of work. It is published at 0.0.1
> so nobody else claims the name. **Do not depend on it yet.**

## Why leaving is easier than it looks

Directus stores your content in **plain PostgreSQL tables**. Not a proprietary format,
not a document store — the tables you designed, with the columns you named. Most of what
feels like lock-in is the API shape your application code calls, not the data.

That means a migration is mostly: point Drizzle at the same database, recover the
metadata that lives *outside* the tables, and port your call sites at your own pace.

## What it will do

**`pull`** — wraps `drizzle-kit` against a Directus database, filters the `directus_*`
system tables, then recovers what lives outside your tables: enum choices, relation
metadata and field notes from `directus_fields` and `directus_relations`, folded into the
generated Drizzle schema.

*Audit tip, baked in:* also inventory `/flows`. Production instances hide load-bearing
business logic there, and it is invisible in the schema.

**`adopt-users`** — `directus_users` → your own users table. **argon2 hashes verify
unchanged**, so nobody resets a password. Provider and external-identifier mapping is
preserved for SSO users, and role rows become a documented authorization matrix rather
than a mystery.

**`adopt-files`** — `directus_files` → [@allodium/storage](../storage) with **ids
preserved**, so every file foreign key and every historical URL keeps working.

**`compat`** — a thin `readItems()` / `createItem()`-shaped adapter over your Drizzle
layer. Port a Directus application route by route without rewriting call shapes on day
one, then tighten to typed queries at leisure. The committed filter-operator subset is
already declared in the source.

## The archaeology

This package is being extracted from a real migration, not designed in the abstract. The
source material is the exit plan and cookbook written while moving a production SaaS off
Directus — including the parts that went wrong.

## Want it sooner?

The blocker is a test Directus instance, not the code. If you are migrating and would
trade a sanitized database dump for early access, that is a genuinely good deal for both
of us — open an issue.

## License

MIT. No CLA. The software is free forever; that is what the name means.
