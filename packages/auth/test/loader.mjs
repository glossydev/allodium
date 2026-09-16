/**
 * The grant loader fails CLOSED.
 *
 * A row_filter that cannot be read is the one place the permission model could
 * silently widen: keep the grant and drop the filter, and "the public may read
 * published posts" becomes "the public may read every post" with nothing but a
 * log line to say so. This proves a malformed filter refuses the grant entirely
 * — through a fake matrix, so it needs no database and runs on every push.
 */
import { createGrantLoader, PUBLIC_ACTOR } from '../dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('grant loader: fail closed');

/** A Queryable answering the loader's matrix query with the given rows. */
const matrix = (rows) => ({
  async query(text) {
    if (/from "role_permissions"/.test(text)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  },
});
const row = (row_filter, extra = {}) => ({ role: 'public', table_name: 'posts', can_create: false, can_read: true, can_update: false, can_delete: false, row_filter, ...extra });
const published = [{ column: 'status', op: 'eq', value: 'published' }];

/* ----------------------------- well-formed ----------------------------- */
{
  const policy = await createGrantLoader(matrix([row(published)])).policy();
  const d = policy.can(PUBLIC_ACTOR, 'posts', 'read');
  ok('a well-formed filter loads as the grant\'s scope', d.allowed && JSON.stringify(d.scope) === JSON.stringify(published), JSON.stringify(d));
  ok('...with nothing to report', policy.problems.length === 0, JSON.stringify(policy.problems));
}
{
  const policy = await createGrantLoader(matrix([row(JSON.stringify(published))])).policy();
  ok('a filter arriving as a JSON string is parsed', policy.can(PUBLIC_ACTOR, 'posts', 'read').scope.length === 1);
}
for (const [label, value] of [['null', null], ['an empty array', []]]) {
  const policy = await createGrantLoader(matrix([row(value)])).policy();
  const d = policy.can(PUBLIC_ACTOR, 'posts', 'read');
  ok(`${label} means every row`, d.allowed && d.scope.length === 0, JSON.stringify(d));
}

/* ------------------------------ malformed ------------------------------ */
const malformed = [
  ['an object instead of an array', {}],
  ['a bare string', 'published'],
  ['a number', 1],
  ['an entry with no column', [{ op: 'eq', value: 'published' }]],
  ['an entry with a blank column', [{ column: ' ', op: 'eq', value: 'published' }]],
  ['a good entry beside a bad one', [...published, { value: 'x' }]],
  ['unparseable JSON text', '{not json'],
];
for (const [label, value] of malformed) {
  const loader = createGrantLoader(matrix([row(value)]));
  const policy = await loader.policy();
  const d = policy.can(PUBLIC_ACTOR, 'posts', 'read');
  ok(`${label} REFUSES the grant`, !d.allowed, JSON.stringify(d));
  ok(`...and says so`, policy.problems.some((p) => /REFUSED/.test(p)), JSON.stringify(policy.problems));
  ok(`...and the grant is not loaded at all`, (await loader.grants()).length === 0);
}

// The refusal is per grant: a broken filter on one row must not take a
// well-formed grant on another table down with it.
{
  const loader = createGrantLoader(matrix([row({}), row(null, { table_name: 'authors' })]));
  const policy = await loader.policy();
  ok('a broken grant refuses only itself', !policy.can(PUBLIC_ACTOR, 'posts', 'read').allowed && policy.can(PUBLIC_ACTOR, 'authors', 'read').allowed);
  ok('...leaving the other loaded', (await loader.grants()).length === 1);
}

// And it must never resolve to the WIDER grant: with a good restricted grant on
// one role and a broken one on another, an actor holding both gets the
// restriction, not the whole table.
{
  const loader = createGrantLoader(matrix([row(published), row({}, { role: 'member' })]));
  const policy = await loader.policy();
  const d = policy.can({ userId: 'u', roles: ['public', 'member'], claims: {} }, 'posts', 'read');
  ok('a broken grant cannot widen a good one', d.allowed && d.scope.length === 1, JSON.stringify(d));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
