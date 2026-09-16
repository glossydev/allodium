/**
 * A DATE column crosses the wire as the string it is.
 *
 * The driver's default turns a DATE into a JS Date at midnight in the server's
 * zone, and JSON renders that in UTC — so on any server east of Greenwich the
 * 10th arrives in the browser as the 9th. A date has no instant to convert;
 * the resolver selects it as text on every read and every returning clause.
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

console.log('dates on the wire');

if (!process.env.DATABASE_URL) {
  console.log('\nskipped — no DATABASE_URL');
  process.exitCode = 0;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;
  try {
    const resolver = createViewResolver(pool, { access: 'unrestricted' });
    const def = { table: 'customers', fields: [{ column: 'id' }, { column: 'birth_date' }] };
    const [{ id, text }] = await raw('select id, birth_date::text as text from customers where birth_date is not null limit 1');
    ok('the fixture has a DATE to test with', typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text), String(text));

    const one = await resolver.read(def, id);
    ok('read() returns a DATE as its text', one?.birth_date === text, `${typeof one?.birth_date} ${String(one?.birth_date)}`);
    const many = await resolver.list(def, { pageSize: 200 });
    const listed = many.rows.find((r) => String(r.id) === String(id));
    ok('list() too', listed?.birth_date === text, String(listed?.birth_date));
    ok('...for every row', many.rows.every((r) => r.birth_date === null || /^\d{4}-\d{2}-\d{2}$/.test(String(r.birth_date))));

    // The returning clause on a write follows the same rule, and what the
    // date input sends ("YYYY-MM-DD") is stored as that day.
    const updated = await resolver.update(def, id, { birth_date: '1999-12-31' });
    ok('update() returns the DATE as text', updated.birth_date === '1999-12-31', String(updated.birth_date));
    ok('...and stored exactly that day', (await raw('select birth_date::text as t from customers where id = $1', [id]))[0].t === '1999-12-31');
    await resolver.update(def, id, { birth_date: text });
    ok('the date is not a Date', typeof (await resolver.read(def, id))?.birth_date === 'string');
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
