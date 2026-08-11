/**
 * The gate, enforced.
 *
 * `@allodium/auth` decides; this proves the resolver OBEYS — including the parts
 * where obeying is not the obvious code. A refusal must not look like an empty
 * result, a row outside a grant must not be distinguishable from a row that does
 * not exist, and a granted predicate this layer cannot compile must deny rather
 * than be skipped, because skipping widens the grant to every row.
 *
 * It also guards the seam: auth declares GrantPredicate and admin declares
 * Predicate, structurally identical and deliberately not imported from one
 * another. That is a format declared twice, which this repo has been bitten by
 * three times, so the compatibility is asserted rather than assumed.
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import { Pool } from 'pg';
import { createViewResolver } from '../dist/server/index.js';
import { createAccessPolicy, PUBLIC_ACTOR } from '../../auth/dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const refuses = async (fn, re = /Not permitted/) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(String(e.message ?? e));
  }
};

console.log('gate enforcement');

if (!process.env.DATABASE_URL) {
  console.log('\nskipped — no DATABASE_URL');
  process.exitCode = 0;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;

  const grant = (role, table, actions, rowFilter) => ({
    role, table,
    create: actions.includes('create'), read: actions.includes('read'),
    update: actions.includes('update'), delete: actions.includes('delete'),
    ...(rowFilter ? { rowFilter } : {}),
  });
  const actor = (roles, claims = {}) => ({ userId: 'u1', roles, claims });

  try {
    const customer = (await raw('select customer_id, count(*)::int as n from orders group by 1 order by 2 desc limit 1'))[0];
    const [{ n: allOrders }] = await raw('select count(*)::int as n from orders');

    /* ------------------------ unrestricted is opt-in ------------------- */
    const open = createViewResolver(pool, { access: 'unrestricted' });
    ok("'unrestricted' needs no actor", (await open.list({ table: 'orders' })).total === allOrders);

    /* --------------------------- refusal ------------------------------- */
    const policy = createAccessPolicy([
      grant('member', 'orders', ['read'], [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }]),
      grant('support', 'orders', ['read', 'update', 'delete']),
      grant('support', 'customers', ['read']),
    ]);
    const gated = createViewResolver(pool, { access: policy });

    ok('a missing actor is refused, not defaulted', await refuses(() => gated.list({ table: 'orders' }), /needs an actor/));
    ok('an ungranted table is refused', await refuses(() => gated.list({ table: 'users' }, { actor: actor(['support']) })));
    ok('...and the refusal explains', await refuses(() => gated.list({ table: 'users' }, { actor: actor(['support']) }), /no grant for read on users/));
    ok('anonymous is refused what public was not granted', await refuses(() => gated.list({ table: 'orders' }, { actor: PUBLIC_ACTOR })));

    // A refusal must THROW, never come back as a legitimate empty page.
    let looksEmpty = false;
    try {
      const r = await gated.list({ table: 'users' }, { actor: actor(['support']) });
      looksEmpty = r.total === 0;
    } catch {}
    ok('a refusal is never an empty result set', !looksEmpty);

    /* ------------------------ row scoping on list ---------------------- */
    const member = actor(['member'], { customerId: customer.customer_id });
    const mine = await gated.list({ table: 'orders' }, { actor: member, pageSize: 200 });
    ok('a member sees only their own orders', mine.total === customer.n, `${mine.total} vs ${customer.n}`);
    ok('...which is fewer than all of them', mine.total < allOrders);
    ok('...and every row really is theirs', mine.rows.every((r) => String(r.customer_id) === String(customer.customer_id)));

    const support = actor(['support']);
    ok('an unrestricted grant sees all', (await gated.list({ table: 'orders' }, { actor: support })).total === allOrders);

    // Holding both roles raises reach rather than lowering it.
    const both = actor(['member', 'support'], { customerId: customer.customer_id });
    ok('a second role widens, never narrows', (await gated.list({ table: 'orders' }, { actor: both })).total === allOrders);

    // The claim that is missing must deny, not widen — through the resolver too.
    ok('a member with no claim is refused', await refuses(() => gated.list({ table: 'orders' }, { actor: actor(['member']) }), /carries no "customerId" claim/));

    /* --------- the grant survives the operator's own filters ----------- */
    const narrowed = await gated.list(
      { table: 'orders' },
      { actor: member, filters: [{ column: 'total', op: 'gt', value: 0 }], pageSize: 200 }
    );
    ok('an operator filter ANDs with the grant, never replaces it', narrowed.rows.every((r) => String(r.customer_id) === String(customer.customer_id)));
    ok('...and cannot widen past it', narrowed.total <= mine.total);

    // A grant restricting a column the VIEW does not expose still applies —
    // hiding a column must never widen who can see the row.
    const hidden = { table: 'orders', fields: [{ column: 'id' }, { column: 'total' }] };
    const hiddenList = await gated.list(hidden, { actor: member, pageSize: 200 });
    ok('a grant on a column the view hides still applies', hiddenList.total === customer.n, `${hiddenList.total} vs ${customer.n}`);

    /* ---------------------------- read --------------------------------- */
    const own = (await raw('select id from orders where customer_id = $1 limit 1', [customer.customer_id]))[0];
    const other = (await raw('select id from orders where customer_id is distinct from $1 limit 1', [customer.customer_id]))[0];

    ok('a member reads their own order', (await gated.read({ table: 'orders' }, own.id, member)) !== null);
    ok("...and someone else's reads as ABSENT, not forbidden", (await gated.read({ table: 'orders' }, other.id, member)) === null);
    ok('support reads any order', (await gated.read({ table: 'orders' }, other.id, support)) !== null);
    ok('read without an actor is refused', await refuses(() => gated.read({ table: 'orders' }, own.id), /needs an actor/));

    /* --------------------------- writes -------------------------------- */
    ok('update is refused without the grant', await refuses(() => gated.update({ table: 'orders' }, own.id, { notes: 'x' }, member)));
    ok('delete is refused without the grant', await refuses(() => gated.remove({ table: 'orders' }, own.id, member)));
    ok('create is refused without the grant', await refuses(() => gated.create({ table: 'orders' }, { customer_id: 1 }, member)));

    // A row-restricted CREATE cannot be verified on insert, and says so.
    const restrictedCreate = createViewResolver(pool, {
      access: createAccessPolicy([grant('member', 'orders', ['create'], [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }])]),
    });
    ok('a row-restricted create refuses with a reason',
      await refuses(() => restrictedCreate.create({ table: 'orders' }, { customer_id: 1 }, member), /cannot be verified on insert/));

    // Support may update; the scope on a granted update stops at other rows.
    const scopedUpdater = createViewResolver(pool, {
      access: createAccessPolicy([grant('rep', 'orders', ['update'], [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }])]),
    });
    const rep = actor(['rep'], { customerId: customer.customer_id });
    const beforeNote = (await raw('select notes from orders where id = $1', [other.id]))[0]?.notes ?? null;
    ok("updating someone else's row reports not found", await refuses(() => scopedUpdater.update({ table: 'orders' }, other.id, { notes: 'tampered' }, rep), /Row not found/));
    const afterNote = (await raw('select notes from orders where id = $1', [other.id]))[0]?.notes ?? null;
    ok('...and really did not write', String(beforeNote) === String(afterNote));

    /* ------------- the seam: auth's predicates compile here ------------- */
    // Every operator auth can emit must be one this layer can compile. A grant
    // using anything else DENIES rather than being silently dropped.
    const weird = createViewResolver(pool, {
      access: createAccessPolicy([grant('member', 'orders', ['read'], [{ column: 'customer_id', op: 'approximately', value: 1 }])]),
    });
    ok('an uncompilable grant operator denies', await refuses(() => weird.list({ table: 'orders' }, { actor: member }), /unsupported comparison/));

    const ghostCol = createViewResolver(pool, {
      access: createAccessPolicy([grant('member', 'orders', ['read'], [{ column: 'not_a_column', op: 'eq', value: 1 }])]),
    });
    ok('a grant on a non-existent column denies', await refuses(() => ghostCol.list({ table: 'orders' }, { actor: member }), /does not exist/));

    // And the ops auth actually produces all work end to end.
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']) {
      const value = op === 'in' ? [customer.customer_id] : customer.customer_id;
      const p = createViewResolver(pool, { access: createAccessPolicy([grant('m', 'orders', ['read'], [{ column: 'customer_id', op, value }])]) });
      let worked = true;
      try { await p.list({ table: 'orders' }, { actor: actor(['m']), pageSize: 1 }); } catch { worked = false; }
      ok(`auth's "${op}" compiles in the resolver`, worked);
    }
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
