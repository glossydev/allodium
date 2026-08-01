# Allodium documentation

**[Getting started](./getting-started.md)** — requirements, installing a package, and
running the developer console against a database. Start here.

## Guides

- **[The developer console](./console/index.html)** — all seven silos, with screenshots,
  the safety model and troubleshooting. Self-contained HTML; open it in a browser.
- **[Act as](./act-as.md)** — the user switcher. Resolve the whole application as
  another user for testing and support, without replacing your session.

> The console page is **generated**. `scripts/console-screenshots.mjs` drives a real
> browser against a running console to capture the screenshots, and
> `scripts/build-console-docs.mjs` inlines them and emits the HTML — so the images
> regenerate with the UI instead of rotting. Run the console, then both scripts.

## Package reference

Each package documents its own API and, more usefully, why its decisions were made:

- **[@allodium/db](../packages/db/README.md)** — pool, money, and a wire boundary that
  doesn't corrupt timestamps
- **[@allodium/auth](../packages/auth/README.md)** — sessions, argon2id passwords, reset
  tokens, rate limiting, user switching
- **[@allodium/storage](../packages/storage/README.md)** — a three-method byte store and
  the headers that stop an upload becoming an XSS
- **[@allodium/admin](../packages/admin/README.md)** — admin screens from a small JSON
  file, rendered by unstyled components
- **[@allodium/from-directus](../packages/from-directus/README.md)** — the exit ramp
  (scaffolding)

## The developer console

- **[Architecture](../apps/console/ARCHITECTURE.md)** — the safety model, silo
  ownership, and the conventions worth knowing before changing it. Required reading
  before touching the console.

## Still to write

Honest list, so nobody hunts for something that isn't here:

- A console tour, silo by silo, with screenshots
- View definitions reference — every field of the admin view format
- Styling the generated admin — the full data-attribute contract
- Deploying: what a production dashboard looks like
- Migrating an existing Directus project, once `from-directus` is real
