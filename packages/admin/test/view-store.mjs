/**
 * Reading view definitions off disk.
 *
 * Two behaviours here were expensive to learn and are invisible in the happy
 * path. A file being rewritten reads as TRUNCATED, because writeFile truncates
 * then fills — so a parse failure is often a passing condition that resolves in
 * milliseconds, and believing the first one produced an intermittent 500. And
 * "absent" and "corrupt" must not be the same answer: reporting a broken file as
 * "unknown view" is a lie about a file sitting right there.
 *
 * The third is the resolution rule: a panel addresses a TABLE, while a view name
 * is only what somebody called a file. `post_tags.view.json` containing a view of
 * `tags` satisfied a lookup by name, rendered the wrong table, and failed on the
 * first bound filter — a 404 traded for a 400.
 *
 * No database. Real files in a temp directory.
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileViewStore, pickViewForTable } from '../dist/server/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('view store');

const dir = mkdtempSync(path.join(tmpdir(), 'allodium-views-'));
const write = (name, body) =>
  writeFileSync(path.join(dir, `${name}.view.json`), typeof body === 'string' ? body : JSON.stringify(body, null, 2));

try {
  const store = createFileViewStore({ dir });

  /* ------------------------------ reading ----------------------------- */
  write('posts', { table: 'posts', title: 'Blog posts' });
  write('orders', { table: 'orders' });

  ok('a definition loads', (await store.load('posts'))?.title === 'Blog posts');
  ok('an absent file is null, not an error', (await store.load('nope')) === null);
  ok('names lists the stems, sorted', JSON.stringify(await store.names()) === JSON.stringify(['orders', 'posts']));
  ok('all() returns name + definition', (await store.all()).find((v) => v.name === 'posts')?.definition.table === 'posts');

  // A path-shaped name must never reach the filesystem.
  for (const evil of ['../secrets', 'a/b', 'a\\b', '..']) {
    ok(`"${evil}" is refused as a name`, (await store.load(evil)) === null);
  }

  /* ------------------- absent and corrupt are different ---------------- */
  write('broken', '{ "table": "posts",,, }');
  let threw = null;
  try {
    await store.load('broken');
  } catch (e) {
    threw = String(e.message);
  }
  ok('a corrupt file THROWS rather than reading as absent', threw !== null);
  ok('...naming the file', /broken\.view\.json/.test(threw ?? ''), threw ?? '');
  ok("...and keeping the parser's own message", /JSON/i.test(threw ?? ''), threw ?? '');
  // Scanning is a different question from asking, and answers differently: one
  // stray comma must not take down every related panel in an app.
  const seen = [];
  const scanning = createFileViewStore({ dir, onProblem: (n, m) => seen.push(`${n}: ${m}`) });
  const listed = await scanning.all();
  ok('all() skips what it cannot parse', Array.isArray(listed) && !listed.some((v) => v.name === 'broken'));
  ok('...still returning the good ones', listed.some((v) => v.name === 'posts'));
  ok('...and reports what it passed over', seen.some((s) => s.startsWith('broken:')), JSON.stringify(seen));
  ok('...while load() on that same file still throws', threw !== null);

  /* --------------------- a truncated read is retried ------------------- */
  // Exactly the shape a concurrent writer produces: unparseable now, fine a
  // moment later. The reader must survive it without the caller noticing.
  const racing = path.join(dir, 'racing.view.json');
  writeFileSync(racing, '{ "table": "post');
  setTimeout(() => writeFileSync(racing, JSON.stringify({ table: 'posts', title: 'Recovered' })), 20);
  const recovered = await store.load('racing');
  ok('a mid-write file is re-read rather than believed', recovered?.title === 'Recovered', JSON.stringify(recovered));

  /* ------------------------- table beats name -------------------------- */
  // The exact bug: filename says post_tags, content says tags.
  write('post_tags', { table: 'tags', fields: [{ column: 'label' }] });
  const mismatched = await scanning.loadForTable('post_tags', 'post_tags');
  ok('a file whose table does not match is NOT used', mismatched.table === 'post_tags', `got ${mismatched.table}`);
  ok('...falling back to the implicit screen', mismatched.fields === undefined);

  write('the-tags-of-posts', { table: 'post_tags', fields: [{ column: 'post_id' }] });
  const found = await scanning.loadForTable('post_tags', 'post_tags');
  ok('a view about the table is found under any filename', found.fields?.length === 1);

  write('post_tags', { table: 'post_tags', fields: [{ column: 'post_id' }, { column: 'tag_id' }] });
  ok('a file named after the table is preferred', (await scanning.loadForTable('post_tags', 'post_tags')).fields?.length === 2);

  ok('no view at all is the implicit screen, not an error', (await scanning.loadForTable('comments', 'comments')).table === 'comments');

  write('unpaid', { table: 'orders', title: 'Unpaid' });
  ok('an explicit view about the right table is used', (await scanning.loadForTable('unpaid', 'orders')).title === 'Unpaid');
  const wrong = await scanning.loadForTable('unpaid', 'comments');
  ok('an explicit view about the WRONG table is ignored', wrong.table === 'comments' && wrong.title === undefined);

  /* --------------------------- the rule, pure -------------------------- */
  const misnamed = { name: 'post_tags', definition: { table: 'tags' } };
  ok('pickViewForTable is usable on its own', pickViewForTable(misnamed.definition, [misnamed], 'post_tags').table === 'post_tags');
  ok('...and prefers the file named after the table', pickViewForTable(null, [
    { name: 'zzz', definition: { table: 'x', fields: [] } },
    { name: 'x', definition: { table: 'x', fields: [{ column: 'a' }] } },
  ], 'x').fields?.length === 1);

  /* ------------------------- an empty directory ------------------------ */
  const empty = createFileViewStore({ dir: path.join(dir, 'does-not-exist') });
  ok('a missing directory is an empty list, not a crash', (await empty.names()).length === 0);
  ok('...and loadForTable still answers', (await empty.loadForTable('x', 'x')).table === 'x');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
