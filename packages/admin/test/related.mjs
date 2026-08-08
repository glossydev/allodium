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
