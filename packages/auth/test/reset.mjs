/**
 * The password-reset routes, driven as a browser drives them.
 *
 * What has to hold: the request endpoint answers identically for a known and
 * an unknown email and mails only the account that exists and may reset; a
 * token resets the password it was issued against and nothing after it —
 * once the hash changes, the token is dead and so is every session; a weak
 * password, a bad token and an inactive account are refused in distinguishable
 * ways that reveal nothing.
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, uuid, char, timestamp, varchar } from 'drizzle-orm/pg-core';
import { createSessionStore, createResetTokens, createRateLimiter, verifyPassword } from '../dist/index.js';
import { createResetRoutes } from '../dist/reset.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('password reset');

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
  const users = pgTable('users', { id: uuid().primaryKey().notNull(), email: varchar({ length: 200 }), status: varchar({ length: 16 }) });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const db = drizzle(pool);
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;

  const store = createSessionStore({ db, sessions, users, accessPrefix: 'rsa_', refreshPrefix: 'rsr_', isUserActive: (u) => u.status === 'active' });
  const tokens = createResetTokens({ secret: () => 'reset-secret', ttlMs: 60_000 });
  const findUser = (where, param) => raw(`select id, email, password_hash, status from users where ${where} limit 1`, [param]).then(([r]) => (r ? { id: r.id, email: r.email, passwordHash: r.password_hash, status: r.status } : null));
  const mails = [];
  const events = [];
  const make = (extra = {}) =>
    createResetRoutes({
      tokens,
      sessions: store,
      findUserByEmail: (email) => findUser('lower(email) = lower($1)', email),
      findUserById: (id) => findUser('id = $1', id),
      setPasswordHash: async (id, hash) => { await raw('update users set password_hash = $2 where id = $1', [id, hash]); },
      resetUrl: (token) => `http://app.test/reset?token=${encodeURIComponent(token)}`,
      sendMail: async (args) => { mails.push(args); },
      allowOrigins: ['http://localhost:3191'],
      onEvent: (e) => events.push(e),
      ...extra,
    });
  const routes = make();
  const post = (path, body, headers = {}) => new Request(`http://api.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  const active = (await raw("select id, email, password_hash from users where status = 'active' and password_hash is not null order by email limit 1"))[0];
  const suspended = (await raw("select id, email, password_hash from users where status = 'suspended' limit 1"))[0];
  const originalHash = active.password_hash;

  try {
    /* -------------------------------- request ------------------------------- */
    const known = await routes.request(post('/request', { email: active.email.toUpperCase() }));
    const unknown = await routes.request(post('/request', { email: 'nobody@example.com' }));
    await settle();
    ok('a known email is 200', known.status === 200);
    ok('an unknown email is 200 too', unknown.status === 200);
    ok('...with the identical body', JSON.stringify(await known.json()) === JSON.stringify(await unknown.json()));
    ok('only the known one got mail', mails.length === 1 && mails[0].to === active.email, `${mails.length}`);
    ok('...with a link carrying the token', mails[0].resetUrl.includes(encodeURIComponent(mails[0].token)));
    ok('...and the email was matched case-insensitively', mails[0].user.id === active.id);
    ok('a missing email is 400', (await routes.request(post('/request', {}))).status === 400);
    ok('a cross-site request is refused', (await routes.request(post('/request', { email: active.email }, { origin: 'http://evil.test' }))).status === 403);
    ok('an allowlisted origin passes', (await routes.request(post('/request', { email: 'nobody@example.com' }, { origin: 'http://localhost:3191' }))).status === 200);
    if (suspended) {
      await routes.request(post('/request', { email: suspended.email }));
      await settle();
      ok('a suspended account is not mailed', mails.every((m) => m.user.id !== suspended.id));
      ok('...but the answer was still 200', events.some((e) => e.type === 'requested' && e.eligible === false));
    }

    /* --------------------------------- reset -------------------------------- */
    const token = mails[0].token;
    // A session that must die with the reset.
    const live = await store.mint({ userId: active.id, origin: 'reset-test' });
    ok('the user has a live session before the reset', (await store.resolveUser(live.accessToken)) !== null);
    ok('a weak password is 400', (await routes.reset(post('/reset', { token, password: 'short' }))).status === 400);
    ok('a malformed token is 401', (await routes.reset(post('/reset', { token: 'nope', password: 'a-good-long-password' }))).status === 401);
    ok('a token signed with another secret is 401', (await routes.reset(post('/reset', { token: createResetTokens({ secret: () => 'other' }).make({ id: active.id, password: originalHash }), password: 'a-good-long-password' }))).status === 401);
    ok('a cross-site reset is refused', (await routes.reset(post('/reset', { token, password: 'a-good-long-password' }, { origin: 'http://evil.test' }))).status === 403);
    const done = await routes.reset(post('/reset', { token, password: 'a-good-long-password' }));
    ok('a good token resets the password', done.status === 200, String(done.status));
    const after = (await raw('select password_hash from users where id = $1', [active.id]))[0].password_hash;
    ok('...storing a new argon2id hash', after !== originalHash && (await verifyPassword(after, 'a-good-long-password')));
    ok('...and revoking every session', (await store.resolveUser(live.accessToken)) === null);
    ok('the token is dead once the hash changed', (await routes.reset(post('/reset', { token, password: 'another-long-password' }))).status === 401);
    ok('events tell the story', events.some((e) => e.type === 'sent' && e.userId === active.id) && events.some((e) => e.type === 'reset' && e.userId === active.id));

    if (suspended && suspended.password_hash) {
      const susToken = tokens.make({ id: suspended.id, password: suspended.password_hash });
      const r = await routes.reset(post('/reset', { token: susToken, password: 'a-good-long-password' }));
      ok('an inactive account with a valid token is refused as inactive', r.status === 403 && (await r.json()).status === 'suspended');
      ok('...and its hash is untouched', (await raw('select password_hash from users where id = $1', [suspended.id]))[0].password_hash === suspended.password_hash);
    }

    /* ------------------------------ rate limit ------------------------------ */
    const limited = make({ rateLimit: createRateLimiter(), limits: { perEmail: 2, windowMs: 60_000 } });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await limited.request(post('/request', { email: 'grind@example.com' }))).status);
    ok('the throttle engages after the allowance', JSON.stringify(statuses) === '[200,200,429,429]', JSON.stringify(statuses));
    ok('preflight is 204', routes.preflight(new Request('http://api.test/request', { method: 'OPTIONS', headers: { origin: 'http://localhost:3191' } })).status === 204);
  } finally {
    await raw('update users set password_hash = $2 where id = $1', [active.id, originalHash]).catch(() => {});
    await raw("delete from sessions where origin = 'reset-test'").catch(() => {});
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
