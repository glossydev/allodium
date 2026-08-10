/**
 * Related lists — the inbound direction of a foreign key.
 *
 * Two things are worth proving here and neither is visible by reading. First
 * that the catalog really answers "what points at me", because nothing on
 * `customers` mentions `orders` and the whole feature rests on that query.
 * Second that a panel which does NOT correspond to a real key is dropped with a
 * reason: an unchecked panel renders an empty list, and "no orders" is a very
 * convincing way to be wrong.
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import { Pool } from 'pg';
import { createViewResolver } from '../dist/server/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('related lists');

if (!process.env.DATABASE_URL) {
  console.log('\nskipped — no DATABASE_URL');
  process.exitCode = 0;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const resolver = createViewResolver(pool);
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;

  try {
    /* ------------------------- introspection ------------------------- */
    const customers = await resolver.introspector.table('customers');
    const inbound = customers.referencedBy;
    ok('customers knows orders points at it', inbound.some((r) => r.table === 'orders' && r.column === 'customer_id'), JSON.stringify(inbound));
    ok('and it records which column is referenced', inbound.find((r) => r.table === 'orders').references === 'id');

    // Nothing on the customers table itself says "orders" — that is the point.
    ok('no outbound column could have told us', !customers.columns.some((c) => c.fk?.table === 'orders'));

    const orders = await resolver.introspector.table('orders');
    ok('orders still knows its own outbound key', orders.columns.some((c) => c.name === 'customer_id' && c.fk?.table === 'customers'));

    // A table with many inbound keys resolves all of them.
    const users = await resolver.introspector.table('users');
    ok('users has several inbound keys', users.referencedBy.length >= 2, JSON.stringify(users.referencedBy));

    /* --------------------------- resolving --------------------------- */
    const def = {
      table: 'customers',
      related: [{ table: 'orders', foreignKey: 'customer_id', title: 'Orders', pageSize: 5 }],
    };
    const view = await resolver.resolve(def);
    ok('the panel resolves', view.related.length === 1);
    ok('key is table.column', view.related[0].key === 'orders.customer_id');
    ok('references defaults to the referenced column', view.related[0].references === 'id');
    ok('view defaults to the table name', (await resolver.resolve({ table: 'customers', related: [{ table: 'orders', foreignKey: 'customer_id' }] })).related[0].view === 'orders');
    ok('title defaults to the humanized table', (await resolver.resolve({ table: 'customers', related: [{ table: 'orders', foreignKey: 'customer_id' }] })).related[0].title === 'Orders');
    ok('pageSize defaults to 5', (await resolver.resolve({ table: 'customers', related: [{ table: 'orders', foreignKey: 'customer_id' }] })).related[0].pageSize === 5);
    ok('no warnings for a valid panel', view.warnings.length === 0, JSON.stringify(view.warnings));

    /* ------------------------ refusing nonsense ---------------------- */
    const notAKey = await resolver.resolve({ table: 'customers', related: [{ table: 'orders', foreignKey: 'id' }] });
    ok('a column that is not a key here is dropped', notAKey.related.length === 0);
    ok('...and the warning names the keys that DO point here', notAKey.warnings.some((w) => w.includes('orders.customer_id')), JSON.stringify(notAKey.warnings));

    const noTable = await resolver.resolve({ table: 'customers', related: [{ table: 'nope', foreignKey: 'x' }] });
    ok('an unknown table is dropped with a reason', noTable.related.length === 0 && noTable.warnings.some((w) => w.includes('does not exist')));

    const noColumn = await resolver.resolve({ table: 'customers', related: [{ table: 'orders', foreignKey: 'nope' }] });
    ok('an unknown column is dropped with a reason', noColumn.related.length === 0 && noColumn.warnings.some((w) => w.includes('no column')));

    // Pointing at an unrelated table entirely.
    const wrongWay = await resolver.resolve({ table: 'customers', related: [{ table: 'posts', foreignKey: 'author_id' }] });
    ok('a key pointing at someone ELSE is dropped', wrongWay.related.length === 0, JSON.stringify(wrongWay.related));

    // A join table has a composite primary key, so nothing addresses one of its
    // rows — and its rows are pairs of ids nobody wanted anyway. This is the
    // case a blog hits immediately: posts ← post_tags.
    const joinPanel = await resolver.resolve({
      table: 'posts',
      related: [
        { table: 'post_tags', foreignKey: 'post_id' },
        { table: 'comments', foreignKey: 'post_id' },
      ],
    });
    // Both are kept now: a composite key costs the record screen, not the list.
    ok('a join-table panel is kept', joinPanel.related.some((r) => r.table === 'post_tags'), JSON.stringify(joinPanel.related.map((r) => r.key)));
    ok('...alongside the ordinary one', joinPanel.related.some((r) => r.table === 'comments'));
    ok('...and neither warns', joinPanel.warnings.length === 0, JSON.stringify(joinPanel.warnings));

    const dupe = await resolver.resolve({
      table: 'customers',
      related: [
        { table: 'orders', foreignKey: 'customer_id' },
        { table: 'orders', foreignKey: 'customer_id' },
      ],
    });
    ok('a duplicate panel warns', dupe.warnings.some((w) => w.includes('twice')));

    /* ------------- the panel is a bound list, not a new query --------- */
    // What the client will actually request for one customer.
    const someone = (await raw('select customer_id, count(*)::int as n from orders group by 1 order by 2 desc limit 1'))[0];
    const bound = await resolver.list({ table: 'orders' }, { filters: [{ column: 'customer_id', op: 'eq', value: someone.customer_id }], pageSize: 5 });
    ok('the bound list returns that customer\'s orders', bound.total === someone.n, `${bound.total} vs ${someone.n}`);
    ok('and pages like any other list', bound.rows.length === Math.min(5, bound.total));
    ok('every row really belongs to the parent', bound.rows.every((r) => String(r.customer_id) === String(someone.customer_id)));

    // A customer with no orders gets an empty panel, not everyone's orders —
    // the failure mode if a bound scope were ever dropped.
    const orphan = (await raw('select id from customers c where not exists (select 1 from orders o where o.customer_id = c.id) limit 1'))[0];
    if (orphan) {
      const empty = await resolver.list({ table: 'orders' }, { filters: [{ column: 'customer_id', op: 'eq', value: orphan.id }] });
      ok('a parent with no children gets an empty panel', empty.total === 0, `${empty.total}`);
    }

    /* ------------ join tables: listable, just not addressable ---------- */
    const jt = await resolver.resolve({ table: 'post_tags' });
    ok('a composite-key table resolves', jt.table === 'post_tags');
    ok('...with a null primary key', jt.primaryKey === null);
    ok('...and still sorts by something', !!jt.list.sort.column);

    const jtRows = await resolver.list({ table: 'post_tags' }, { scope: [{ column: 'post_id', op: 'eq', value: 1 }] });
    const [{ n: jtN }] = await raw('select count(*)::int as n from post_tags where post_id = 1');
    ok('and its rows list', jtRows.total === jtN && jtRows.total > 0, `${jtRows.total} vs ${jtN}`);

    for (const [verb, call] of [
      ['read', () => resolver.read({ table: 'post_tags' }, 1)],
      ['update', () => resolver.update({ table: 'post_tags' }, 1, { tag_id: 2 })],
      ['remove', () => resolver.remove({ table: 'post_tags' }, 1)],
      ['create', () => resolver.create({ table: 'post_tags' }, { post_id: 1, tag_id: 2 })],
    ]) {
      let refused = false;
      try { await call(); } catch (e) { refused = /cannot be addressed/.test(String(e)); }
      ok(`${verb} refuses with a reason`, refused);
    }

    // The panel a blog actually wanted: a post's tags, by name.
    const named = {
      table: 'post_tags',
      fields: [
        { kind: 'relation', column: 'post_id', relation: { table: 'posts', value: 'id', display: 'title' } },
        { kind: 'relation', column: 'tag_id', relation: { table: 'tags', value: 'id', display: 'label' } },
      ],
    };
    const byName = await resolver.list(named, { scope: [{ column: 'post_id', op: 'eq', value: 1 }] });
    const labels = byName.rows.map((r) => r.tag_id__label).sort();
    const expected = (await raw('select t.label from post_tags pt join tags t on t.id = pt.tag_id where pt.post_id = 1 order by 1')).map((r) => r.label);
    ok('a post\'s tags render as names', JSON.stringify(labels) === JSON.stringify(expected), JSON.stringify(labels));

    // posts -> post_tags is no longer dropped.
    const postsView = await resolver.resolve({ table: 'posts', related: [{ table: 'post_tags', foreignKey: 'post_id' }] });
    ok('a join-table panel is now kept', postsView.related.some((r) => r.table === 'post_tags'));
    ok('...with no warning', postsView.warnings.length === 0, JSON.stringify(postsView.warnings));

    /* ---- scope is checked against the TABLE, filters against fields ---- */
    // A curated panel view omits the key it is bound by — repeating the parent
    // down every row is noise — and the panel must still work.
    const curated = { table: 'post_tags', fields: [{ column: 'tag_id' }] };
    const scoped = await resolver.list(curated, { scope: [{ column: 'post_id', op: 'eq', value: 1 }] });
    ok('scope works on a column the view does not expose', scoped.total === jtN, `${scoped.total} vs ${jtN}`);

    let filterRefused = false;
    try { await resolver.list(curated, { filters: [{ column: 'post_id', op: 'eq', value: 1 }] }); }
    catch (e) { filterRefused = /not a field/.test(String(e)); }
    ok('...while an operator FILTER on it is still refused', filterRefused);

    let scopeUnknown = false;
    try { await resolver.list(curated, { scope: [{ column: 'nope', op: 'eq', value: 1 }] }); }
    catch (e) { scopeUnknown = /no such column/.test(String(e)); }
    ok('a scope on a non-existent column is refused', scopeUnknown);

    let scopeMasked = false;
    try { await resolver.list({ table: 'users' }, { scope: [{ column: 'password_hash', op: 'eq', value: 'x' }] }); }
    catch (e) { scopeMasked = /masked/.test(String(e)); }
    ok('a scope on a masked column is refused', scopeMasked);

    /* --------------- a self-referencing key is legitimate ------------- */
    const selfRef = (await raw(`
      select c.relname as t, a.attname as col
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_class cf on cf.oid = con.confrelid
        cross join lateral unnest(con.conkey, con.confkey) with ordinality k(attnum, fattnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
       where con.contype = 'f' and c.relname = cf.relname and array_length(con.conkey,1) = 1
       limit 1`))[0];
    if (selfRef) {
      const meta = await resolver.introspector.table(selfRef.t);
      ok('a self-referencing key is reported as inbound too', meta.referencedBy.some((r) => r.table === selfRef.t && r.column === selfRef.col),
        `${selfRef.t}.${selfRef.col}`);
    }
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
