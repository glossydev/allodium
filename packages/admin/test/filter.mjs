/**
 * The predicate shape, end to end against a real Postgres.
 *
 * The pure parts (normalising, validating) could be checked anywhere, but the
 * parts worth being afraid of are all SQL: whether a "greater than 500" filter
 * compares numbers or text, whether excluding one email also excludes every row
 * with no email, whether adding a filter renumbers the search parameter out from
 * under itself. None of those show up without a database, so this runs against
 * the dev container the same way the auth battery does.
 *
 * Skips (exit 0) when DATABASE_URL is unset — the pure checks still run.
 */
import { Pool } from 'pg';
import {
  normalizeFilter,
  validateFilter,
  validateViewDefinition,
  FILTER_OPS,
} from '../dist/view.js';
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

console.log('filters');

/* ---------------------------- normalising ---------------------------- */
{
  const eq = normalizeFilter({ archived: false });
  ok('shorthand becomes eq', eq.length === 1 && eq[0].op === 'eq' && eq[0].column === 'archived' && eq[0].value === false);

  const nul = normalizeFilter({ deleted_at: null });
  ok('shorthand null becomes isNull, not = null', nul[0].op === 'isNull');

  const arr = normalizeFilter({ status: ['active', 'invited'] });
  ok('shorthand array becomes in', arr[0].op === 'in');

  const explicit = normalizeFilter([{ column: 'total', op: 'gt', value: 500 }]);
  ok('array form survives', explicit[0].op === 'gt' && explicit[0].value === 500);

  ok('undefined is empty', normalizeFilter(undefined).length === 0);
  ok('every operator is normalisable', FILTER_OPS.every((op) => normalizeFilter([{ column: 'c', op, value: op === 'in' ? [1] : 1 }])[0].op === op));
}

/* ---------------------------- validating ----------------------------- */
{
  ok('good filter passes', validateFilter([{ column: 'a', op: 'gt', value: 1 }], 'f').length === 0);
  ok('unknown operator rejected', validateFilter([{ column: 'a', op: 'roughly', value: 1 }], 'f').length === 1);
  ok('missing column rejected', validateFilter([{ op: 'eq', value: 1 }], 'f').length === 1);
  ok('in without array rejected', validateFilter([{ column: 'a', op: 'in', value: 1 }], 'f').length === 1);
  ok('array on a scalar op rejected', validateFilter([{ column: 'a', op: 'eq', value: [1, 2] }], 'f').length === 1);
  ok('isNull with a value rejected', validateFilter([{ column: 'a', op: 'isNull', value: 3 }], 'f').length === 1);
  ok('isNull without a value passes', validateFilter([{ column: 'a', op: 'isNull' }], 'f').length === 0);
  ok('shorthand always passes', validateFilter({ a: 1, b: null, c: ['x'] }, 'f').length === 0);

  const bad = validateViewDefinition({ table: 't', list: { filter: [{ op: 'eq', value: 1 }] } });
  ok('a bad list.filter fails the whole definition', bad.ok === false && bad.problems[0].path.startsWith('list.filter'));

  const badRel = validateViewDefinition({
    table: 't',
    fields: [{ kind: 'relation', column: 'c', relation: { table: 'o', filter: [{ column: 'x', op: 'nope' }] } }],
  });
  ok('a bad relation.filter fails too', badRel.ok === false && badRel.problems.some((p) => p.path.includes('relation.filter')));
}

if (!process.env.DATABASE_URL) {
  console.log(`\n${pass} passed, ${fail} failed  (SQL checks skipped — no DATABASE_URL)`);
  process.exit(fail ? 1 : 0);
}

/* ------------------------------- the SQL ------------------------------ */
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const resolver = createViewResolver(pool);
const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;

try {
  const view = (filter) => ({ table: 'orders', list: filter ? { filter } : undefined });

  // Baseline: no filter at all.
  const all = await resolver.list(view(), { pageSize: 1 });
  const [{ n: allN }] = await raw('select count(*)::int as n from orders');
  ok('unfiltered total matches the table', all.total === allN, `${all.total} vs ${allN}`);

  // The '9' > '500' trap: a text comparison would return a different set.
  const gt = await resolver.list(view([{ column: 'total', op: 'gt', value: 500 }]), { pageSize: 1 });
  const [{ n: gtN }] = await raw('select count(*)::int as n from orders where total > 500');
  const [{ n: textN }] = await raw("select count(*)::int as n from orders where total::text > '500'");
  ok('gt compares numerically', gt.total === gtN, `${gt.total} vs ${gtN}`);
  ok('gt is NOT a text comparison', gtN === textN || gt.total !== textN, `numeric=${gtN} text=${textN}`);

  const lte = await resolver.list(view([{ column: 'total', op: 'lte', value: 100 }]), { pageSize: 1 });
  const [{ n: lteN }] = await raw('select count(*)::int as n from orders where total <= 100');
  ok('lte matches raw SQL', lte.total === lteN);

  // Two predicates AND together.
  const both = await resolver.list(view([
    { column: 'total', op: 'gt', value: 100 },
    { column: 'total', op: 'lt', value: 500 },
  ]), { pageSize: 1 });
  const [{ n: bothN }] = await raw('select count(*)::int as n from orders where total > 100 and total < 500');
  ok('predicates AND', both.total === bothN, `${both.total} vs ${bothN}`);

  // ne must not silently drop NULL rows.
  // A text column specifically: comparing a string against a jsonb column is a
  // cast error, and that would be testing pg's type system rather than this code.
  const nullable = (await raw(`
    select column_name from information_schema.columns
    where table_name = 'orders' and is_nullable = 'YES'
      and data_type in ('character varying', 'text') limit 1`))[0]?.column_name;
  if (nullable) {
    const [{ n: nulls }] = await raw(`select count(*)::int as n from orders where "${nullable}" is null`);
    const ne = await resolver.list(view([{ column: nullable, op: 'ne', value: '__nothing_matches__' }]), { pageSize: 1 });
    ok('ne keeps NULL rows (is distinct from, not <>)', ne.total === allN, `kept ${ne.total} of ${allN}, ${nulls} are null`);
  }

  // isNull / notNull partition the table.
  if (nullable) {
    const isN = await resolver.list(view([{ column: nullable, op: 'isNull' }]), { pageSize: 1 });
    const notN = await resolver.list(view([{ column: nullable, op: 'notNull' }]), { pageSize: 1 });
    ok('isNull + notNull partition the table', isN.total + notN.total === allN, `${isN.total}+${notN.total} vs ${allN}`);
  }

  // in, and the empty case that would be a syntax error unguarded.
  const ids = (await raw('select id from orders order by id limit 3')).map((r) => r.id);
  const inList = await resolver.list(view([{ column: 'id', op: 'in', value: ids }]), { pageSize: 10 });
  ok('in matches exactly the listed rows', inList.total === ids.length, `${inList.total} vs ${ids.length}`);
  const inNone = await resolver.list(view([{ column: 'id', op: 'in', value: [] }]), { pageSize: 1 });
  ok('in [] matches nothing rather than erroring', inNone.total === 0);

  // A filter and a search together — the parameter numbering bug this would hit.
  const users = { table: 'users', list: { searchColumns: ['email'], filter: [{ column: 'status', op: 'eq', value: 'active' }] } };
  const combo = await resolver.list(users, { search: 'a', pageSize: 1 });
  const [{ n: comboN }] = await raw("select count(*)::int as n from users where status = 'active' and email::text ilike '%a%'");
  ok('filter + search AND together with correct params', combo.total === comboN, `${combo.total} vs ${comboN}`);

  // contains works on a non-text column — the cast is what makes that legal.
  const contains = await resolver.list(view([{ column: 'id', op: 'contains', value: '1' }]), { pageSize: 1 });
  const [{ n: containsN }] = await raw("select count(*)::int as n from orders where id::text ilike '%1%'");
  ok('contains works on a numeric column', contains.total === containsN);

  // The resolved view exposes its baseline, so a UI can disclose what it hid.
  const resolved = await resolver.resolve(view([{ column: 'total', op: 'gt', value: 500 }]));
  ok('resolved view exposes the filter', resolved.list.filter.length === 1 && resolved.list.filter[0].op === 'gt');

  // A filter naming something that is not a field warns instead of vanishing.
  const warned = await resolver.resolve(view([{ column: 'not_a_column', op: 'eq', value: 1 }]));
  ok('unknown filter column warns', warned.warnings.some((w) => w.includes('not_a_column')));

  /* --------------------- relation.filter (was a no-op) -------------------- */
  const rel = (filter) => ({
    table: 'orders',
    fields: [
      { column: 'id' },
      { kind: 'relation', column: 'customer_id', relation: { table: 'customers', display: 'full_name', ...(filter ? { filter } : {}) } },
    ],
  });

  const allOpts = await resolver.options(rel(), 'customer_id');
  const firstName = allOpts[0]?.label;

  const filtered = await resolver.options(rel({ full_name: firstName }), 'customer_id');
  ok('relation.filter actually restricts options', allOpts.length > filtered.length && filtered.every((o) => o.label === firstName),
    `${allOpts.length} -> ${filtered.length}`);

  const ranged = await resolver.options(rel([{ column: 'id', op: 'lte', value: 5 }]), 'customer_id');
  const [{ n: rangedN }] = await raw('select count(*)::int as n from customers where id <= 5');
  ok('relation.filter takes operators too', ranged.length === rangedN, `${ranged.length} vs ${rangedN}`);

  // Filter AND search, not one replacing the other.
  const both2 = await resolver.options(rel([{ column: 'id', op: 'lte', value: 5 }]), 'customer_id', firstName);
  ok('relation.filter and the option search combine', both2.length <= ranged.length && both2.every((o) => o.label === firstName));

  // The skip path: a predicate naming a column the target lacks must warn, not
  // silently widen the option list back to everything.
  const bogus = await resolver.resolve(rel({ name: 'nope' }));
  ok('a relation filter on a missing column warns', bogus.warnings.some((w) => w.includes('name') && w.includes('customers')),
    JSON.stringify(bogus.warnings));

  /* ------------------- sortable / filterable / FK reach ------------------ */

  // Sorting a relation must order by the NAME on screen, not the foreign key.
  const byCustomer = await resolver.list(rel(), { sort: 'customer_id', direction: 'asc', pageSize: 5 });
  const labels = byCustomer.rows.map((r) => r.customer_id__label).filter((x) => x != null);
  const sortedLabels = [...labels].sort((a, b) => String(a).localeCompare(String(b)));
  ok('sorting a relation orders by the displayed label', JSON.stringify(labels) === JSON.stringify(sortedLabels),
    JSON.stringify(labels.slice(0, 3)));

  const byFk = await resolver.list(rel(), { sort: 'customer_id', direction: 'asc', pageSize: 200 });
  const fkOrder = byFk.rows.map((r) => r.customer_id);
  const fkSorted = [...fkOrder].sort((a, b) => Number(a) - Number(b));
  ok('...which is NOT the same as ordering by the foreign key', JSON.stringify(fkOrder) !== JSON.stringify(fkSorted));

  // sortable:false is honoured, and falls back rather than erroring.
  const noSort = {
    table: 'orders',
    fields: [{ column: 'id' }, { column: 'total', sortable: false }],
    list: { sort: { column: 'id', direction: 'asc' } },
  };
  const attempted = await resolver.list(noSort, { sort: 'total', direction: 'asc', pageSize: 5 });
  const fellBack = attempted.rows.map((r) => r.id);
  ok('sortable:false falls back to the default sort', JSON.stringify(fellBack) === JSON.stringify([...fellBack].sort((a, b) => Number(a) - Number(b))));
  const resolvedFlags = await resolver.resolve(noSort);
  ok('flags default to true', resolvedFlags.fields.find((f) => f.key === 'id').sortable === true);
  ok('sortable:false is resolved', resolvedFlags.fields.find((f) => f.key === 'total').sortable === false);

  // filterable:false REFUSES an operator filter rather than ignoring it.
  const noFilter = { table: 'orders', fields: [{ column: 'id' }, { column: 'total', filterable: false }] };
  let refused = false;
  try {
    await resolver.list(noFilter, { filters: [{ column: 'total', op: 'gt', value: 1 }] });
  } catch (e) {
    refused = /not filterable/.test(String(e));
  }
  ok('filterable:false refuses an operator filter', refused);

  let refusedUnknown = false;
  try {
    await resolver.list(noFilter, { filters: [{ column: 'nope', op: 'eq', value: 1 }] });
  } catch (e) {
    refusedUnknown = /not a field/.test(String(e));
  }
  ok('an operator filter on an unknown field is refused', refusedUnknown);

  // An operator filter that IS allowed applies, and ANDs with the baseline.
  const opFiltered = await resolver.list(
    { table: 'orders', list: { filter: [{ column: 'total', op: 'gt', value: 100 }] } },
    { filters: [{ column: 'total', op: 'lt', value: 500 }], pageSize: 1 }
  );
  const [{ n: opN }] = await raw('select count(*)::int as n from orders where total > 100 and total < 500');
  ok('operator filter ANDs with the baseline', opFiltered.total === opN, `${opFiltered.total} vs ${opN}`);

  // Searching a relation matches the label — and the COUNT must agree with the
  // rows, which is what forces the joins into the count query.
  const searchRel = { ...rel(), list: { searchColumns: ['customer_id'] } };
  const hit = await resolver.list(searchRel, { search: firstName, pageSize: 200 });
  const [{ n: relN }] = await raw(
    'select count(*)::int as n from orders t left join customers c on c.id = t.customer_id where c.full_name::text ilike $1',
    ['%' + firstName + '%']
  );
  ok('searching a relation matches the displayed name', hit.total === relN && hit.total > 0, `${hit.total} vs ${relN}`);
  ok('the count agrees with the rows it returned', hit.rows.length === Math.min(hit.total, 200), `${hit.rows.length} rows, total ${hit.total}`);
  ok('every returned row really is that customer', hit.rows.every((r) => String(r.customer_id__label).includes(firstName)));

  /* ------- the seam with masking: a secret is not a filter oracle ------- */
  // Masking drops secret columns from `fields`, so the filter paths refuse them
  // transitively rather than by their own check. That is worth pinning: it means
  // either side could regress it alone, and gt/lt on a hash reads it out by
  // binary search just as surely as selecting it would.
  const secret = 'password_hash';
  const usersView = { table: 'users' };
  const [{ n: allUsers }] = await raw('select count(*)::int as n from users');

  let refusedSecret = false;
  try {
    await resolver.list(usersView, { filters: [{ column: secret, op: 'gt', value: 'a' }] });
  } catch (e) {
    refusedSecret = /not a field|not filterable/.test(String(e));
  }
  ok('an operator filter on a masked column is refused', refusedSecret);

  const baselineSecret = await resolver.list(
    { table: 'users', list: { filter: [{ column: secret, op: 'gt', value: 'a' }] } },
    { pageSize: 1 }
  );
  ok('a baseline filter on a masked column does not apply', baselineSecret.total === allUsers, `${baselineSecret.total} vs ${allUsers}`);

  const secretWarn = await resolver.resolve({ table: 'users', fields: [{ column: 'id' }, { column: secret }] });
  ok('naming a masked column warns', secretWarn.warnings.some((w) => w.includes(secret)));
  ok('and it is not a field', !secretWarn.fields.some((f) => f.key === secret));

  // Same direction on both: the fallback replaces the COLUMN, and direction is
  // honoured independently, so comparing asc against the default desc proves
  // nothing.
  const sortedBySecret = await resolver.list(usersView, { sort: secret, direction: 'asc', pageSize: 5 });
  const defaultOrder = await resolver.list(usersView, { direction: 'asc', pageSize: 5 });
  ok('sorting by a masked column falls back to the default order',
    JSON.stringify(sortedBySecret.rows.map((r) => r.id)) === JSON.stringify(defaultOrder.rows.map((r) => r.id)));

  // Searching a NUMBER column: the engine casts, so it was never text-only.
  const numSearch = await resolver.list({ table: 'orders', list: { searchColumns: ['total'] } }, { search: '5', pageSize: 1 });
  const [{ n: numN }] = await raw("select count(*)::int as n from orders where total::text ilike '%5%'");
  ok('a numeric column can be searched', numSearch.total === numN, `${numSearch.total} vs ${numN}`);
} finally {
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode rather than exit(): calling exit() with the summary still in a piped
// stdout buffer makes Windows flush the last line twice, and a doubled
// "50 passed" in CI output reads like the suite ran twice.
process.exitCode = fail ? 1 : 0;
