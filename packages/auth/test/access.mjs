/**
 * The permission gate, read back.
 *
 * A permission bug is silent: nothing crashes, someone just sees rows they
 * should not, or stops seeing rows they should. So every rule here is asserted
 * from the outside rather than trusted from the code, and the ones that matter
 * most are the near-misses — a superuser with no grant rows, an actor missing
 * the claim its row filter needs, two roles restricting the same table
 * differently. Each of those has a plausible wrong answer that looks fine.
 *
 * Pure: no database, no build step beyond dist.
 */
import { createAccessPolicy, PUBLIC_ACTOR, PUBLIC_ROLE, ACTIONS } from '../dist/access.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('permission gate');

const grant = (role, table, actions, rowFilter) => ({
  role,
  table,
  create: actions.includes('create'),
  read: actions.includes('read'),
  update: actions.includes('update'),
  delete: actions.includes('delete'),
  ...(rowFilter ? { rowFilter } : {}),
});

const actor = (roles, claims = {}, userId = 'u1') => ({ userId, roles, claims });
const OWN_ORDERS = [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }];

/* --------------------------- the basic matrix -------------------------- */
{
  const p = createAccessPolicy([grant('support', 'orders', ['read'])]);
  ok('a granted action is allowed', p.can(actor(['support']), 'orders', 'read').allowed);
  ok('an ungranted action is refused', !p.can(actor(['support']), 'orders', 'update').allowed);
  ok('an ungranted table is refused', !p.can(actor(['support']), 'users', 'read').allowed);
  ok('a role you do not hold does not help', !p.can(actor(['marketing']), 'orders', 'read').allowed);
  ok('refusals say why', /no grant for update on orders/.test(p.can(actor(['support']), 'orders', 'update').reason));
  ok('an unrestricted grant yields an empty scope', p.can(actor(['support']), 'orders', 'read').scope.length === 0);
}

/* ------------------------- superuser is explicit ----------------------- */
{
  // The case with a plausible wrong answer: super_admin holds ZERO grant rows on
  // purpose, so "found nothing" and "may do anything" are the same query result.
  const p = createAccessPolicy([grant('support', 'orders', ['read'])]);
  for (const a of ACTIONS) {
    ok(`super_admin may ${a} anything`, p.can(actor(['super_admin']), 'anything_at_all', a).allowed);
  }
  ok('...and says it bypassed rather than matched', /bypasses the permission model/.test(p.can(actor(['super_admin']), 'x', 'read').reason));
  ok('...with no row scope', p.can(actor(['super_admin']), 'orders', 'read').scope.length === 0);

  // An actor with no roles at all must not accidentally look like a superuser.
  ok('no roles means no access', !p.can(actor([]), 'orders', 'read').allowed);

  // The bypass is configurable, and configuring it does not leave the default on.
  const named = createAccessPolicy([], { superuserRoles: ['owner'] });
  ok('a named superuser role bypasses', named.can(actor(['owner']), 'x', 'delete').allowed);
  ok('...and super_admin no longer does', !named.can(actor(['super_admin']), 'x', 'delete').allowed);

  // Grants on a superuser role are inert; saying so beats letting them read as real.
  const noisy = createAccessPolicy([grant('super_admin', 'orders', ['read'])]);
  ok('a grant on a superuser role is reported as pointless', noisy.problems.some((w) => w.includes('super_admin')));
}

/* --------------------------- union across roles ------------------------ */
{
  const p = createAccessPolicy([
    grant('member', 'orders', ['read'], OWN_ORDERS),
    grant('support', 'orders', ['read', 'update']),
  ]);
  const both = actor(['member', 'support'], { customerId: 7 });

  ok('holding two roles unions their actions', p.can(both, 'orders', 'update').allowed);
  const d = p.can(both, 'orders', 'read');
  ok('the more permissive grant wins', d.allowed && d.scope.length === 0, JSON.stringify(d));
  ok('...and says which role did it', /support/.test(d.reason));

  // Holding an extra role can never take access away.
  const memberOnly = p.can(actor(['member'], { customerId: 7 }), 'orders', 'read');
  ok('the restricted role alone is still allowed', memberOnly.allowed);
  ok('...but scoped', memberOnly.scope.length === 1 && memberOnly.scope[0].value === 7, JSON.stringify(memberOnly.scope));
}

/* ------------------------- actor substitution -------------------------- */
{
  const p = createAccessPolicy([grant('member', 'orders', ['read'], OWN_ORDERS)]);

  const d = p.can(actor(['member'], { customerId: 42 }), 'orders', 'read');
  ok('a claim is substituted into the scope', d.allowed && d.scope[0].value === 42);
  ok('...keeping the column and operator', d.scope[0].column === 'customer_id' && d.scope[0].op === 'eq');

  // THE failure that makes row rules worse than none: dropping an unresolvable
  // predicate turns "your own orders" into "everyone's orders".
  const missing = p.can(actor(['member'], {}), 'orders', 'read');
  ok('a missing claim DENIES', !missing.allowed);
  ok('...rather than widening to every row', missing.scope.length === 0);
  ok('...and names the claim', /customerId/.test(missing.reason), missing.reason);

  ok('a null claim denies too', !p.can(actor(['member'], { customerId: null }), 'orders', 'read').allowed);
  ok('a zero claim is a real value', p.can(actor(['member'], { customerId: 0 }), 'orders', 'read').allowed);

  // $actor.userId resolves from the actor itself, not from claims.
  const byUser = createAccessPolicy([grant('member', 'posts', ['read'], [{ column: 'author_id', op: 'eq', value: '$actor.userId' }])]);
  const ud = byUser.can(actor(['member'], {}, 'user-9'), 'posts', 'read');
  ok('$actor.userId resolves', ud.allowed && ud.scope[0].value === 'user-9');
  ok('...and anonymous has none, so it denies', !byUser.can(PUBLIC_ACTOR, 'posts', 'read').allowed);

  // A literal value that merely looks odd is left alone.
  const literal = createAccessPolicy([grant('member', 'orders', ['read'], [{ column: 'status', op: 'eq', value: 'paid' }])]);
  ok('a non-$actor value passes through', literal.can(actor(['member']), 'orders', 'read').scope[0].value === 'paid');
}

/* ------------------ two restrictions cannot be ORed -------------------- */
{
  // The scope channel is AND-only, so a union of two different row filters is
  // inexpressible. Picking one would quietly be wrong in somebody's favour.
  const p = createAccessPolicy([
    grant('member', 'orders', ['read'], OWN_ORDERS),
    grant('rep', 'orders', ['read'], [{ column: 'rep_id', op: 'eq', value: '$actor.userId' }]),
  ]);
  const d = p.can(actor(['member', 'rep'], { customerId: 7 }), 'orders', 'read');
  ok('conflicting row filters refuse', !d.allowed);
  ok('...and the reason says how to fix it', /cannot be combined/.test(d.reason), d.reason);

  // Identical restrictions on two roles are not a conflict.
  const same = createAccessPolicy([
    grant('member', 'orders', ['read'], OWN_ORDERS),
    grant('vip', 'orders', ['read'], OWN_ORDERS),
  ]);
  ok('identical row filters are fine', same.can(actor(['member', 'vip'], { customerId: 3 }), 'orders', 'read').allowed);
}

/* ----------------------------- anonymous ------------------------------- */
{
  const p = createAccessPolicy([grant(PUBLIC_ROLE, 'posts', ['read'])]);
  ok('anonymous is a real actor with real grants', p.can(PUBLIC_ACTOR, 'posts', 'read').allowed);
  ok('...and is refused what public was not granted', !p.can(PUBLIC_ACTOR, 'posts', 'update').allowed);
  ok('...and cannot reach another table', !p.can(PUBLIC_ACTOR, 'users', 'read').allowed);
  ok('PUBLIC_ACTOR carries the public role', PUBLIC_ACTOR.roles.includes(PUBLIC_ROLE) && PUBLIC_ACTOR.userId === null);

  // Deny-by-default: a table nobody granted is invisible to everyone non-super.
  const empty = createAccessPolicy([]);
  ok('no grants at all means no access', !empty.can(actor(['member']), 'orders', 'read').allowed);
  ok('...for anonymous too', !empty.can(PUBLIC_ACTOR, 'posts', 'read').allowed);
}

/* ------------------------------ grantsFor ------------------------------ */
{
  const p = createAccessPolicy([
    grant('member', 'orders', ['read'], OWN_ORDERS),
    grant('support', 'orders', ['read']),
    grant('marketing', 'posts', ['read']),
  ]);
  ok('grantsFor lists only the actor\'s roles', p.grantsFor(actor(['member', 'marketing'])).length === 2);
  ok('...and none for a roleless actor', p.grantsFor(actor([])).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
