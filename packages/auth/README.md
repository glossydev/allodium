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
| **Routes** | `createAuthRoutes` — login, logout, refresh and me as Web `Request → Response` handlers, with the details that are easy to get wrong already right. |
| **Grants** | `createAccessPolicy` / `createGrantLoader` — role × table × action, with optional row filters (`customer_id = $actor.customerId`). What `@allodium/admin` enforces. |
| **[Act as](../../docs/act-as.md)** | `createActAs` — resolve the app as another user for testing and support, without replacing your session. |

## Sessions in one screen

```ts
import { createSessionStore, createSessionCookies } from '@allodium/auth';

export const sessions = createSessionStore({
  db,                       // your Drizzle instance
  sessions: sessionsTable,  // your sessions table — the shape is in sessions.ts
  users: usersTable,
  accessPrefix: 'app_at_',  // how these tokens are recognised; unique to your app
  refreshPrefix: 'app_rt_',
  isUserActive: (u) => u.status === 'active',
});

const minted = await sessions.mint({ userId: user.id, origin: 'web' });
const who = await sessions.resolveUser(accessToken, { origin: { equals: 'web' } });
const next = await sessions.rotate(refreshToken, { origin: { equals: 'web' } });   // single-use; races have one winner
await sessions.revoke({ accessToken, refreshToken });                              // logout: by either token
```

The refresh rotation consumes the old token in the same statement that issues the new
one, so two tabs refreshing simultaneously produce exactly one winner rather than two
valid sessions or zero. Rotation also refuses a session whose user is no longer active
and, when scoped, one minted for another surface — a suspended account cannot keep its
session alive by refreshing. Revocation matches **either** token, because after a
rotation in another tab the access cookie is stale while the refresh cookie is live, and
revoking by the first one found would delete nothing.

## The four routes

```ts
import { createAuthRoutes, createRateLimiter, readCookie, PUBLIC_ACTOR } from '@allodium/auth';

export const auth = createAuthRoutes({
  sessions,
  cookies: createSessionCookies({ names: { access: 'at', refresh: 'rt', expires: 'exp' }, maxAgeSec: 7 * 86400, secure: true }),
  origin: 'web',                                   // the surface these sessions belong to
  findUserByEmail: (email) => /* { id, passwordHash, status } | null */,
  toPublicUser: (row) => ({ id: row.id, email: row.email }),   // REQUIRED: what /me may say
  actorFor: (id) => grants.actorFor(id, claims),   // optional: roles + claims on /me
  rateLimit: createRateLimiter(),
  allowOrigins: ['https://app.example.com'],       // omit for same-origin
});

// Next.js: app/api/auth/[action]/route.ts → auth.login(req) / auth.logout(req) / auth.refresh(req) / auth.me(req)
```

What they get right so you do not have to: a wrong password and an unknown email answer
identically, in the same time; `/me` returns only what `toPublicUser` says; a lost
refresh race does not clear the winner's cookies; logout clears cookies only once the
session is actually gone (a 500 with cookies intact otherwise); and a POST from an origin
that is neither this host nor allowlisted, or with a body not typed as JSON, is refused
— CORS headers say who may read a response, not who may send a request.

**Refreshing from middleware or a fetch wrapper.** There is no package piece for the
client side of refresh, on purpose: where the retry lives (a Next proxy, a fetch
wrapper, a React query layer) is the application's shape, and the hard part is already
on the server. Rotation is single-use and atomic, so when several requests see an
expired access token and all call `/refresh`, exactly one wins and the rest get 401
*without their cookies being cleared*. The client rule is therefore one line: on a 401
from `/refresh`, do not sign out — re-read the cookies, which the winner has already
replaced, and retry the original request once. Dedupe concurrent refreshes in-process if
you like (a promise keyed by the refresh token), but correctness does not depend on it.

## Optional entry points

Two flows every application rewrites, shipped as separate imports so a project that wants
neither loads neither. Each takes the decisions as callbacks and owns the ceremony.

### Password reset — `@allodium/auth/reset`

```ts
import { createResetRoutes } from '@allodium/auth/reset';

export const reset = createResetRoutes({
  tokens: createResetTokens({ secret: () => process.env.AUTH_SECRET }),
  sessions,
  findUserByEmail, findUserById,                        // → { id, email, passwordHash, status }
  setPasswordHash: (id, hash) => db.update(...),        // the one write it makes
  resetUrl: (token) => `${SITE}/reset?token=${encodeURIComponent(token)}`,
  sendMail: ({ to, resetUrl, user }) => mailer.send(...), // your provider, your template
  rateLimit: createRateLimiter(),
});
// POST /api/auth/reset/request  { email }           → always 200
// POST /api/auth/reset          { token, password } → 200 | 400 weak | 401 not valid | 403 inactive
```

The request endpoint answers identically whether or not the email exists and does not
wait for the mail to send, so timing says nothing either. A token is keyed on the
user's current hash, so it dies the moment the password changes; every session is
revoked in the same breath, because a reset that leaves an intruder's session alive has
not reset anything.

### OpenID sign-in — `@allodium/auth/oidc`

```ts
import { createOidcLogin, GOOGLE_ISSUER } from '@allodium/auth/oidc';

export const google = createOidcLogin({
  issuer: GOOGLE_ISSUER,
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: () => process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: `${SITE}/api/auth/google/callback`,
  stateSecret: () => process.env.AUTH_SECRET!,
  authParams: { prompt: 'select_account' },
  onIdentity: async (claims) => findOrCreateUser(claims),  // THE decision; null refuses
  sessions, cookies, origin: 'site',
  successRedirect: '/account',
  failureRedirect: '/login',                                // gets ?error=<reason>
});
// GET /api/auth/google           → google.start(req)
// GET /api/auth/google/callback  → google.callback(req)
```

Endpoints come from the provider's discovery document (or name them). The state is
signed into an HttpOnly cookie with a nonce, so a callback is bound to the browser that
started the flow. The identity token is **verified**, not trusted: signature against
the provider's published keys (refetched once on an unknown key id), issuer, audience,
expiry and nonce, and `email_verified` unless you say otherwise. Refusals redirect with
a reason — `state`, `token`, `unverified-email`, `not-registered`, `inactive` — and
never mint a session.

### Passkeys — `@allodium/auth/passkeys`

```bash
npm install @simplewebauthn/server      # optional peer: loaded only by this entry point
```

```ts
import { createPasskeys, createPasskeyStore } from '@allodium/auth/passkeys';

export const passkeys = createPasskeys({
  rpID: () => new URL(process.env.SITE_URL!).hostname,
  rpName: 'Your product',
  origin: () => process.env.SITE_URL!,
  challengeSecret: () => process.env.AUTH_SECRET!,
  store: createPasskeyStore(pool),                 // the table in dev/seed/009, or your own store
  currentUser: async (req) => sessionUser(req),    // who is registering / listing / removing
  findUserById,                                    // whose credential just signed in
  sessions, cookies, sessionOrigin: 'passkey',
});
// POST /api/auth/passkey/register-options → passkeys.registerOptions(req)   (signed in)
// POST /api/auth/passkey/register-verify  → passkeys.registerVerify(req)    { response, label? }
// POST /api/auth/passkey/login-options    → passkeys.loginOptions(req)
// POST /api/auth/passkey/login-verify     → passkeys.loginVerify(req)       { response } → session
// GET  /api/auth/passkey/credentials      → passkeys.list(req)
// DELETE /api/auth/passkey/credentials/:id → passkeys.remove(req, id)
```

The browser side is `@simplewebauthn/browser`'s `startRegistration` and
`startAuthentication`, fed the options these routes return. The challenge travels in a
signed, HttpOnly, single-use cookie with its purpose and (for registration) the user
bound in — no challenge table, nothing a second tab can race. Sign-in is usernameless
and requires user verification, since a passkey is a passwordless single factor; the
user handle must name the credential's owner; the signature counter must advance, so a
cloned key is refused. Every refusal short of "this account is suspended" answers the
same 401 without a session. If the peer is not installed, every route answers 503 and
says so.

## Machine callers

A job runner, another service, an agent's tooling, a deploy script: no cookie jar, and
the usual answer is one shared secret in an environment variable that nobody can rotate,
scope, revoke or attribute. Instead, a row per token:

```ts
import { createApiTokens } from '@allodium/auth';

const tokens = createApiTokens(pool, { prefix: 'myapp_' });   // table api_tokens, see dev/seed/008

const { token } = await tokens.mint({ label: 'nightly invoicing', userId });   // shown ONCE
const service = await tokens.mint({ label: 'the deploy box', roles: ['deployer'] }); // no user: its roles alone

// In actorFor, before the cookie:
const t = await tokens.resolve(request);              // Authorization: Bearer …, or null
if (t) return t.userId ? grants.actorFor(t.userId, claims) : { userId: null, roles: t.roles, claims: {} };
```

The database holds only a SHA-256 digest. `resolve` answers null the same way for a
missing header, a wrong prefix, an unknown, expired or revoked token, and touches
`last_used_at` at most once a minute. A service token has no user, so a grant on "your
own rows" denies it — a service owns none. Bearer requests carry no cookies, so the
cross-site check on writes does not apply to them: a curl is not a cross-site form.

## Grants

```ts
const grants = createGrantLoader(pool);            // reads roles / user_roles / role_permissions
const policy = await grants.policy();              // cached 30 s; grants.refresh() after editing
const actor = await grants.actorFor(userId, { customerId: 42 });

policy.can(actor, 'orders', 'read');
// → { allowed: true, scope: [{ column: 'customer_id', op: 'eq', value: 42 }], reason: '…' }
policy.can(PUBLIC_ACTOR, 'orders', 'read');
// → { allowed: false, scope: [], reason: 'no grant for read on orders (holding: public)' }
```

A `row_filter` on a grant is a JSON array of predicates; `$actor.<claim>` substitutes a
claim the app supplied, and a missing claim **denies**. A predicate's column may be a
**path through foreign keys** when the owner lives on another table — the tasks whose
project belongs to this client:

```json
[{ "column": "project_id.client_id", "op": "eq", "value": "$actor.clientId" }]
```

Each segment but the last must be a foreign-key column on the table it is on; the
admin runtime follows them through the live catalog and compiles one subquery per hop.
A path the catalog cannot follow refuses the whole operation rather than widening it. So does a filter that cannot be
read — `{}` where `[]` was meant — which refuses the whole grant rather than quietly
widening it to every row. `policy.problems` lists what was refused and why. A
`super_admin` role bypasses the model by name and holds no rows.

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
npm test -w packages/auth                 # the whole battery; the database-backed files skip without DATABASE_URL
node packages/auth/test/integration.mjs   # sessions, needs DATABASE_URL
node packages/auth/test/act-as.mjs        # 42 checks, no database needed
node packages/auth/test/loader.mjs        # the grant loader fails closed, no database needed
```

The integration battery runs against a real PostgreSQL because that is where the
semantics live — an atomic rotation that works against a mock proves nothing.

## License

MIT. No CLA. The software is free forever; that is what the name means.
