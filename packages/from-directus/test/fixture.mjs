/**
 * Populate a fresh Directus instance with the shapes the migrator has to handle.
 * Idempotence is not attempted: run it once against an empty instance.
 *
 *   DIRECTUS_URL=http://localhost:8055 DIRECTUS_ADMIN_EMAIL=admin@example.com \
 *   DIRECTUS_ADMIN_PASSWORD=adminpassword node test/fixture.mjs
 *
 * What it builds, and why each piece is there:
 *   authors, articles         collections with notes, a display template, archive settings
 *   articles.status           select-dropdown with choices        → view options
 *   articles.body / tags      markdown + json tags interfaces     → widget mapping
 *   articles.author           m2o with a display template         → relation field + o2m related list on authors
 *   articles.owner            m2o to directus_users, user-created → renamed target, read-only
 *   articles.cover            file field                           → file widget, FK follows the rename
 *   articles.topics           m2m through articles_topics          → m2m field, junction gets no view
 *   Editor role + policy      filters: $CURRENT_USER, _or, _and + _ncontains → exact translation or refusal
 *   public policy             status = published                   → the public role's row filter
 *   four users                argon2 passwords, a suspended one, an SSO one without a password
 *   one file                  bytes + metadata                     → files adoption, manifest check
 *   one active flow           → the "logic outside the schema" warning
 */
const B = (process.env.DIRECTUS_URL ?? 'http://localhost:8055').replace(/\/$/, '');
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? 'adminpassword';

const j = async (path, init = {}) => {
  const res = await fetch(B + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body.data;
};

// Directus takes a while to bootstrap on first start; wait for it.
for (let i = 0; ; i++) {
  const up = await fetch(B + '/server/health').then((r) => r.ok).catch(() => false);
  if (up) break;
  if (i > 120) throw new Error(`Directus at ${B} never became healthy`);
  await new Promise((r) => setTimeout(r, 1000));
}

const { access_token: token } = await j('/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const auth = { authorization: `Bearer ${token}` };
const get = (path) => j(path, { headers: auth });
const post = (path, body) => j(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
const patch = (path, body) => j(path, { method: 'PATCH', headers: auth, body: JSON.stringify(body) });

const pk = { field: 'id', type: 'integer', meta: { hidden: true, readonly: true, interface: 'input' }, schema: { is_primary_key: true, has_auto_increment: true } };

/* ------------------------------- collections ------------------------------- */
await post('/collections', {
  collection: 'authors',
  meta: { note: 'People who write articles', display_template: '{{name}}' },
  schema: {},
  fields: [
    pk,
    { field: 'name', type: 'string', meta: { interface: 'input', required: true, note: 'Shown on the byline' }, schema: { is_nullable: false, max_length: 120 } },
    { field: 'email', type: 'string', meta: { interface: 'input' }, schema: { max_length: 200 } },
  ],
});
await post('/collections', {
  collection: 'articles',
  meta: { note: 'The blog', display_template: '{{title}}', archive_field: 'status', archive_value: 'archived', unarchive_value: 'draft' },
  schema: {},
  fields: [
    pk,
    { field: 'title', type: 'string', meta: { interface: 'input', required: true, note: 'The headline' }, schema: { is_nullable: false, max_length: 200 } },
    {
      field: 'status',
      type: 'string',
      meta: { interface: 'select-dropdown', options: { choices: [{ text: 'Draft', value: 'draft' }, { text: 'Published', value: 'published' }, { text: 'Archived', value: 'archived' }] }, note: 'Drafts are invisible on the site' },
      schema: { default_value: 'draft', max_length: 20 },
    },
    { field: 'body', type: 'text', meta: { interface: 'input-rich-text-md' }, schema: {} },
    { field: 'tags', type: 'json', meta: { interface: 'tags', special: ['cast-json'] }, schema: {} },
    { field: 'published_at', type: 'timestamp', meta: { interface: 'datetime' }, schema: {} },
  ],
});
await post('/fields/articles', { field: 'author', type: 'integer', meta: { interface: 'select-dropdown-m2o', special: ['m2o'], display: 'related-values', display_options: { template: '{{name}}' } }, schema: {} });
await post('/relations', { collection: 'articles', field: 'author', related_collection: 'authors', meta: { one_field: 'articles' }, schema: { on_delete: 'SET NULL' } });
await post('/fields/articles', { field: 'owner', type: 'uuid', meta: { interface: 'select-dropdown-m2o', special: ['m2o', 'user-created'] }, schema: {} });
await post('/relations', { collection: 'articles', field: 'owner', related_collection: 'directus_users', schema: { on_delete: 'SET NULL' } });
await post('/fields/articles', { field: 'cover', type: 'uuid', meta: { interface: 'file-image', special: ['file'] }, schema: {} });
await post('/relations', { collection: 'articles', field: 'cover', related_collection: 'directus_files', schema: { on_delete: 'SET NULL' } });
// The o2m alias on authors (the inbound side of articles.author).
await post('/fields/authors', { field: 'articles', type: 'alias', meta: { interface: 'list-o2m', special: ['o2m'], note: 'What this author wrote' } });

// m2m: articles <-> topics through articles_topics
await post('/collections', {
  collection: 'topics',
  meta: { display_template: '{{label}}' },
  schema: {},
  fields: [pk, { field: 'label', type: 'string', meta: { interface: 'input', required: true }, schema: { is_nullable: false, max_length: 80 } }],
});
await post('/collections', {
  collection: 'articles_topics',
  meta: { hidden: true },
  schema: {},
  fields: [pk, { field: 'articles_id', type: 'integer', meta: { hidden: true }, schema: {} }, { field: 'topics_id', type: 'integer', meta: { hidden: true }, schema: {} }],
});
await post('/fields/articles', { field: 'topics', type: 'alias', meta: { interface: 'list-m2m', special: ['m2m'], display: 'related-values', display_options: { template: '{{topics_id.label}}' } } });
await post('/relations', { collection: 'articles_topics', field: 'articles_id', related_collection: 'articles', meta: { one_field: 'topics', junction_field: 'topics_id' }, schema: { on_delete: 'CASCADE' } });
await post('/relations', { collection: 'articles_topics', field: 'topics_id', related_collection: 'topics', meta: { junction_field: 'articles_id' }, schema: { on_delete: 'CASCADE' } });

/* ---------------------------- roles and policies ---------------------------- */
const editorPolicy = await post('/policies', { name: 'Editor policy', app_access: true, admin_access: false });
const editorRole = await post('/roles', { name: 'Editor', description: 'Writes and publishes' });
await post('/access', { role: editorRole.id, policy: editorPolicy.id });
const publicPolicy = (await get('/policies?filter[admin_access][_eq]=false&limit=50')).find((p) => p.name === '$t:public_label' || /public/i.test(p.name));
if (!publicPolicy) throw new Error('no public policy found — Directus should create one at bootstrap');

await post('/permissions', { policy: publicPolicy.id, collection: 'articles', action: 'read', permissions: { status: { _eq: 'published' } }, fields: ['*'] });
await post('/permissions', { policy: publicPolicy.id, collection: 'authors', action: 'read', permissions: {}, fields: ['*'] });
await post('/permissions', { policy: editorPolicy.id, collection: 'articles', action: 'read', permissions: {}, fields: ['*'] });
await post('/permissions', { policy: editorPolicy.id, collection: 'articles', action: 'create', permissions: {}, fields: ['*'] });
await post('/permissions', { policy: editorPolicy.id, collection: 'articles', action: 'update', permissions: { owner: { _eq: '$CURRENT_USER' } }, fields: ['*'] });
await post('/permissions', { policy: editorPolicy.id, collection: 'articles', action: 'delete', permissions: { _or: [{ owner: { _eq: '$CURRENT_USER' } }, { status: { _eq: 'draft' } }] }, fields: ['*'] });
await post('/permissions', { policy: editorPolicy.id, collection: 'authors', action: 'read', permissions: { _and: [{ name: { _nnull: true } }, { email: { _ncontains: 'spam' } }] }, fields: ['*'] });

/* ---------------------------------- users ---------------------------------- */
const ada = await post('/users', { email: 'ada@example.com', password: 'ada-password-1', first_name: 'Ada', last_name: 'Lovelace', role: editorRole.id, status: 'active' });
await post('/users', { email: 'grace@example.com', password: 'grace-password-1', first_name: 'Grace', status: 'suspended' });
await post('/users', { email: 'sso@example.com', first_name: 'Single', last_name: 'Sign-on', provider: 'google', external_identifier: 'google-sub-123', status: 'active' });

/* ---------------------------------- items ---------------------------------- */
const a1 = await post('/items/authors', { name: 'Grace Hopper', email: 'grace@example.com' });
const a2 = await post('/items/authors', { name: 'Alan Turing', email: 'alan@example.com' });
const art1 = await post('/items/articles', { title: 'The First Compiler', status: 'published', body: 'A-0.', tags: ['history'], author: a1.id, owner: ada.id, published_at: '2026-01-01T10:00:00Z' });
const art2 = await post('/items/articles', { title: 'On Computable Numbers', status: 'published', body: 'Entscheidungsproblem.', author: a2.id, owner: ada.id });
await post('/items/articles', { title: 'Unfinished thoughts', status: 'draft', body: '…', author: a1.id, owner: ada.id });
const t1 = await post('/items/topics', { label: 'History' });
const t2 = await post('/items/topics', { label: 'Theory' });
await post('/items/articles_topics', { articles_id: art1.id, topics_id: t1.id });
await post('/items/articles_topics', { articles_id: art2.id, topics_id: t2.id });
await post('/items/articles_topics', { articles_id: art2.id, topics_id: t1.id });

/* ---------------------------------- a file ---------------------------------- */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(1)]); // 72 bytes
const form = new FormData();
form.append('title', 'Cover');
form.append('file', new Blob([png], { type: 'image/png' }), 'cover.png');
const fileRes = await fetch(B + '/files', { method: 'POST', headers: auth, body: form });
const file = (await fileRes.json()).data;
if (!fileRes.ok) throw new Error('file upload failed ' + JSON.stringify(file));
await patch(`/items/articles/${art1.id}`, { cover: file.id });

/* ---------------------------------- a flow ---------------------------------- */
const flow = await post('/flows', { name: 'Notify on publish', status: 'active', trigger: 'event', accountability: 'all', options: { type: 'action', scope: ['items.update'], collections: ['articles'] } });
const op = await post('/operations', { flow: flow.id, name: 'Log it', key: 'log_it', type: 'log', position_x: 19, position_y: 1, options: { message: 'published {{$trigger.keys}}' } });
await patch(`/flows/${flow.id}`, { operation: op.id });

console.log('fixture ready:', JSON.stringify({ editorRole: editorRole.id, publicPolicy: publicPolicy.id, file: file.id }));
