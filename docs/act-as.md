# Act as — the user switcher

Sign in once as a superadmin and resolve the entire application as somebody else.
Testing a change across four roles stops being four log-out/log-in cycles.

It is also a support tool: "show me what this customer sees" without asking them for
their password, and without a second account that drifts out of sync with theirs.

```
┌────────────────────────────────────────────────────────────┐
│  Acting as Ada Lovelace (member) · you are Adam · read-only │  ← always visible
├────────────────────────────────────────────────────────────┤
│  the whole app, resolved as Ada                             │
└────────────────────────────────────────────────────────────┘
```

## The one thing to get right

Hook it into the **single function your app reads identity from**. Wrap that, and route
guards, query scoping and every UI decision follow automatically.

Hook it anywhere else and some routes see the target while others see the actor. That
is worse than not having the feature, because the resulting bugs look like
authorization bugs and you will chase them for a day.

```ts
// lib/auth.ts — the ONE place identity comes from
import { createActAs } from '@allodium/auth';

export const actAs = createActAs({
  secret: () => process.env.AUTH_SECRET!,
  enabled: () => process.env.ACT_AS_ENABLED,
  isDevelopment: () => process.env.NODE_ENV !== 'production',
  canActAs: (u) => u.role === 'super_admin',
  loadUser: (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  userId: (u) => u.id,
});

/** What the application should behave as. Use this everywhere. */
export async function getCurrentUser() {
  const real = await sessionUser(await readSessionCookie());
  const ticket = (await cookies()).get(actAs.cookieName)?.value;
  return (await actAs.resolve(real, ticket)).user;
}

/** Who is really signed in. Use this to decide AUTHORITY. */
export async function getRealUser() {
  return sessionUser(await readSessionCookie());
}
```

That is the whole integration. Everything below is the reasoning, the API, and the
mistakes worth avoiding.

## The security model

Five properties. They are not independent features — remove any one and the others
stop being sufficient.

**1 · The real session is never replaced.** A second signed cookie holds an
*instruction*; no session is ever minted for the target and your own session is
untouched. Stopping is deleting the cookie. There is nothing server-side to clean up,
so there is nothing to leak.

**2 · Authority is re-checked on every request, from the live session.** The ticket
*names* a target; it does not confer the right to use one. Demote a superadmin and
every impersonation they have open dies on their next request — no session to hunt
down and revoke.

**3 · The ticket is signed and bound to the actor.** HMAC over both the target and the
actor id, so it cannot be forged and is inert if lifted into another browser. A member
replaying a superadmin's genuine cookie is still just themselves.

**4 · No escalation by construction.** Only users who pass `canActAs` can start, so
acting as somebody can never grant authority the actor did not already have. Acting as
a member is strictly a *reduction*.

**5 · It is never silent.** `resolve` returns the state your banner needs. Silent
impersonation is the failure mode this design exists to prevent; if you take one thing
from this document, show the banner.

## Defaults lean safe

| | default | why |
|---|---|---|
| Feature switch | **off** in production, on in development | An unconsidered deploy ships without it. |
| Impersonating staff | **blocked** | Impersonating a colleague is a bigger decision than impersonating a customer. Override with `canBeTarget`. |
| Write access | **full** only for whoever you say | The risk was never impersonation — it is *writes performed as someone else*. |
| Ticket lifetime | **8 hours** | A working day, not a standing grant. |

### Read-only mode

The two use cases split cleanly: developers testing need to write; support answering a
ticket almost never does. Give support a read-only ticket and reject writes while it is
active:

```ts
mode: (actor) => (actor.role === 'super_admin' ? 'full' : 'readonly'),
```

```ts
// middleware, or your write helpers
const state = await actAs.resolve(real, ticket);
if (actAs.blocksWrite(state, request.method)) {
  return new Response('Read-only while acting as another user', { status: 403 });
}
```

`blocksWrite` allows `GET`, `HEAD` and `OPTIONS`, and refuses everything else — but only
while a read-only impersonation is active. It is always `false` when nobody is acting.

### The master switch

`ACT_AS_ENABLED` is checked in `start` **and** in `resolve`, so turning it off ends
impersonations that are already in flight rather than only preventing new ones.

Unset means on in development and off in production — pass `isDevelopment` for that to
work. Without it, unset means **off**, because the safe branch is the one to take when
the library cannot tell where it is running.

## Starting and stopping

```ts
// POST /api/act-as   { targetId }
const real = await getRealUser();               // ← REAL user, see the gotchas
const result = await actAs.start(real, targetId);
if (!result.ok) return Response.json({ error: result.refusal }, { status: 403 });

const res = Response.json({ ok: true });
res.cookies.set(actAs.cookieName, result.ticket, actAs.cookieOptions());
return res;

// DELETE /api/act-as — stop
res.cookies.set(actAs.cookieName, '', actAs.clearCookieOptions());
```

Stopping must keep working even when the feature is disabled, which it does: clearing a
cookie needs no authority.

## Gotchas

Each of these was hit for real. They are cheap to avoid and expensive to debug.

**Your act-as endpoints must resolve the REAL session.** If `POST /api/act-as` uses the
hooked resolver, then while acting as a member it checks *the member's* authority, finds
none, and strands you with no way back. Use `getRealUser` in the switcher's own routes.

**So must whatever decides to render the bar.** Use the real session, or the bar
disappears the moment you switch to somebody who cannot act — taking the "back to me"
button with it.

**Clear the ticket on logout.** It is inert without a session, but leaving it means the
next login silently resumes as somebody else.

**Switch with a full page load**, not a client-side navigation. Server components,
layouts and cached fetches all need to re-resolve.

**Gather candidates by every relevant relationship.** If your schema separates
membership from administration, a query that only follows one foreign key will silently
omit admins from their own tenant.

## Auditing

`onAudit` fires for every start, stop, refusal and active request. Console logs are fine
for development; the moment a human support team uses this, write rows.

```ts
onAudit: (e) => db.insert(actAsAudit).values({
  type: e.type, actorId: e.actorId, targetId: e.targetId,
  mode: e.mode, refusal: e.refusal ?? null, at: e.at,
}),
```

A throwing audit sink never breaks the request it describes — auditing is not allowed to
take the feature down with it.

## `resolve` returns

```ts
{
  user,      // the identity the app should use — the target when acting, else the real user
  real,      // who is actually signed in; authority decisions use THIS
  acting,    // boolean
  target,    // the target, or null
  mode,      // 'full' | 'readonly'
  refusal?,  // set when a ticket was present but not honoured
}
```

`refusal` is one of `disabled`, `no-session`, `invalid-ticket`, `expired`,
`actor-mismatch`, `not-authorized`, `target-missing`, `target-blocked`, `self`. It is
returned rather than thrown so you can show the operator why nothing happened — an
impersonation that silently fails open, or silently fails closed, are both bad.

## Testing it

`packages/auth/test/act-as.mjs` is 42 checks covering all five properties and every
gotcha above, including forging a ticket, replaying a stolen one in another browser, and
demoting an actor mid-impersonation. No database required:

```bash
node packages/auth/test/act-as.mjs
```
