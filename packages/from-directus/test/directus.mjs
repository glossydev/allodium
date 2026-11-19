/**
 * The live battery: a real Directus 11 database, inspected, planned, and cut over
 * inside a transaction that is rolled back at the end.
 *
 * Needs DIRECTUS_DATABASE_URL pointing at a Directus database that test/fixture.mjs
 * has populated (collections authors/articles/topics with the junction
 * articles_topics, an Editor role, four users, one file, one flow). Without it the
 * battery skips. CI boots a Directus 11 container and runs the fixture first; to do
 * the same locally see the README's "Running the live battery".
 */
import pg from 'pg';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, planViews, planGrants, planDecommission, fileManifest, checkFiles } from '../dist/index.js';
import { validateViewDefinition } from '@allodium/admin/view';
import { verifyPassword } from '@allodium/auth';

const url = process.env.DIRECTUS_DATABASE_URL;
if (!url) {
  console.log('directus: skipped (set DIRECTUS_DATABASE_URL to a Directus database to run)');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
};

console.log('directus (live)');
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  /* -------------------------------- inspect -------------------------------- */
  const inv = await inspect(pool);
  const byName = Object.fromEntries(inv.collections.map((c) => [c.name, c]));
  ok('system tables are listed, not treated as collections', inv.directus.systemTables.includes('directus_fields') && !byName.directus_fields);
  ok('the last migration is recorded', typeof inv.directus.lastMigration === 'string' && inv.directus.lastMigration.length > 0, inv.directus.lastMigration);
  ok('user tables become collections', byName.authors?.kind === 'table' && byName.articles?.kind === 'table' && byName.topics?.kind === 'table' && byName.articles_topics?.kind === 'table');
  ok('collection note survives', byName.articles?.note === 'The blog');
  ok('display template converts to the admin form', byName.articles?.display === '{title}' && byName.authors?.display === '{name}');
  ok('archive settings survive', byName.articles?.archiveField === 'status' && byName.articles?.archiveValue === 'archived');
  ok('primary key found', byName.articles?.primaryKey === 'id');

  const f = Object.fromEntries((byName.articles?.fields ?? []).map((x) => [x.name, x]));
  ok('fields come in Directus form order', (byName.articles?.fields ?? []).map((x) => x.name).slice(0, 4).join(',') === 'id,title,status,body');
  ok('catalog type is merged in', f.title?.sqlType === 'character varying' && f.published_at?.sqlType === 'timestamp with time zone' && f.tags?.sqlType === 'json');
  ok('nullability and defaults', f.title?.nullable === false && f.status?.hasDefault === true);
  ok('field note survives', f.title?.note === 'The headline' && f.status?.note === 'Drafts are invisible on the site');
  ok('required / hidden / readonly', f.title?.required === true && f.id?.hidden === true && f.id?.readonly === true);
  ok('choices survive', Array.isArray(f.status?.options?.choices) && f.status.options.choices.length === 3);
  ok('specials are split', f.owner?.special.join(',') === 'm2o,user-created' && f.cover?.special.join(',') === 'file');
  ok('an alias field has no sqlType', f.topics?.sqlType === null && f.topics?.special.includes('m2m'));
  ok('display options survive', f.author?.displayOptions?.template === '{{name}}');
  ok('no metadata rows were missing in the fixture', inv.collections.every((c) => c.fields.every((x) => !x.metadataMissing)), inv.collections.flatMap((c) => c.fields.filter((x) => x.metadataMissing).map((x) => `${c.name}.${x.name}`)));

  const rel = (t, c) => inv.relations.find((r) => r.table === t && r.column === c);
  ok('m2o relation', rel('articles', 'author')?.references === 'authors' && rel('articles', 'author')?.inboundField === 'articles');
  ok('user and file relations point at the system tables', rel('articles', 'owner')?.references === 'directus_users' && rel('articles', 'cover')?.references === 'directus_files');
  ok('junction relations carry their partner', rel('articles_topics', 'articles_id')?.junctionPartner === 'topics_id' && rel('articles_topics', 'articles_id')?.inboundField === 'topics');

  const editor = inv.roles.find((r) => r.name === 'Editor');
  ok('roles with policy ids and user counts', editor && editor.policyIds.length === 1 && editor.userCount === 1, editor);
  const editorPolicy = inv.policies.find((p) => p.id === editor?.policyIds[0]);
  ok('the editor policy has its permissions', editorPolicy?.permissions.length === 5, editorPolicy?.permissions.map((p) => `${p.action} ${p.collection}`));
  ok('the public policy is identified', inv.publicPolicyIds.length === 1);
  const adminRole = inv.roles.find((r) => r.name === 'Administrator');
  ok('the admin policy is flagged', inv.policies.find((p) => p.id === adminRole?.policyIds[0])?.adminAccess === true);
  ok('a filter is parsed to an object', editorPolicy?.permissions.find((p) => p.action === 'update')?.filter?.owner?._eq === '$CURRENT_USER');

  ok('flows with operations', inv.flows.length === 1 && inv.flows[0].operations.length === 1 && inv.flows[0].operations[0].type === 'log', inv.flows);
  ok('active flows produce a warning', inv.warnings.some((w) => /active flow/.test(w) && w.includes('Notify on publish')));

  ok('user counts', inv.users.total === 4 && inv.users.withArgon2Hash === 3 && inv.users.withoutPassword === 1 && inv.users.withOtherHash === 0, inv.users);
  ok('users by provider and status', inv.users.byProvider.google === 1 && inv.users.byStatus.suspended === 1, inv.users);
  ok('file counts', inv.files.total === 1 && inv.files.byStorage.local === 1 && inv.files.totalBytes === 72, inv.files);
  ok('file FK columns are found', inv.files.referencedBy.some((r) => r.table === 'articles' && r.column === 'cover'));
  ok('the inventory is JSON', JSON.parse(JSON.stringify(inv)).collections.length === inv.collections.length);

  /* --------------------------------- views --------------------------------- */
  const vp = planViews(inv);
  const view = (t) => vp.views.find((v) => v.definition.table === t)?.definition;
  for (const v of vp.views) {
    const r = validateViewDefinition(v.definition);
    ok(`draft ${v.file} validates against the admin contract`, r.ok, r.problems);
  }
  ok('no view for the junction table', !view('articles_topics') && vp.notes.some((n) => n.startsWith('articles_topics')));
  const art = view('articles');
  const field = (v, c) => v?.fields.find((x) => x.column === c || x.name === c);
  ok('the draft carries title, description and display', art?.title === 'Articles' && art?.description === 'The blog' && art?.display === '{title}');
  ok('the primary key is not a field', !field(art, 'id'));
  ok('choices become select options with labels', field(art, 'status')?.widget === 'select' && field(art, 'status')?.options?.length === 3 && field(art, 'status')?.options[0].label === 'Draft');
  ok('required survives, a note does NOT (it goes to the schema comment)', field(art, 'title')?.required === true && field(art, 'title')?.help === undefined);
  ok('markdown interface becomes the markdown widget', field(art, 'body')?.widget === 'markdown' && field(art, 'body')?.filterable === false);
  ok('a json column behind the tags interface gets the json widget (tags is for text[])', field(art, 'tags')?.widget === 'json');
  ok('datetime widget', field(art, 'published_at')?.widget === 'datetime');
  ok('m2o becomes a relation field with its local display', field(art, 'author')?.kind === 'relation' && field(art, 'author')?.relation.table === 'authors' && field(art, 'author')?.relation.display === '{name}' && field(art, 'author')?.widget === 'select');
  ok('user relation is renamed and read-only (user-created)', field(art, 'owner')?.relation.table === 'users' && field(art, 'owner')?.relation.display === 'email' && field(art, 'owner')?.readOnly === true);
  ok('file relation gets the file widget', field(art, 'cover')?.kind === 'relation' && field(art, 'cover')?.relation.table === 'files' && field(art, 'cover')?.widget === 'file');
  const m2m = field(art, 'topics');
  ok('m2m alias becomes an m2m field', m2m?.kind === 'm2m' && m2m.through === 'articles_topics' && m2m.near === 'articles_id' && m2m.far === 'topics_id' && m2m.farTable === 'topics' && m2m.display === '{label}', m2m);
  ok('list columns skip long text', art?.list?.columns?.includes('title') && !art?.list?.columns?.includes('body'));
  ok('search columns are the free-text columns, not the choice field', art?.list?.searchColumns?.includes('title') && !art?.list?.searchColumns?.includes('status'));
  ok('archive setting becomes a note, not a hidden filter', !art?.list?.filter && vp.notes.some((n) => /articles: Directus archived/.test(n)));
  const auth = view('authors');
  ok('o2m alias becomes a related list', auth?.related?.length === 1 && auth.related[0].table === 'articles' && auth.related[0].foreignKey === 'author', auth?.related);
  ok('system-table views are drafted for display fallbacks', view('users')?.display === 'email' && view('files')?.display === 'filename');
  ok('comments SQL carries notes', vp.commentsSql.includes(`comment on column "articles"."title" is 'The headline';`) && vp.commentsSql.includes(`comment on table "articles" is 'The blog';`));
  ok('alias notes are not commented as columns', !vp.commentsSql.includes('"authors"."articles"'));

  /* -------------------------------- grants --------------------------------- */
  const gp = planGrants(inv);
  const roleKeys = gp.roles.map((r) => r.key);
  ok('public, editor and administrator roles', roleKeys.includes('public') && roleKeys.includes('editor') && roleKeys.includes('administrator'), roleKeys);
  ok('the admin role is flagged and gets no grants', gp.roles.find((r) => r.key === 'administrator')?.admin === true && !gp.grants.some((g) => g.roleKey === 'administrator') && gp.notes.some((n) => /admin access/.test(n)));
  const g = (role, table) => gp.grants.find((x) => x.roleKey === role && x.table === table);
  ok('public reads published articles', JSON.stringify(g('public', 'articles')) === JSON.stringify({ roleKey: 'public', table: 'articles', create: false, read: true, update: false, delete: false, rowFilter: [{ column: 'status', op: 'eq', value: 'published' }] }), g('public', 'articles'));
  ok('public reads all authors', g('public', 'authors')?.read === true && g('public', 'authors')?.rowFilter === null);
  const ea = g('editor', 'articles');
  ok('editor: read and create, every row', ea?.read === true && ea?.create === true && ea?.rowFilter === null, ea);
  ok('editor: update under a different filter from read is left out and reported', ea?.update === false && gp.unexpressible.some((u) => u.roleKey === 'editor' && u.action === 'update' && /different row filter/.test(u.reason)), gp.unexpressible);
  ok('editor: the _or delete is refused', ea?.delete === false && gp.unexpressible.some((u) => u.roleKey === 'editor' && u.action === 'delete' && /AND-only/.test(u.reason)));
  ok('editor: _ncontains on authors is refused', !g('editor', 'authors') && gp.unexpressible.some((u) => u.table === 'authors' && /negated/.test(u.reason)));
  ok('per-action filters are kept for the reviewer', ea?.perAction?.update?.[0]?.value === '$actor.userId');
  ok('SQL inserts roles and grants idempotently', gp.sql.includes(`insert into roles (key, label, description, rank) values ('editor', 'Editor'`) && gp.sql.includes(`on conflict (role_id, table_name) do update`) && gp.sql.includes(`'[{"column":"status","op":"eq","value":"published"}]'::jsonb`));
  ok('the untranslated permissions are listed in the SQL as comments', gp.sql.includes('-- 3 permission(s) were NOT translated'), gp.sql.split('\n').filter((l) => l.includes('NOT translated')));
  ok('field-level restrictions are not in the fixture', !gp.notes.some((n) => /FIELDS/.test(n)));

  /* ------------------------------ decommission ----------------------------- */
  const dp = planDecommission(inv);
  ok('drops are explicit and never cascade', dp.drops.length > 10 && !/drop table .*cascade/i.test(dp.sql) && dp.drops.every((t) => dp.sql.includes(`drop table "${t}";`)));
  ok('children drop before parents', dp.drops.indexOf('directus_revisions') < dp.drops.indexOf('directus_versions') && dp.drops.indexOf('directus_sessions') < dp.drops.indexOf('directus_shares'), dp.drops);
  ok('system dependencies are in the inventory', inv.directus.systemDependencies.some((d) => d.table === 'directus_revisions' && d.references === 'directus_versions'));
  const keepPlan = planDecommission(inv, { keepAuditTables: true });
  ok('the audit archive option keeps activity and revisions', !keepPlan.drops.includes('directus_activity') && keepPlan.sql.includes('rename to "archive_revisions"'));
  ok('the three adopted tables are not dropped', !dp.drops.includes('directus_users') && !dp.drops.includes('directus_files') && !dp.drops.includes('directus_roles'));
  ok('notes explain nullable passwords', dp.notes.some((n) => /no password/.test(n)));

  // Run it for real, inside a transaction, then roll back. Proves the SQL is valid
  // against this Directus version and that the adopted shapes are what the rest of
  // Allodium expects.
  const client = await pool.connect();
  try {
    const body = dp.sql.replace(/^begin;$/m, '').replace(/^commit;$/m, '');
    await client.query('begin');
    await client.query(body);
    const cols = async (t) => (await client.query(`select column_name, data_type, is_nullable from information_schema.columns where table_name = $1 order by ordinal_position`, [t])).rows;
    const ucols = await cols('users');
    const names = ucols.map((c) => c.column_name);
    ok('users has the adopted columns', ['id', 'email', 'password_hash', 'mfa_secret', 'display_name', 'status', 'last_login_at', 'created_at', 'provider', 'external_identifier', 'avatar'].every((c) => names.includes(c)), names);
    ok('users lost the Directus UI columns and role', !names.includes('role') && !names.includes('theme_dark') && !names.includes('token'));
    ok('status is the enum', ucols.find((c) => c.column_name === 'status')?.data_type === 'USER-DEFINED');
    const users = (await client.query(`select email, display_name, status::text as status, password_hash, provider, external_identifier from users order by email`)).rows;
    ok('display names are built', users.find((u) => u.email === 'ada@example.com')?.display_name === 'Ada Lovelace' && users.find((u) => u.email === 'grace@example.com')?.display_name === 'Grace');
    ok('statuses are mapped', users.find((u) => u.email === 'grace@example.com')?.status === 'deactivated' && users.find((u) => u.email === 'ada@example.com')?.status === 'active');
    ok('the SSO identity survives', users.find((u) => u.email === 'sso@example.com')?.provider === 'google' && users.find((u) => u.email === 'sso@example.com')?.external_identifier === 'google-sub-123' && users.find((u) => u.email === 'sso@example.com')?.password_hash === null);
    ok('the argon2 hash verifies with @allodium/auth — zero resets', await verifyPassword(users.find((u) => u.email === 'ada@example.com')?.password_hash, 'ada-password-1'));
    ok('...and refuses the wrong password', !(await verifyPassword(users.find((u) => u.email === 'ada@example.com')?.password_hash, 'nope')));
    ok('the admin password verifies too', await verifyPassword(users.find((u) => u.email === 'admin@example.com')?.password_hash, 'adminpassword'));

    const roles = (await client.query(`select key, label, rank from roles order by rank, key`)).rows;
    ok('roles got keys, and public was added', roles.some((r) => r.key === 'editor' && r.label === 'Editor') && roles.some((r) => r.key === 'administrator') && roles.some((r) => r.key === 'public' && r.rank === 1000), roles);
    const ur = (await client.query(`select u.email, r.key from user_roles ur join users u on u.id = ur.user_id join roles r on r.id = ur.role_id order by 1`)).rows;
    ok('user_roles reflect directus_users.role', ur.length === 2 && ur.find((x) => x.email === 'ada@example.com')?.key === 'editor' && ur.find((x) => x.email === 'admin@example.com')?.key === 'administrator', ur);

    // The grants plan runs on the adopted tables.
    await client.query(gp.sql.replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
    const rp = (await client.query(`select r.key, p.table_name, p.can_read, p.can_create, p.row_filter from role_permissions p join roles r on r.id = p.role_id order by 1, 2`)).rows;
    ok('role_permissions rows land', rp.length === 3 && rp.find((x) => x.key === 'public' && x.table_name === 'articles')?.row_filter?.[0]?.value === 'published' && rp.find((x) => x.key === 'editor' && x.table_name === 'articles')?.can_create === true, rp);
    ok('role_permissions.role_id is a uuid FK to roles', (await client.query(`select data_type from information_schema.columns where table_name = 'role_permissions' and column_name = 'role_id'`)).rows[0]?.data_type === 'uuid');

    const fcols = (await cols('files')).map((c) => c.column_name);
    ok('files has the storage column names', ['id', 'disk_name', 'filename', 'mime_type', 'filesize_bytes', 'title', 'uploaded_at', 'width', 'height', 'uploaded_by'].every((c) => fcols.includes(c)) && !fcols.includes('storage') && !fcols.includes('tus_id'), fcols);
    const file = (await client.query(`select id, disk_name, filename, mime_type, filesize_bytes from files`)).rows[0];
    ok('the file row kept its id and values', file && file.disk_name.endsWith('.png') && file.filename === 'cover.png' && file.mime_type === 'image/png' && Number(file.filesize_bytes) === 72, file);
    const cover = (await client.query(`select a.title, f.filename from articles a join files f on f.id = a.cover`)).rows;
    ok('the FK from articles.cover followed the rename', cover.length === 1 && cover[0].filename === 'cover.png');
    const owner = (await client.query(`select count(*)::int as n from articles a join users u on u.id = a.owner`)).rows[0];
    ok('the FK from articles.owner followed the rename', owner.n === 3);
    const uploader = (await client.query(`select u.email from files f join users u on u.id = f.uploaded_by`)).rows;
    ok('files.uploaded_by still joins', uploader[0]?.email === 'admin@example.com');

    const remaining = (await client.query(`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'directus\\_%'`)).rows;
    ok('no directus_* table remains', remaining.length === 0, remaining);
    const comments = vp.commentsSql;
    await client.query(comments);
    const cmt = (await client.query(`select col_description('articles'::regclass, (select attnum from pg_attribute where attrelid = 'articles'::regclass and attname = 'title')) as c`)).rows[0];
    ok('the comments SQL applies', cmt.c === 'The headline');
  } catch (e) {
    ok('the decommission transaction runs against Directus 11', false, e.message);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
  ok('the rollback left Directus intact', (await pool.query(`select count(*)::int as n from directus_users`)).rows[0].n === 4);

  /* --------------------------------- files --------------------------------- */
  const manifest = await fileManifest(pool);
  ok('the manifest lists the file', manifest.length === 1 && manifest[0].filename === 'cover.png' && manifest[0].bytes === 72 && manifest[0].diskName.endsWith('.png'));
  const dir = await mkdtemp(join(tmpdir(), 'allodium-files-'));
  try {
    let check = await checkFiles(manifest, dir);
    ok('an empty root reports the file missing', check.missing.length === 1 && check.present === 0);
    await writeFile(join(dir, manifest[0].diskName), Buffer.alloc(10));
    check = await checkFiles(manifest, dir);
    ok('a truncated copy is a size mismatch', check.sizeMismatch.length === 1 && check.sizeMismatch[0].onDisk === 10);
    await writeFile(join(dir, manifest[0].diskName), Buffer.alloc(72));
    check = await checkFiles(manifest, dir);
    ok('a complete copy is present', check.present === 1 && check.missing.length === 0 && check.sizeMismatch.length === 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} finally {
  await pool.end();
}

console.log(`  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
