/**
 * The grant loader, against the real matrix.
 *
 * The gate's own battery proves the RULES; this proves the rules are being fed
 * what the database actually holds — jsonb round-tripping, roles resolving for a
 * real user, and the fixture's own claims about itself (public reads published
 * posts and nothing else; super_admin holds no rows).
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import { Pool } from 'pg';
import { createGrantLoader, createAccessPolicy, PUBLIC_ACTOR } from '../dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('grant loader');

if (!process.env.DATABASE_URL) {
  console.log('\nskipped — no DATABASE_URL');
  process.exitCode = 0;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;

  try {
    const loader = createGrantLoader(pool);
    const grants = await loader.grants();
    const policy = await loader.policy();

    const [{ n }] = await raw('select count(*)::int as n from role_permissions');
    ok('every grant row is loaded', grants.length === n, `${grants.length} vs ${n}`);
    ok('nothing is reported as malformed', policy.problems.length === 0, JSON.stringify(policy.problems));

    /* --------------------- the fixture's own claims -------------------- */
    const pub = policy.can(PUBLIC_ACTOR, 'posts', 'read');
    ok('anonymous may read posts', pub.allowed);
    ok('...restricted to published', JSON.stringify(pub.scope) === JSON.stringify([{ op: 'eq', value: 'published', column: 'status' }]), JSON.stringify(pub.scope));
    ok('...and the reason does not claim ownership', !/own rows/.test(pub.reason), pub.reason);
    for (const t of ['users', 'orders', 'customers']) {
      ok(`anonymous cannot read ${t}`, !policy.can(PUBLIC_ACTOR, t, 'read').allowed);
    }
    ok('anonymous cannot write posts', !policy.can(PUBLIC_ACTOR, 'posts', 'update').allowed);

    /* ------------------ a real member, with and without ---------------- */
    const member = (await raw("select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.key = 'member' limit 1"))[0];
    const actor = await loader.actorFor(member.user_id, { customerId: 42 });
    ok('roles resolve for a real user', actor.roles.includes('member'), JSON.stringify(actor.roles));
    ok('...carrying the user id', actor.userId === member.user_id);

    const own = policy.can(actor, 'orders', 'read');
    ok('a member reads orders', own.allowed);
    ok('...scoped to their customer', JSON.stringify(own.scope) === JSON.stringify([{ op: 'eq', value: 42, column: 'customer_id' }]), JSON.stringify(own.scope));

    const claimless = await loader.actorFor(member.user_id);
    ok('the same member with no claim is DENIED', !policy.can(claimless, 'orders', 'read').allowed);
    ok('...rather than seeing everyone\'s', policy.can(claimless, 'orders', 'read').scope.length === 0);

    /* ----------------- the scope is a real SQL predicate ---------------- */
    // The point of sharing the predicate shape: hand it to the query layer as-is.
    const [{ n: mine }] = await raw('select count(*)::int as n from orders where customer_id = $1', [42]);
    const [{ n: all }] = await raw('select count(*)::int as n from orders');
    ok('the scope narrows to a real subset', mine > 0 && mine < all, `${mine} of ${all}`);

    /* ------------------------- superuser, for real --------------------- */
    const su = (await raw("select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.key = 'super_admin' limit 1"))[0];
    if (su) {
      const sa = await loader.actorFor(su.user_id);
      ok('a real super_admin bypasses', policy.can(sa, 'users', 'delete').allowed);
      ok('...by role, not by a matched grant', /bypasses/.test(policy.can(sa, 'users', 'delete').reason));
    }
    const [{ n: suGrants }] = await raw("select count(*)::int as n from role_permissions rp join roles r on r.id = rp.role_id where r.key = 'super_admin'");
    ok('super_admin holds zero grant rows, as the seed asserts', suGrants === 0);

    /* -------------------------- unknown user --------------------------- */
    const ghost = await loader.actorFor('00000000-0000-0000-0000-000000000000');
    ok('an unknown user gets no roles rather than an error', ghost.roles.length === 0);
    ok('...and therefore no access', !policy.can(ghost, 'orders', 'read').allowed);

    /* ---------------------------- the cache ---------------------------- */
    const before = (await loader.grants()).length;
    await raw("insert into role_permissions (role_id, table_name, can_read) select id, 'zz_cache_probe', true from roles where key = 'marketing'");
    try {
      ok('a cached matrix does not see a new row', (await loader.grants()).length === before);
      loader.refresh();
      ok('...and refresh() does', (await loader.grants()).length === before + 1);
    } finally {
      await raw("delete from role_permissions where table_name = 'zz_cache_probe'");
      loader.refresh();
    }

    /* ------------ a malformed filter is reported, not guessed ---------- */
    const bad = createAccessPolicy([{ role: 'x', table: 't', create: false, read: true, update: false, delete: false, rowFilter: [] }]);
    ok('an empty rowFilter means unrestricted', bad.can({ userId: null, roles: ['x'], claims: {} }, 't', 'read').scope.length === 0);
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
