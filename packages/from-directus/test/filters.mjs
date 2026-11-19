/**
 * Directus filter → Allodium predicates. Pure; runs everywhere.
 *
 * The property under test is exactness: every translation that comes back is the
 * same set of rows Directus would have allowed, and anything else is refused with
 * a path. A quiet approximation here would widen a grant.
 */
import { translateFilter, UntranslatableFilter, SUPPORTED_FILTER_OPERATORS } from '../dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refuses = (name, filter, re) => {
  try {
    const out = translateFilter(filter);
    ok(name, false, `translated to ${JSON.stringify(out)}`);
  } catch (e) {
    ok(name, e instanceof UntranslatableFilter && (!re || re.test(e.message)), `${e.name}: ${e.message}`);
  }
};

console.log('filters');

ok('null is every row', same(translateFilter(null), []));
ok('{} is every row', same(translateFilter({}), []));
ok('_eq', same(translateFilter({ status: { _eq: 'published' } }), [{ column: 'status', op: 'eq', value: 'published' }]));
ok('shorthand equality', same(translateFilter({ status: 'published' }), [{ column: 'status', op: 'eq', value: 'published' }]));
ok('_neq', same(translateFilter({ status: { _neq: 'draft' } }), [{ column: 'status', op: 'ne', value: 'draft' }]));
ok('_in', same(translateFilter({ status: { _in: ['a', 'b'] } }), [{ column: 'status', op: 'in', value: ['a', 'b'] }]));
ok('_null true', same(translateFilter({ deleted_at: { _null: true } }), [{ column: 'deleted_at', op: 'isNull' }]));
ok('_null false is notNull', same(translateFilter({ deleted_at: { _null: false } }), [{ column: 'deleted_at', op: 'notNull' }]));
ok('_nnull', same(translateFilter({ name: { _nnull: true } }), [{ column: 'name', op: 'notNull' }]));
ok('ordered comparisons', same(translateFilter({ n: { _gt: 1, _lte: 9 } }), [{ column: 'n', op: 'gt', value: 1 }, { column: 'n', op: 'lte', value: 9 }]));
ok('_contains / _icontains', same(translateFilter({ t: { _icontains: 'x' } }), [{ column: 't', op: 'contains', value: 'x' }]));
ok('_starts_with', same(translateFilter({ t: { _starts_with: 'x' } }), [{ column: 't', op: 'startsWith', value: 'x' }]));
ok('_and flattens', same(translateFilter({ _and: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] }), [{ column: 'a', op: 'eq', value: 1 }, { column: 'b', op: 'eq', value: 2 }]));
ok('several columns AND', translateFilter({ a: { _eq: 1 }, b: { _eq: 2 } }).length === 2);
ok('a single-branch _or is just the branch', same(translateFilter({ _or: [{ a: { _eq: 1 } }] }), [{ column: 'a', op: 'eq', value: 1 }]));
ok('$CURRENT_USER becomes the actor claim', same(translateFilter({ owner: { _eq: '$CURRENT_USER' } }), [{ column: 'owner', op: 'eq', value: '$actor.userId' }]));
ok('a relation hop is an FK path', same(translateFilter({ author: { user: { _eq: '$CURRENT_USER' } } }), [{ column: 'author.user', op: 'eq', value: '$actor.userId' }]));
ok('two hops', same(translateFilter({ order: { customer: { user_id: { _eq: '$CURRENT_USER' } } } }), [{ column: 'order.customer.user_id', op: 'eq', value: '$actor.userId' }]));
ok('booleans and null values pass through', same(translateFilter({ a: { _eq: true }, b: { _eq: null } }), [{ column: 'a', op: 'eq', value: true }, { column: 'b', op: 'eq', value: null }]));

refuses('_or with two branches', { _or: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] }, /AND-only/);
refuses('_nin', { s: { _nin: ['a'] } }, /not in/);
refuses('_ncontains', { s: { _ncontains: 'spam' } }, /negated/);
refuses('_between', { n: { _between: [1, 2] } }, /gte and lte/);
refuses('_empty', { s: { _empty: true } }, /_null/);
refuses('_regex', { s: { _regex: '^a' } }, /not available/);
refuses('$CURRENT_ROLE', { role: { _eq: '$CURRENT_ROLE' } }, /per role/);
refuses('$CURRENT_USER.field', { team: { _eq: '$CURRENT_USER.team' } }, /claim/);
refuses('$NOW', { until: { _gte: '$NOW' } }, /time-relative/);
refuses('_in without an array', { s: { _in: 'a' } }, /array/);
refuses('_eq with an array', { s: { _eq: ['a'] } }, /array/);
refuses('an unknown dynamic variable', { s: { _eq: '$SOMETHING' } }, /unknown dynamic/);
refuses('a non-object', 'status=published');
refuses('_null with a non-boolean', { s: { _null: 'yes' } }, /true or false/);

try {
  translateFilter({ _and: [{ a: { _eq: 1 } }, { b: { _nin: [2] } }] });
  ok('path reported', false);
} catch (e) {
  ok('the path of the offending clause is reported', e.at === '$._and[1].b._nin', e.at);
}

ok('the supported-operator list matches the translator', SUPPORTED_FILTER_OPERATORS.every((op) => {
  if (op === '_and') return true;
  try {
    translateFilter({ c: { [op]: op === '_in' ? ['x'] : op === '_null' || op === '_nnull' ? true : 'x' } });
    return true;
  } catch {
    return false;
  }
}));

console.log(`  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
