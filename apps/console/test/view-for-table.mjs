/**
 * How a related panel finds the screen to render.
 *
 * The bug this pins: a panel addressed `post_tags` (a table, validated against
 * the catalog) but resolved a view by FILE NAME, and a file called
 * `post_tags.view.json` happened to contain a view of `tags`. The lookup
 * succeeded, the screen rendered the wrong table, and the first bound filter
 * failed with "Cannot filter on post_id" — a 404 traded for a 400.
 *
 * Files are named by hand and tables are named by the schema; nothing keeps the
 * two in step, so the TABLE decides and the name only breaks ties.
 *
 * Runs against a temporary views directory — no database needed.
 */
import { pickViewForTable } from '../lib/view-for-table.ts';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
console.log('related panel → view resolution');

// The exact shape that broke: the filename says post_tags, the content says tags.
const misnamed = { name: 'post_tags', definition: { table: 'tags', fields: [{ column: 'id' }, { column: 'label' }] } };

{
  const got = pickViewForTable(misnamed.definition, [misnamed], 'post_tags');
  ok('a file whose table does not match is NOT used', got.table === 'post_tags', `got table=${got.table}`);
  ok('...and the fallback is the implicit screen', got.fields === undefined);
}

{
  // A view genuinely about the table wins, whatever it is called.
  const other = { name: 'the-tags-of-posts', definition: { table: 'post_tags', fields: [{ column: 'post_id' }] } };
  const got = pickViewForTable(misnamed.definition, [misnamed, other], 'post_tags');
  ok('a view about the table is found under any filename', got.table === 'post_tags' && got.fields?.length === 1);
}

{
  // A file named after the table wins over one that merely covers it.
  const byName = { name: 'post_tags', definition: { table: 'post_tags', fields: [{ column: 'post_id' }, { column: 'tag_id' }] } };
  const other = { name: 'zzz', definition: { table: 'post_tags', fields: [{ column: 'post_id' }] } };
  const got = pickViewForTable(null, [other, byName], 'post_tags');
  ok('a file named after the table is preferred', got.fields?.length === 2, JSON.stringify(got.fields));
}

{
  // No view at all is not an error — it is the default screen.
  const got = pickViewForTable(null, [], 'comments');
  ok('no view yet resolves to the implicit screen', got.table === 'comments' && got.fields === undefined);
}

{
  // An explicitly named view that IS about the table is honoured as-is.
  const unpaid = { name: 'unpaid', definition: { table: 'orders', title: 'Unpaid', fields: [{ column: 'id' }] } };
  ok('an explicit view about the right table is used', pickViewForTable(unpaid.definition, [unpaid], 'orders').title === 'Unpaid');

  // ...and one that is not about the table is ignored in favour of the table.
  const wrong = pickViewForTable(unpaid.definition, [unpaid], 'comments');
  ok('an explicit view about the WRONG table is ignored', wrong.table === 'comments' && wrong.title === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
