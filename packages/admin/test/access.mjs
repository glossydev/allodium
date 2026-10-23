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

    // A row-restricted CREATE is written and then checked: a row inside the grant
    // stays, a row outside it rolls back — the database never holds it.
    const restrictedCreate = createViewResolver(pool, {
      access: createAccessPolicy([grant('member', 'orders', ['create', 'read'], [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }])]),
    });
    const [{ n: ordersBefore }] = await raw('select count(*)::int as n from orders');
    const otherCustomer = (await raw('select id from customers where id is distinct from $1 limit 1', [customer.customer_id]))[0];
    ok('a row-restricted create refuses a row outside the grant',
      await refuses(() => restrictedCreate.create({ table: 'orders' }, { customer_id: otherCustomer.id, order_number: 'ACC-OUT', status: 'pending' }, member), /outside the rows you may create/));
    ok('...and the refused row was rolled back', (await raw('select count(*)::int as n from orders'))[0].n === ordersBefore);
    const madeRow = await restrictedCreate.create({ table: 'orders' }, { customer_id: customer.customer_id, order_number: 'ACC-IN', status: 'pending' }, member);
    ok('...while a row inside the grant is created', String(madeRow?.customer_id) === String(customer.customer_id), JSON.stringify(madeRow));
    await raw('delete from orders where id = $1', [madeRow.id]);

    // The WHERE on an update scopes the row as it WAS. The values can move it,
    // and a portal user must not be able to hand their row to another client.
    const mover = createViewResolver(pool, {
      access: createAccessPolicy([grant('member', 'orders', ['read', 'update'], [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }])]),
    });
    ok('an update that would move the row outside the grant is refused',
      await refuses(() => mover.update({ table: 'orders' }, own.id, { customer_id: otherCustomer.id }, member), /move the row outside/));
    ok('...and the row is untouched', String((await raw('select customer_id from orders where id = $1', [own.id]))[0].customer_id) === String(customer.customer_id));
    const noteBefore = (await raw('select notes from orders where id = $1', [own.id]))[0].notes;
    const kept = await mover.update({ table: 'orders' }, own.id, { notes: 'still mine' }, member);
    ok('...while an update that keeps it inside succeeds', kept?.notes === 'still mine');
    await raw('update orders set notes = $2 where id = $1', [own.id, noteBefore]);

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

    /* -------- the other table: pickers and labels are reads of it -------- */
    // orders.customer_id points at customers. A rep may read every order but
    // only ONE customer — theirs. The picker must offer that one, and the
    // orders list must label only that one; every other order's customer name
    // is a read of a row the rep was not granted.
    const ordersView = { table: 'orders', fields: [{ column: 'id' }, { kind: 'relation', column: 'customer_id', relation: { table: 'customers', display: 'full_name' } }, { column: 'total' }] };
    const [{ n: allCustomers }] = await raw('select count(*)::int as n from customers');
    const repActor = actor(['rep'], { customerId: customer.customer_id });
    const repPolicy = createViewResolver(pool, {
      access: createAccessPolicy([
        grant('rep', 'orders', ['read']),
        grant('rep', 'customers', ['read'], [{ column: 'id', op: 'eq', value: '$actor.customerId' }]),
        grant('blind', 'orders', ['read']),
      ]),
    });
    const picks = await repPolicy.options(ordersView, 'customer_id', { actor: repActor });
    ok('a picker offers only the rows the actor may read', picks.length === 1 && String(picks[0].value) === String(customer.customer_id), JSON.stringify(picks).slice(0, 120));
    ok('...which is fewer than the table holds', allCustomers > 1);
    ok('a picker with no grant on the target is refused', await refuses(() => repPolicy.options(ordersView, 'customer_id', { actor: actor(['blind']) })));
    ok('a picker without an actor is refused', await refuses(() => repPolicy.options(ordersView, 'customer_id'), /needs an actor/));
    const searched = await repPolicy.options(ordersView, 'customer_id', { actor: repActor, search: 'zzzz-no-such-name' });
    ok('the search ANDs with the scope rather than replacing it', searched.length === 0);

    const labelled = await repPolicy.list(ordersView, { actor: repActor, pageSize: 200 });
    ok('the list still returns every order the actor may read', labelled.total === allOrders);
    ok('...labelling only the customer they may read', labelled.rows.every((r) => (String(r.customer_id) === String(customer.customer_id)) === (r.customer_id__label !== null)), JSON.stringify(labelled.rows.slice(0, 3)));
    ok('...and the label is really a name, not the id', labelled.rows.some((r) => typeof r.customer_id__label === 'string' && r.customer_id__label !== String(r.customer_id)));
    const blindList = await repPolicy.list(ordersView, { actor: actor(['blind']), pageSize: 5 });
    ok('with no grant on the target, the label is absent, not the row', blindList.total === allOrders && blindList.rows.every((r) => !('customer_id__label' in r)));
    const blindRead = await repPolicy.read(ordersView, own.id, actor(['blind']));
    ok('...on a record too', blindRead !== null && !('customer_id__label' in blindRead) && 'customer_id' in blindRead);
    const repRead = await repPolicy.read(ordersView, own.id, repActor);
    ok('a record labels the customer the actor may read', typeof repRead?.customer_id__label === 'string');
    const otherRead = await repPolicy.read(ordersView, other.id, repActor);
    ok("...and not someone else's", otherRead !== null && otherRead.customer_id__label === null);
    // Sorting and searching by the label still work under a scope, and the
    // count query survives the bound parameters the join now carries.
    const sorted = await repPolicy.list(ordersView, { actor: repActor, sort: 'customer_id', direction: 'asc', pageSize: 3 });
    ok('sorting by a scoped label works', sorted.rows.length === 3 && sorted.total === allOrders);
    const found = await repPolicy.list({ ...ordersView, list: { searchColumns: ['customer_id'] } }, { actor: repActor, search: String(repRead.customer_id__label).split(' ')[0], pageSize: 200 });
    ok('searching a scoped label finds only what the actor may see', found.total > 0 && found.rows.every((r) => String(r.customer_id) === String(customer.customer_id)), `${found.total}`);
    ok('the console lane is unaffected', (await open.list(ordersView, { pageSize: 2 })).rows.every((r) => 'customer_id__label' in r));

    /* -------------- many-to-many membership follows the far table ------------- */
    // A post's tags are references into `tags`. No grant on tags: the key is
    // absent from the record. A row scope on tags: only the tags inside it.
    const postsView = { table: 'posts', fields: [{ column: 'id' }, { column: 'title' }, { kind: 'm2m', through: 'post_tags', near: 'post_id', far: 'tag_id', farTable: 'tags', display: 'label' }] };
    const tagged = (await raw('select post_id, count(*)::int as n from post_tags group by 1 order by 2 desc limit 1'))[0];
    const tagIds = (await raw('select tag_id from post_tags where post_id = $1 order by 1', [tagged.post_id])).map((r) => r.tag_id);
    ok('the fixture has a post with several tags', tagged.n >= 2, `${tagged.n}`);
    const m2mPolicy = createViewResolver(pool, {
      access: createAccessPolicy([
        grant('reader', 'posts', ['read']),
        grant('tagger', 'posts', ['read']),
        grant('tagger', 'tags', ['read']),
        grant('narrow', 'posts', ['read']),
        grant('narrow', 'tags', ['read'], [{ column: 'id', op: 'eq', value: tagIds[0] }]),
      ]),
    });
    const noTags = await m2mPolicy.read(postsView, tagged.post_id, actor(['reader']));
    ok('with no grant on the far table the membership is absent', noTags !== null && !('tags' in noTags), JSON.stringify(Object.keys(noTags ?? {})));
    const allTags = await m2mPolicy.read(postsView, tagged.post_id, actor(['tagger']));
    ok('with a grant on it the membership is complete', JSON.stringify((allTags?.tags ?? []).map(Number).sort((a, b) => a - b)) === JSON.stringify(tagIds.map(Number)), JSON.stringify(allTags?.tags));
    const someTags = await m2mPolicy.read(postsView, tagged.post_id, actor(['narrow']));
    ok('with a row scope on it the membership is narrowed', JSON.stringify(someTags?.tags?.map(Number)) === JSON.stringify([Number(tagIds[0])]), JSON.stringify(someTags?.tags));
    ok('the console lane sees every tag', (await open.read(postsView, tagged.post_id))?.tags?.length === tagged.n);

    /* ------------- a grant that reaches its owner through a hop ------------- */
    // order_items has no customer column: its owner is two tables away. A
    // grant may say so with a path through the foreign keys, and every read
    // path — list, read, update, the post-write check, labels, pickers — must
    // honour it the same way.
    const itemsView = { table: 'order_items', fields: [{ column: 'id' }, { kind: 'relation', column: 'order_id', relation: { table: 'orders', display: 'order_number' } }, { column: 'quantity' }] };
    const [{ n: myItems }] = await raw('select count(*)::int as n from order_items oi join orders o on o.id = oi.order_id where o.customer_id = $1', [customer.customer_id]);
    const [{ n: allItems }] = await raw('select count(*)::int as n from order_items');
    const hop = createViewResolver(pool, {
      access: createAccessPolicy([
        grant('member', 'order_items', ['read', 'update'], [{ column: 'order_id.customer_id', op: 'eq', value: '$actor.customerId' }]),
        grant('member', 'orders', ['read'], [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }]),
      ]),
    });
    const hopped = await hop.list(itemsView, { actor: member, pageSize: 1000 });
    ok("a path grant lists only the rows whose parent is the actor's", hopped.total === myItems && hopped.total < allItems, `${hopped.total} vs ${myItems} of ${allItems}`);
    ok('...labelling the parent, which is inside its own grant', hopped.rows.every((r) => typeof r.order_id__label === 'string'));
    const myItem = (await raw('select oi.id from order_items oi join orders o on o.id = oi.order_id where o.customer_id = $1 limit 1', [customer.customer_id]))[0];
    const otherItem = (await raw('select oi.id from order_items oi join orders o on o.id = oi.order_id where o.customer_id is distinct from $1 limit 1', [customer.customer_id]))[0];
    ok("a path grant reads the actor's row", (await hop.read(itemsView, myItem.id, member)) !== null);
    ok("...and someone else's reads as absent", (await hop.read(itemsView, otherItem.id, member)) === null);
    const qtyBefore = (await raw('select quantity from order_items where id = $1', [myItem.id]))[0].quantity;
    ok('a path grant scopes an update', (await hop.update(itemsView, myItem.id, { quantity: qtyBefore }, member)) !== null);
    ok("...refusing someone else's row as absent", await refuses(() => hop.update(itemsView, otherItem.id, { quantity: 1 }, member), /Row not found/));
    const otherOrder = (await raw('select id from orders where customer_id is distinct from $1 limit 1', [customer.customer_id]))[0];
    ok('re-parenting the row outside the path is refused', await refuses(() => hop.update(itemsView, myItem.id, { order_id: otherOrder.id }, member), /move the row outside/));
    ok('...and the row stayed where it was', String((await raw('select order_id from order_items where id = $1', [myItem.id]))[0].order_id) !== String(otherOrder.id));
    // Two hops: items → orders → customers → users. Not every fixture customer
    // has a user, so pick one that has both a user and orders rather than assume.
    const linked = (await raw('select c.id, c.user_id, count(o.id)::int as orders from customers c join orders o on o.customer_id = c.id where c.user_id is not null group by 1, 2 order by 3 desc limit 1'))[0];
    ok('the fixture has a customer with a user and orders', !!linked, 'two-hop cases need one');
    if (linked) {
      const self = { userId: linked.user_id, roles: ['self'], claims: {} };
      const [{ n: linkedItems }] = await raw('select count(*)::int as n from order_items oi join orders o on o.id = oi.order_id where o.customer_id = $1', [linked.id]);
      const two = createViewResolver(pool, {
        access: createAccessPolicy([grant('self', 'order_items', ['read'], [{ column: 'order_id.customer_id.user_id', op: 'eq', value: '$actor.userId' }])]),
      });
      const twoHop = await two.list(itemsView, { actor: self, pageSize: 1000 });
      ok('a two-hop path resolves through both foreign keys', twoHop.total === linkedItems && twoHop.total < allItems, `${twoHop.total} vs ${linkedItems}`);
      const pathPicker = createViewResolver(pool, {
        access: createAccessPolicy([grant('self', 'order_items', ['read']), grant('self', 'orders', ['read'], [{ column: 'customer_id.user_id', op: 'eq', value: '$actor.userId' }])]),
      });
      const picks3 = await pathPicker.options(itemsView, 'order_id', { actor: self });
      ok('a picker honours a path grant on its target', picks3.length === linked.orders, `${picks3.length} vs ${linked.orders}`);
      const labelled3 = await pathPicker.list(itemsView, { actor: self, pageSize: 1000 });
      const linkedIds = new Set((await raw('select oi.id from order_items oi join orders o on o.id = oi.order_id where o.customer_id = $1', [linked.id])).map((r) => String(r.id)));
      ok('a label honours a path grant on its target', labelled3.rows.every((r) => (r.order_id__label !== null) === linkedIds.has(String(r.id))));
    }
    const badHop = (filter) => createViewResolver(pool, { access: createAccessPolicy([grant('member', 'order_items', ['read'], filter)]) });
    ok('a path through a column that is not a foreign key is refused', await refuses(() => badHop([{ column: 'quantity.customer_id', op: 'eq', value: 1 }]).list(itemsView, { actor: member }), /is not a foreign key/));
    ok('a path ending at a column that does not exist is refused', await refuses(() => badHop([{ column: 'order_id.nope', op: 'eq', value: 1 }]).list(itemsView, { actor: member }), /does not exist/));
    ok('a path through a table that does not exist is refused', await refuses(() => badHop([{ column: 'order_id.customer_id.nope.x', op: 'eq', value: 1 }]).list(itemsView, { actor: member }), /Not permitted/));
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
