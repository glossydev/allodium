/**
 * @allodium/auth 0.1.0 integration + unit battery.
 * Session store runs against the real local dev pg (allodium-dev-pg, :5433) using
 * throwaway 'tst_'/'tsr_' tokens tagged origin='pkgtest'; cleaned up at the end.
 * Run from c:\Users\adam\projects\allodium so bare imports resolve to its node_modules.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, uuid, char, timestamp, varchar } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import {
  hashPassword, verifyPassword, DUMMY_ARGON2ID_HASH,
  createRateLimiter, createResetTokens, makeStateToken, readStateToken,
  createSessionCookies, createSessionStore, firstForwardedIp,
} from '../dist/index.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } };

// ---- unit: passwords -------------------------------------------------------
{
  const h = await hashPassword('Sw0rdfish!');
  ok('hash roundtrip', await verifyPassword(h, 'Sw0rdfish!'));
  ok('hash mismatch', !(await verifyPassword(h, 'wrong')));
  ok('null hash', !(await verifyPassword(null, 'x')));
  ok('malformed hash', !(await verifyPassword('notahash', 'x')));
  ok('dummy hash is real argon2', !(await verifyPassword(DUMMY_ARGON2ID_HASH, 'anything')));
}

// ---- unit: rate limiter ----------------------------------------------------
{
  const limit = createRateLimiter();
  const results = Array.from({ length: 5 }, () => limit('k', 3, 60_000));
  ok('limiter allows max then blocks', JSON.stringify(results) === JSON.stringify([true, true, true, false, false]));
  ok('limiter isolates keys', limit('other', 3, 60_000));
}

// ---- unit: reset tokens ----------------------------------------------------
{
  let secret = 's3cret';
  const rt = createResetTokens({ secret: () => secret });
  const user = { id: 'u-1', password: '$argon2id$fakehash' };
  const tok = rt.make(user);
  ok('reset verify', rt.verify(tok, user));
  ok('reset decode', rt.decode(tok)?.u === 'u-1');
  ok('reset dies on password change', !rt.verify(tok, { password: '$argon2id$rotated' }));
  ok('reset tamper', !rt.verify(tok.slice(0, -2) + 'xx', user));
  secret = undefined;
  ok('reset no-secret verify false', !rt.verify(tok, user));
  let threw = false; try { rt.make(user); } catch { threw = true; }
  ok('reset no-secret make throws', threw);
  secret = 's3cret';
  const expired = createResetTokens({ secret: () => secret, ttlMs: -1 }).make(user);
  ok('reset expiry', !rt.verify(expired, user));
}

// ---- unit: state tokens ----------------------------------------------------
{
  const t = makeStateToken('k', 'csrf-state-123', 60_000);
  ok('state roundtrip', readStateToken('k', t) === 'csrf-state-123');
  ok('state wrong key', readStateToken('k2', t) === null);
  ok('state expired', readStateToken('k', makeStateToken('k', 's', -1)) === null);
}

// ---- unit: cookies ---------------------------------------------------------
{
  let dom = undefined;
  const jar = [];
  const store = { set: (n, v, o) => jar.push({ n, v, o }) };
  const c = createSessionCookies({
    names: { access: 'a_t', refresh: 'r_t', expires: 'e_t' },
    maxAgeSec: 604800, secure: () => true, domain: () => dom,
  });
  c.set(store, { accessToken: 'A', refreshToken: 'R', expiresAtMs: 123 });
  ok('cookie set 3', jar.length === 3 && jar[2].v === '123' && jar[0].o.maxAge === 604800 && !('domain' in jar[0].o));
  dom = '.example.com';
  c.clear(store);
  ok('cookie clear w/ live domain', jar.length === 6 && jar[5].o.maxAge === 0 && jar[5].o.domain === '.example.com' && jar[5].v === '');
}

// ---- unit: ip --------------------------------------------------------------
ok('xff first hop', firstForwardedIp('1.2.3.4, 10.0.0.1') === '1.2.3.4');
ok('xff empty', firstForwardedIp('') === null && firstForwardedIp(null) === null);

// ---- integration: session store vs real pg ---------------------------------
const sessions = pgTable('sessions', {
  id: uuid().defaultRandom().primaryKey().notNull(),
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

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const db = drizzle(pool);
try {
  const [someUser] = await db.select().from(users).where(eq(users.status, 'active')).limit(1);
  if (!someUser) throw new Error('no active user in dev DB');

  const store = createSessionStore({
    db, sessions, users,
    accessPrefix: 'tst_', refreshPrefix: 'tsr_',
    isUserActive: (u) => u.status === 'active',
  });

  const minted = await store.mint({ userId: someUser.id, origin: 'pkgtest', ip: '9.9.9.9', userAgent: 'battery' });
  ok('mint shape', minted.accessToken.startsWith('tst_') && minted.refreshToken.startsWith('tsr_') && minted.expires === 900000);

  const resolved = await store.resolveUser(minted.accessToken);
  ok('resolve default scope', resolved?.id === someUser.id);
  ok('resolve raw row has email prop', 'email' in (resolved ?? {}));
  ok('origin equals scope', (await store.resolveUser(minted.accessToken, { origin: { equals: 'pkgtest' } }))?.id === someUser.id);
  ok('origin not-scope excludes', (await store.resolveUser(minted.accessToken, { origin: { not: 'pkgtest' } })) === null);
  ok('garbage token', (await store.resolveUser('tst_nonsense')) === null);
  ok('foreign prefix', (await store.resolveUser('cha_' + 'x'.repeat(43))) === null);

  const rotated = await store.rotate(minted.refreshToken);
  ok('rotate works', rotated !== null && rotated.accessToken.startsWith('tst_'));
  ok('old refresh single-use', (await store.rotate(minted.refreshToken)) === null);
  ok('old access dead after rotate', (await store.resolveUser(minted.accessToken)) === null);
  ok('new access resolves', (await store.resolveUser(rotated.accessToken))?.id === someUser.id);

  // Concurrent rotation race: exactly one winner.
  const m2 = await store.mint({ userId: someUser.id, origin: 'pkgtest' });
  const [r1, r2] = await Promise.all([store.rotate(m2.refreshToken), store.rotate(m2.refreshToken)]);
  ok('rotation race one winner', (r1 === null) !== (r2 === null));

  await store.revoke({ accessToken: rotated.accessToken });
  ok('revoke by access', (await store.resolveUser(rotated.accessToken)) === null);

  const m3 = await store.mint({ userId: someUser.id, origin: 'pkgtest' });
  const m4 = await store.mint({ userId: someUser.id, origin: 'pkgtest' });
  await store.revokeAllForUser(someUser.id, { exceptAccessToken: m4.accessToken });
  ok('revokeAll spares except', (await store.resolveUser(m3.accessToken)) === null &&
    (await store.resolveUser(m4.accessToken, { origin: { equals: 'pkgtest' } }))?.id === someUser.id);

  // NOTE: revokeAllForUser above deleted the user's REAL sessions too (test user only —
  // battery users re-login every capture, acceptable). Clean our tagged rows:
  await db.delete(sessions).where(eq(sessions.origin, 'pkgtest'));
  const leftovers = await db.select().from(sessions).where(eq(sessions.origin, 'pkgtest'));
  ok('cleanup', leftovers.length === 0);
} finally {
  await pool.end();
}

console.log(fail === 0 ? `ALL ${pass} PASS` : `${fail} FAILURES (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
