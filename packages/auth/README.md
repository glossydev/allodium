# @allodium/auth

First-party authentication you own outright. Sessions, passwords, reset tokens, rate
limiting, and a user switcher — extracted from a production SaaS, not written for a
demo.

Every export is a **factory taking explicit config**. The package reads no environment
variables and imports no framework, so your app binds names, secrets and tables once
and re-exports. That is what makes it usable from a Next.js route handler, an Express
middleware, or a script.

```bash
npm install @allodium/auth
# peers, which you almost certainly already have:
npm install argon2 pg drizzle-orm
```

Requires Node 20+ and PostgreSQL.

## What's in it

| | |
|---|---|
| **Passwords** | `hashPassword` / `verifyPassword` — argon2id, with a dummy hash for timing equalization so "no such user" and "wrong password" cost the same. |
| **Sessions** | `createSessionStore` — opaque tokens, sha256 at rest, single-use refresh rotation that is atomic under concurrency, sliding expiry, cross-surface origin scoping. |
| **Cookies** | `createSessionCookies` — the access/refresh/CSRF triple, with Domain-correct clearing (the bug where a cookie "won't delete" is almost always this). |
| **Reset tokens** | `createResetTokens` — stateless HMAC, keyed partly on the user's *current* password hash, so a successful reset invalidates every outstanding token with no bookkeeping. |
| **Rate limiting** | `createRateLimiter` — sliding window, in-process, fail-open. |
| **[Act as](../../docs/act-as.md)** | `createActAs` — resolve the app as another user for testing and support, without replacing your session. |

## Sessions in one screen

```ts
import { createSessionStore, createSessionCookies } from '@allodium/auth';

export const sessions = createSessionStore({
  db,                       // your Drizzle instance
  table: sessionsTable,     // your sessions table
  users: usersTable,
  isUserActive: (u) => u.status === 'active',
});

const minted = await sessions.mint(user.id, { origin: 'web' });
const who = await sessions.resolve(accessToken, { origin: { equals: 'web' } });
const next = await sessions.refresh(refreshToken);   // single-use; races have one winner
```

The refresh rotation consumes the old token in the same statement that issues the new
one, so two tabs refreshing simultaneously produce exactly one winner rather than two
valid sessions or zero.

## Act as (user switching)

A superadmin resolves the whole application as somebody else — one bar, no logging out.
Read [docs/act-as.md](../../docs/act-as.md) before wiring it; the security model has
five properties and they are load-bearing.

```ts
export const actAs = createActAs({
  secret: () => process.env.AUTH_SECRET!,
  enabled: () => process.env.ACT_AS_ENABLED,      // unset: on in dev, off in prod
  isDevelopment: () => process.env.NODE_ENV !== 'production',
  canActAs: (u) => u.role === 'super_admin',
  loadUser: (id) => findUser(id),
  userId: (u) => u.id,
});

// Hook the ONE function your app reads identity from:
export async function getCurrentUser() {
  const real = await sessions.resolve(accessToken);
  return (await actAs.resolve(real, ticketCookie)).user;
}
```

Defaults lean safe: off in production, staff cannot be impersonated, and the ticket
expires in 8 hours.

## Design notes

**Factories, not singletons.** Nothing here reads `process.env`. Where a value is
env-driven, pass a thunk (`() => process.env.X`) so it keeps call-time semantics rather
than being captured at import.

**Peer dependencies.** `argon2`, `pg` and `drizzle-orm` are peers, never bundled — you
control the versions, and there is no chance of two copies of the driver.

**Directus-compatible hashes.** `verifyPassword` accepts hashes written by Directus, so
a migration off it needs zero forced password resets. That compatibility is deliberate
and tested.

## Testing

```bash
node packages/auth/test/integration.mjs   # 36 checks, needs DATABASE_URL
node packages/auth/test/act-as.mjs        # 42 checks, no database needed
```

The integration battery runs against a real PostgreSQL because that is where the
semantics live — an atomic rotation that works against a mock proves nothing.

## License

MIT. No CLA. The software is free forever; that is what the name means.
