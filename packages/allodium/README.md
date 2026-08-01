# allodium

**Allodial title for your stack** — a sovereign, MIT-licensed headless-CMS toolkit for
Next.js and PostgreSQL.

> **Status: name reservation.** This package will become the Allodium CLI. The toolkit
> itself lives in the `@allodium/*` scope and is usable today — start there.

## The toolkit

| package | what it is |
|---|---|
| [`@allodium/db`](https://www.npmjs.com/package/@allodium/db) | Pool, money, and a wire boundary that doesn't corrupt timestamps. |
| [`@allodium/auth`](https://www.npmjs.com/package/@allodium/auth) | Sessions, argon2id passwords, reset tokens, rate limiting, user switching. |
| [`@allodium/storage`](https://www.npmjs.com/package/@allodium/storage) | A three-method byte store and headers that stop an upload becoming an XSS. |
| [`@allodium/admin`](https://www.npmjs.com/package/@allodium/admin) | Admin screens from a small JSON file, rendered by unstyled components. |
| [`@allodium/from-directus`](https://www.npmjs.com/package/@allodium/from-directus) | The exit ramp. Scaffolding. |

Each is independently useful. Take the session store and nothing else if that is all you
need.

## What the name means

Allodial title is land held outright — owned absolutely, owing rent or service to no
one. That is the whole promise:

- **MIT, no CLA.** You own your copy outright. Nobody can change the terms under you.
- **No tiers, no seats, no feature gates.** There is no paid version withholding the
  good parts.
- **One box.** Postgres and Node. No required service, no phone-home, no account.

The software is free forever. If services grow around it — support, hosting,
done-for-you work — those pay the rent. Never the license.

## Two lanes

Most CMS admin panels force two very different people to share one interface: the
developer building the site, and the person running it. Serving both badly is why they
end up tedious for one and confusing for the other.

Allodium splits them, and lets one build the other:

- **The developer console** — lean and fast. Scaffold and edit schema, browse and edit
  data, manage roles and permissions, run read-only SQL. Detached from the site, with
  its own auth.
- **The admin dashboard** — generated *from* the console. Friendly, guided screens for
  the people who actually run the business: marketing writing posts, support handling
  orders, admins granting permissions.

The console builds the dashboard. That is the mechanic the whole design is arranged
around.

## Coming here

The CLI: scaffold a project, run migrations, generate admin views, and drive the
`from-directus` migration steps from one command.

## License

MIT. No CLA.
