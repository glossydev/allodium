/**
 * The auth endpoints, driven as a browser drives them.
 *
 * These are the four routes every app rewrites, and each has a failure that is
 * invisible from the outside: a login that answers differently for an unknown
 * email leaks your user list; a /me that returns the raw row leaks a password
 * hash; a refresh that clears cookies on a lost race signs out a good session;
 * a session minted for one surface that resolves on another makes the origin
 * column decorative.
 *
 * So every assertion here is made through a real Request and a real Response —
 * headers, cookies, status codes — against the real store and the real database.
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, uuid, char, timestamp, varchar } from 'drizzle-orm/pg-core';
import {
  createSessionStore,
  createSessionCookies,
  createAuthRoutes,
  createRateLimiter,
  createGrantLoader,
  readCookie,
} from '../dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('auth routes');

if (!process.env.DATABASE_URL) {
  console.log('\nskipped — no DATABASE_URL');
  process.exitCode = 0;
} else {
  const sessions = pgTable('sessions', {
    id: uuid().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    accessHash: char('access_hash', { length: 64 }).notNull(),
    refreshHash: char('refresh_hash', { length: 64 }).notNull(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    ip: varchar({ length: 64 }),
    userAgent: varchar('user_agent', { length: 255 }),
    origin: varchar({ length: 16 }).default('password').notNull(),
  });
  const users = pgTable('users', {
    id: uuid().primaryKey().notNull(),
    email: varchar({ length: 128 }),
    status: varchar({ length: 16 }),
  });

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const db = drizzle(pool);
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;

  /* ------------------------- the wiring under test ------------------------ */
  const store = createSessionStore({
    db, sessions, users,
    accessPrefix: 'rta_', refreshPrefix: 'rtr_',
    isUserActive: (u) => u.status === 'active',
  });
  const cookies = createSessionCookies({
    names: { access: 'at', refresh: 'rt', expires: 'exp' },
    maxAgeSec: 60 * 60 * 24 * 7,
    secure: false,
  });

  const findUserByEmail = async (email) => {
    const [row] = await raw('select id, password_hash, status from users where lower(email) = lower($1) limit 1', [email]);
    return row ? { id: row.id, passwordHash: row.password_hash, status: row.status } : null;
  };
  // What /me is allowed to say. Deliberately narrow — the row it comes from has
  // a password hash and an mfa secret in it.
  const toPublicUser = (row) => ({ id: row.id, email: row.email, name: row.displayName ?? row.display_name ?? null });

  const loader = createGrantLoader(pool);
  const makeRoutes = (origin, extra = {}) =>
    createAuthRoutes({
      sessions: store, cookies, origin,
      findUserByEmail, toPublicUser,
      allowOrigins: ['http://localhost:3191'],
      ...extra,
    });
  const site = makeRoutes('site', { actorFor: (id) => loader.actorFor(id, {}) });
  const admin = makeRoutes('admin');

  const post = (body, headers = {}) =>
    new Request('http://api.test/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = (headers = {}) => new Request('http://api.test/me', { method: 'GET', headers });
  const cookieHeader = (res) => {
    const jar = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    return jar.map((c) => c.split(';')[0]).join('; ');
  };
  const setCookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean));

  try {
    const active = (await raw("select email from users where status = 'active' order by email limit 1"))[0];
    const suspended = (await raw("select email from users where status = 'suspended' limit 1"))[0];
    const invited = (await raw("select email from users where status = 'invited' limit 1"))[0];

    /* ------------------------------- login ------------------------------- */
    const good = await site.login(post({ email: active.email, password: 'devpassword' }));
    ok('a correct password signs in', good.status === 200);
    const jar = setCookies(good);
    ok('...setting three separate Set-Cookie headers', jar.length === 3, `${jar.length}`);
    ok('...HttpOnly on the access cookie', jar.some((c) => c.startsWith('at=') && /HttpOnly/.test(c)));
    ok('...with SameSite and Path', jar.every((c) => /SameSite=Lax/.test(c) && /Path=\//.test(c)));
    const goodBody = await good.json();
    ok('...returning the public user', goodBody.user?.email === active.email);
    ok('...and NOT the password hash', !JSON.stringify(goodBody).includes('argon2'), JSON.stringify(goodBody).slice(0, 80));

    const wrong = await site.login(post({ email: active.email, password: 'not-it' }));
    const unknown = await site.login(post({ email: 'nobody@example.com', password: 'not-it' }));
    ok('a wrong password is refused', wrong.status === 401);
    ok('an unknown email is refused', unknown.status === 401);
    // The enumeration oracle: these two must be indistinguishable.
    ok('...with the identical status and body', JSON.stringify(await wrong.json()) === JSON.stringify(await unknown.json()));

    ok('a missing field is a 400, not a 401', (await site.login(post({ email: active.email }))).status === 400);

    // Status failures ARE distinguishable — the seed gives these users CORRECT
    // passwords precisely so the difference is provable.
    if (suspended) {
      const r = await site.login(post({ email: suspended.email, password: 'devpassword' }));
      ok('a suspended account is refused as suspended', r.status === 403 && (await r.json()).status === 'suspended');
    }
    if (invited) {
      const r = await site.login(post({ email: invited.email, password: 'devpassword' }));
      ok('an invited account is refused as invited', r.status === 403 && (await r.json()).status === 'invited');
    }

    /* -------------------------------- me --------------------------------- */
    const cookie = cookieHeader(good);
    ok('me without a cookie is 401', (await site.me(get())).status === 401);
    const meRes = await site.me(get({ cookie }));
    ok('me with the cookie is 200', meRes.status === 200);
    const meBody = await meRes.json();
    ok('...returning the public user only', meBody.user?.email === active.email);
    ok('...never the hash', !JSON.stringify(meBody).includes('argon2') && !('password_hash' in (meBody.user ?? {})));
    ok('...and the actor with its roles', Array.isArray(meBody.actor?.roles), JSON.stringify(meBody.actor));

    /* ------------- cross-surface origin scoping (load-bearing) ------------ */
    // A cookie minted for the site, replayed at the admin surface, must resolve
    // to nothing. This is the reason sessions carry an origin at all, and it is
    // the shape the three-app harness exists to exercise.
    ok('a site session does not resolve at the admin surface', (await admin.me(get({ cookie }))).status === 401);
    const adminLogin = await admin.login(post({ email: active.email, password: 'devpassword' }));
    ok('...and the admin surface can mint its own', adminLogin.status === 200);
    ok('...which in turn does not resolve at the site', (await site.me(get({ cookie: cookieHeader(adminLogin) }))).status === 401);

    /* ------------------------------ refresh ------------------------------ */
    ok('refresh without a cookie is 401', (await site.refresh(post({}))).status === 401);
    const rotated = await site.refresh(post({}, { cookie }));
    ok('refresh rotates', rotated.status === 200);
    ok('...issuing new cookies', setCookies(rotated).length === 3);
    const newCookie = cookieHeader(rotated);
    ok('...and the new access token works', (await site.me(get({ cookie: newCookie }))).status === 200);

    // Single-use: replaying the spent refresh loses, and losing must NOT clear
    // the winner's cookies — that is the blip that signs people out.
    const replay = await site.refresh(post({}, { cookie }));
    ok('a spent refresh token is refused', replay.status === 401);
    ok('...without clearing any cookie', setCookies(replay).length === 0, JSON.stringify(setCookies(replay)));
    ok('...leaving the rotated session alive', (await site.me(get({ cookie: newCookie }))).status === 200);

    /* --------------------- refresh is scoped and gated ------------------- */
    // A refresh cookie from the site surface, replayed at the admin surface,
    // must not rotate there — the same scoping /me has always had.
    ok('a site refresh token does not rotate at the admin surface', (await admin.refresh(post({}, { cookie: newCookie }))).status === 401);
    ok('...and is still live at its own surface', (await site.me(get({ cookie: newCookie }))).status === 200);
    // A suspended account cannot keep its session alive by refreshing.
    const [{ status: wasStatus }] = await raw('select status from users where email = $1', [active.email]);
    await raw("update users set status = 'suspended' where email = $1", [active.email]);
    const whileSuspended = await site.refresh(post({}, { cookie: newCookie }));
    await raw('update users set status = $2 where email = $1', [active.email, wasStatus]);
    ok('a suspended user cannot refresh', whileSuspended.status === 401, String(whileSuspended.status));
    ok('...and nothing was issued', setCookies(whileSuspended).length === 0);
    ok('...while the session itself is untouched once reinstated', (await site.me(get({ cookie: newCookie }))).status === 200);

    /* ------------------------------- logout ------------------------------ */
    // The two-tab case: this tab's access cookie is STALE (another tab rotated)
    // while its refresh cookie is live. Logout must still kill the session.
    const rotatedAgain = await site.refresh(post({}, { cookie: newCookie }));
    ok('a second rotation works', rotatedAgain.status === 200);
    const liveRefresh = cookieHeader(rotatedAgain).split('; ').find((c) => c.startsWith('rt='));
    const staleAccess = newCookie.split('; ').find((c) => c.startsWith('at='));
    const staleJar = `${staleAccess}; ${liveRefresh}`;
    ok('the stale access cookie no longer resolves', (await site.me(get({ cookie: staleJar }))).status === 401);
    const outStale = await site.logout(post({}, { cookie: staleJar }));
    ok('logout with a stale access cookie succeeds', outStale.status === 200);
    ok('...and revokes by the refresh cookie, so it cannot be replayed', (await site.refresh(post({}, { cookie: staleJar }))).status === 401);
    ok('...leaving the rotated access token dead too', (await site.me(get({ cookie: cookieHeader(rotatedAgain) }))).status === 401);

    const fresh = await site.login(post({ email: active.email, password: 'devpassword' }));
    const freshCookie = cookieHeader(fresh);
    const out = await site.logout(post({}, { cookie: freshCookie }));
    ok('logout succeeds', out.status === 200);
    ok('...clearing the cookies', setCookies(out).length >= 2);
    ok('...and the session is gone', (await site.me(get({ cookie: freshCookie }))).status === 401);
    ok('logout with no session still succeeds', (await site.logout(post({}))).status === 200);
    // A revoke the database refuses must NOT clear the cookies.
    const brokenStore = { ...store, revoke: async () => { throw new Error('db down'); } };
    const brokenRoutes = createAuthRoutes({ sessions: brokenStore, cookies, origin: 'site', findUserByEmail, toPublicUser });
    const failedOut = await brokenRoutes.logout(post({}, { cookie: freshCookie }));
    ok('a logout the database refuses is a 500', failedOut.status === 500, String(failedOut.status));
    ok('...with the cookies left alone', setCookies(failedOut).length === 0);

    /* ---------------------- cross-site request forgery --------------------- */
    const forgedLogin = await site.login(post({ email: active.email, password: 'devpassword' }, { origin: 'http://evil.test' }));
    ok('a login from an unlisted origin is refused', forgedLogin.status === 403);
    ok('...without a session being minted', setCookies(forgedLogin).length === 0);
    ok('a login from an allowlisted origin passes', (await site.login(post({ email: active.email, password: 'devpassword' }, { origin: 'http://localhost:3191' }))).status === 200);
    ok('a login from this host passes', (await site.login(post({ email: active.email, password: 'devpassword' }, { origin: 'https://api.test' }))).status === 200);
    ok('a form-encoded login is refused as 415', (await site.login(new Request('http://api.test/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=x&password=y' }))).status === 415);
    ok('a request the browser labels cross-site is refused', (await site.logout(post({}, { 'sec-fetch-site': 'cross-site' }))).status === 403);
    ok('a bodiless logout with no content type still passes', (await site.logout(new Request('http://api.test/logout', { method: 'POST' }))).status === 200);

    /* -------------------------------- CORS ------------------------------- */
    const allowed = await site.me(get({ origin: 'http://localhost:3191' }));
    ok('an allowed origin gets its exact origin back', allowed.headers.get('access-control-allow-origin') === 'http://localhost:3191');
    ok('...with credentials enabled', allowed.headers.get('access-control-allow-credentials') === 'true');
    ok('...and Vary: Origin so caches do not cross wires', allowed.headers.get('vary') === 'Origin');
    const denied = await site.me(get({ origin: 'http://evil.test' }));
    ok('an unlisted origin gets no CORS headers', denied.headers.get('access-control-allow-origin') === null);
    const pre = site.preflight(new Request('http://api.test/login', { method: 'OPTIONS', headers: { origin: 'http://localhost:3191' } }));
    ok('preflight is 204', pre.status === 204);
    ok('...and allows the methods used', /POST/.test(pre.headers.get('access-control-allow-methods') ?? ''));
    ok('the wildcard is never used', allowed.headers.get('access-control-allow-origin') !== '*');

    /* ----------------------------- rate limit ---------------------------- */
    const limited = makeRoutes('site', { rateLimit: createRateLimiter(), limits: { perEmail: 3, windowMs: 60_000 } });
    const attempts = [];
    for (let i = 0; i < 5; i++) attempts.push((await limited.login(post({ email: 'grind@example.com', password: 'x' }))).status);
    ok('the throttle engages', attempts.includes(429), JSON.stringify(attempts));
    ok('...only after the allowance', attempts.slice(0, 3).every((s) => s === 401), JSON.stringify(attempts));

    /* --------------------------- cookie reading -------------------------- */
    ok('readCookie finds a value among several', readCookie(new Request('http://x.test', { headers: { cookie: 'a=1; at=tok; b=2' } }), 'at') === 'tok');
    ok('readCookie decodes', readCookie(new Request('http://x.test', { headers: { cookie: 'at=a%20b' } }), 'at') === 'a b');
    ok('readCookie misses cleanly', readCookie(new Request('http://x.test'), 'at') === undefined);
  } finally {
    await raw("delete from sessions where origin in ('site','admin')").catch(() => {});
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
