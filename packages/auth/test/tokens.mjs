/**
 * API tokens: a machine caller becomes an actor.
 *
 * What has to hold: the secret exists in plaintext exactly once, at minting,
 * and the database holds only a digest; a token resolves to the identity it
 * was minted for and to nothing else; unknown, revoked and expired tokens all
 * resolve to the same null; a user token takes the user's roles through the
 * grant loader while a service token carries its own and owns no rows.
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import { Pool } from 'pg';
import { createApiTokens, createGrantLoader, createAccessPolicy, PUBLIC_ACTOR } from '../dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('api tokens');

if (!process.env.DATABASE_URL) {
  console.log('\nskipped — no DATABASE_URL');
  process.exitCode = 0;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const minted = [];
  const withBearer = (token) => new Request('http://api.test/anything', { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

  try {
    const tokens = createApiTokens(pool, { prefix: 'tst_', touchEveryMs: 0 });
    const loader = createGrantLoader(pool);
    const support = (await raw("select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.key = 'support' limit 1"))[0];

    /* --------------------------------- mint -------------------------------- */
    const one = await tokens.mint({ label: 'nightly job', userId: support.id });
    minted.push(one.id);
    ok('a minted token carries the prefix', one.token.startsWith('tst_'), one.token.slice(0, 8));
    ok('...and is long enough to be a secret', one.token.length > 40, String(one.token.length));
    ok('isToken recognises it', tokens.isToken(one.token));
    ok('...and refuses other strings', !tokens.isToken('tst_short') && !tokens.isToken('pga_' + 'x'.repeat(40)) && !tokens.isToken(null));
    const stored = (await raw('select token_hash, label, user_id, roles from api_tokens where id = $1', [one.id]))[0];
    ok('the database holds a digest, not the token', stored.token_hash !== one.token && stored.token_hash.length === 64 && !/tst_/.test(stored.token_hash));
    ok('...with the label and user', stored.label === 'nightly job' && String(stored.user_id) === String(support.id));
    ok('...and empty roles meaning "the user\'s own"', Array.isArray(stored.roles) && stored.roles.length === 0);

    /* -------------------------------- resolve ------------------------------ */
    const who = await tokens.resolve(withBearer(one.token));
    ok('a bearer request resolves to its identity', who?.id === one.id && String(who.userId) === String(support.id), JSON.stringify(who));
    ok('...never carrying the digest', who && !('tokenHash' in who) && !('token_hash' in who));
    ok('the token string resolves too', (await tokens.resolve(one.token))?.id === one.id);
    ok('...and touches last_used_at', (await raw('select last_used_at from api_tokens where id = $1', [one.id]))[0].last_used_at !== null);
    ok('no header resolves to null', (await tokens.resolve(withBearer(undefined))) === null);
    ok('a wrong scheme resolves to null', (await tokens.resolve(new Request('http://api.test/x', { headers: { authorization: `Basic ${one.token}` } }))) === null);
    ok('a wrong prefix resolves to null', (await tokens.resolve(withBearer('pga_' + one.token.slice(4)))) === null);
    ok('an unknown token resolves to null', (await tokens.resolve(withBearer('tst_' + 'A'.repeat(43)))) === null);
    ok('a token differing by one character resolves to null', (await tokens.resolve(withBearer(one.token.slice(0, -1) + (one.token.endsWith('a') ? 'b' : 'a')))) === null);

    // The app composes the actor from the identity, as it would from a session.
    const actor = await loader.actorFor(who.userId, {});
    ok('a user token becomes the user\'s actor through the grant loader', actor.roles.includes('support') && actor.userId === who.userId, JSON.stringify(actor));
    const policy = await loader.policy();
    ok('...with the user\'s grants', policy.can(actor, 'orders', 'read').allowed && !policy.can(PUBLIC_ACTOR, 'orders', 'read').allowed);

    /* ---------------------------- a service token -------------------------- */
    const svc = await tokens.mint({ label: 'the deploy box', roles: ['support'] });
    minted.push(svc.id);
    const svcId = await tokens.resolve(withBearer(svc.token));
    ok('a service token resolves with no user and its own roles', svcId?.userId === null && JSON.stringify(svcId.roles) === '["support"]', JSON.stringify(svcId));
    const svcActor = { userId: svcId.userId, roles: svcId.roles, claims: {} };
    ok('...which the policy honours', policy.can(svcActor, 'orders', 'read').allowed);
    const own = createAccessPolicy([{ role: 'support', table: 'orders', create: false, read: true, update: false, delete: false, rowFilter: [{ column: 'customer_id', op: 'eq', value: '$actor.userId' }] }]);
    ok('...but a grant on "your own rows" denies it, since a service owns none', !own.can(svcActor, 'orders', 'read').allowed);

    /* ----------------------------- expiry, revoke -------------------------- */
    const stale = await tokens.mint({ label: 'already over', userId: support.id, expiresAt: new Date(Date.now() - 1000) });
    minted.push(stale.id);
    ok('an expired token resolves to null', (await tokens.resolve(stale.token)) === null);
    const fresh = await tokens.mint({ label: 'still good', userId: support.id, expiresAt: new Date(Date.now() + 60_000) });
    minted.push(fresh.id);
    ok('a token before its expiry resolves', (await tokens.resolve(fresh.token))?.id === fresh.id);
    ok('revoke reports a live token revoked', (await tokens.revoke(one.id)) === true);
    ok('...after which it resolves to null', (await tokens.resolve(one.token)) === null);
    ok('...and revoking again reports nothing to do', (await tokens.revoke(one.id)) === false);

    /* --------------------------------- list -------------------------------- */
    const live = await tokens.list({ userId: support.id });
    ok('list shows the user\'s live tokens, newest first', live.map((t) => t.id).join() === [fresh.id, stale.id].join(), live.map((t) => t.label).join(', '));
    ok('...never the digest', live.every((t) => !('tokenHash' in t) && !('token_hash' in t)));
    ok('...and the revoked one only when asked', (await tokens.list({ userId: support.id, includeRevoked: true })).some((t) => t.id === one.id && t.revokedAt !== null));
    ok('service tokens list by a null user', (await tokens.list({ userId: null })).some((t) => t.id === svc.id));
  } finally {
    if (minted.length) await raw('delete from api_tokens where id = any($1::uuid[])', [minted]).catch(() => {});
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
