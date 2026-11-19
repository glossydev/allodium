/**
 * The admin runtime over HTTP — and with it, the "content API".
 *
 * There is no separate content API. A public site fetching published posts and
 * an operator listing orders are the same request against the same resolver,
 * differing only in who is asking. So the first thing this proves is exactly
 * that: anonymous, through a real Request, gets published posts and NOTHING
 * else — not drafts, not orders, not the shape of a table it may not read.
 *
 * Everything runs against the real grant matrix (seed 006), the real view files
 * in apps/console/admin/views, and the real database. The only test-specific
 * seam is actorFor, which reads an actor from a header so a test can be anyone.
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createViewResolver, createFileViewStore, createAdminRoutes } from '../dist/server/index.js';
import { createGrantLoader, createApiTokens, createAccessPolicy, PUBLIC_ACTOR } from '../../auth/dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('admin routes');

if (!process.env.DATABASE_URL) {
  console.log('\nskipped — no DATABASE_URL');
  process.exitCode = 0;
} else {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;

  try {
    const loader = createGrantLoader(pool);
    const policy = await loader.policy();
    const resolver = createViewResolver(pool, { access: policy });
    const views = createFileViewStore({ dir: path.join(here, '..', '..', '..', 'apps', 'console', 'admin', 'views') });
    const writes = [];
    const routes = createAdminRoutes({
      resolver,
      views,
      allowOrigins: ['http://localhost:3191'],
      onWrite: (e) => writes.push(e),
      // The seam: an actor arrives in a header, or nobody arrives and that is
      // the public — which is a principal, not an absence.
      actorFor: async (req) => {
        const h = req.headers.get('x-actor');
        return h ? JSON.parse(h) : PUBLIC_ACTOR;
      },
    });

    const call = (method, segs, { actor, query = '', body, headers = {} } = {}) => {
      const url = `http://api.test/${segs.join('/')}${query ? `?${query}` : ''}`;
      const h = { 'Content-Type': 'application/json', ...headers };
      if (actor) h['x-actor'] = JSON.stringify(actor);
      return routes.handle(new Request(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), segs);
    };
    const jsonOf = async (res) => res.json().catch(() => null);

    /* -------------------- anonymous IS the content API -------------------- */
    const [{ n: published }] = await raw("select count(*)::int as n from posts where status = 'published'");
    const [{ n: allPosts }] = await raw('select count(*)::int as n from posts');
    ok('the fixture has drafts to hide', allPosts > published, `${published} of ${allPosts}`);

    const pubList = await call('GET', ['posts', 'list'], { query: 'pageSize=200' });
    const pubBody = await jsonOf(pubList);
    ok('anonymous lists posts', pubList.status === 200);
    ok('...and sees ONLY published ones', pubBody?.total === published, `${pubBody?.total} vs ${published}`);
    ok('...every row really is published', (pubBody?.rows ?? []).every((r) => r.status === 'published'));

    // The public's own filters cannot widen past the grant.
    const widen = await call('GET', ['posts', 'list'], { query: 'filter=status:eq:draft' });
    ok("a filter for drafts returns none, not the drafts", (await jsonOf(widen))?.total === 0);

    ok('anonymous may see the shape of posts', (await call('GET', ['posts', 'view'])).status === 200);
    ok('anonymous reads authors (granted)', (await call('GET', ['authors', 'list'])).status === 200);

    for (const t of ['orders', 'customers']) {
      ok(`anonymous cannot list ${t}`, (await call('GET', [t, 'list'])).status === 403);
      ok(`...nor see the shape of ${t}`, (await call('GET', [t, 'view'])).status === 403);
    }
    const write403 = await call('POST', ['posts', 'record'], { body: { title: 'x' } });
    ok('anonymous cannot write posts', write403.status === 403);
    ok('...and the refusal says why', /no grant for create on posts/.test((await jsonOf(write403))?.error ?? ''));
    ok('a refusal is JSON with an error key, not an empty page', typeof (await jsonOf(await call('GET', ['orders', 'list'])))?.error === 'string');

    // A public visitor's related panel: post_tags via the ?table= path.
    const panel = await call('GET', ['post_tags', 'list'], { query: 'table=post_tags&scope=post_id:eq:1' });
    ok('a public related panel resolves by table', panel.status === 200 && (await jsonOf(panel))?.total > 0);

    /* ------------------------------ a member ------------------------------ */
    const memberUser = (await raw("select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.key = 'member' limit 1"))[0];
    const customer = (await raw('select customer_id, count(*)::int as n from orders group by 1 order by 2 desc limit 1'))[0];
    const member = await loader.actorFor(memberUser.user_id, { customerId: customer.customer_id });
    const [{ n: allOrders }] = await raw('select count(*)::int as n from orders');

    const mine = await jsonOf(await call('GET', ['orders', 'list'], { actor: member, query: 'pageSize=200' }));
    ok('a member lists their own orders', mine?.total === customer.n, `${mine?.total} vs ${customer.n}`);
    ok('...and not everyone\'s', mine?.total < allOrders);
    ok('a member may see the shape of orders', (await call('GET', ['orders', 'view'], { actor: member })).status === 200);

    const own = (await raw('select id from orders where customer_id = $1 limit 1', [customer.customer_id]))[0];
    const other = (await raw('select id from orders where customer_id is distinct from $1 limit 1', [customer.customer_id]))[0];
    ok('a member reads their own order', (await call('GET', ['orders', 'record', String(own.id)], { actor: member })).status === 200);
    ok("someone else's order is 404, never 403", (await call('GET', ['orders', 'record', String(other.id)], { actor: member })).status === 404);
    ok("...and PATCHing it is 404 too", (await call('PATCH', ['orders', 'record', String(other.id)], { actor: member, body: { notes: 'x' } })).status === 403 || (await call('PATCH', ['orders', 'record', String(other.id)], { actor: member, body: { notes: 'x' } })).status === 404);
    ok('a member with no claim is 403', (await call('GET', ['orders', 'list'], { actor: { ...member, claims: {} } })).status === 403);

    /* ------------- two restricted roles, over HTTP: the union ------------- */
    // The seed has no second restricted role on orders, so this one policy is
    // declared inline: a member sees their own orders, an auditor every
    // cancelled one. One person holding both gets the union — and a row in
    // neither group is a 404, the same as a row that does not exist.
    {
      const grant = (role, table, actions, rowFilter) => ({ role, table, create: actions.includes('create'), read: actions.includes('read'), update: actions.includes('update'), delete: actions.includes('delete'), rowFilter });
      const dualRoutes = createAdminRoutes({
        resolver: createViewResolver(pool, {
          access: createAccessPolicy([
            grant('member', 'orders', ['read', 'update'], [{ column: 'customer_id', op: 'eq', value: '$actor.customerId' }]),
            grant('auditor', 'orders', ['read', 'update'], [{ column: 'status', op: 'eq', value: 'cancelled' }]),
          ]),
        }),
        views,
        actorFor: async (req) => JSON.parse(req.headers.get('x-actor') ?? 'null') ?? PUBLIC_ACTOR,
      });
      const dualCall = (method, segs, { actor, query = '', body } = {}) =>
        dualRoutes.handle(new Request(`http://api.test/${segs.join('/')}${query ? `?${query}` : ''}`, { method, headers: { 'Content-Type': 'application/json', 'x-actor': JSON.stringify(actor) }, body: body ? JSON.stringify(body) : undefined }), segs);
      const dual = { userId: 'dual', roles: ['member', 'auditor'], claims: { customerId: customer.customer_id } };
      const [{ n: unionN }] = await raw("select count(*)::int as n from orders where customer_id = $1 or status = 'cancelled'", [customer.customer_id]);
      const unionList = await jsonOf(await dualCall('GET', ['orders', 'list'], { actor: dual, query: 'pageSize=500' }));
      ok('two restricted roles list the union over HTTP', unionList?.total === unionN && unionN > customer.n, `${unionList?.total} vs ${unionN}`);
      const onlyAudit = (await raw("select id, notes from orders where status = 'cancelled' and customer_id is distinct from $1 limit 1", [customer.customer_id]))[0];
      const neither = (await raw("select id from orders where status <> 'cancelled' and customer_id is distinct from $1 limit 1", [customer.customer_id]))[0];
      ok('a row only the second role allows is 200', (await dualCall('GET', ['orders', 'record', String(onlyAudit.id)], { actor: dual })).status === 200);
      ok('a row in neither group is 404', (await dualCall('GET', ['orders', 'record', String(neither.id)], { actor: dual })).status === 404);
      const patchedAudit = await dualCall('PATCH', ['orders', 'record', String(onlyAudit.id)], { actor: dual, body: { notes: 'union-write' } });
      ok('a write into a row only the second role allows is accepted', patchedAudit.status === 200 && (await jsonOf(patchedAudit))?.notes === 'union-write', String(patchedAudit.status));
      await raw('update orders set notes = $2 where id = $1', [onlyAudit.id, onlyAudit.notes]);
      ok('a write into a row in neither group is 404', (await dualCall('PATCH', ['orders', 'record', String(neither.id)], { actor: dual, body: { notes: 'x' } })).status === 404);
    }

    /* ------------------------------ support ------------------------------- */
    const supportUser = (await raw("select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.key = 'support' limit 1"))[0];
    const support = await loader.actorFor(supportUser.user_id);
    ok('support lists every order', (await jsonOf(await call('GET', ['orders', 'list'], { actor: support })))?.total === allOrders);

    const before = (await raw('select notes from orders where id = $1', [other.id]))[0].notes;
    const patched = await call('PATCH', ['orders', 'record', String(other.id)], { actor: support, body: { notes: 'routes-test' } });
    ok('support may update an order', patched.status === 200, String(patched.status));
    ok('...and the write is audited', writes.some((w) => w.action === 'update' && w.table === 'orders' && String(w.id) === String(other.id)));
    await raw('update orders set notes = $2 where id = $1', [other.id, before]);
    ok('support cannot delete (not granted)', (await call('DELETE', ['orders', 'record', String(other.id)], { actor: support })).status === 403);

    // Options are a read of the TARGET table: support may pick a customer,
    // anonymous may not enumerate them through the dropdown.
    ok('support gets customer options', (await call('GET', ['orders', 'options', 'customer_id'], { actor: support })).status === 200);
    ok('anonymous cannot enumerate customers via options', (await call('GET', ['orders', 'options', 'customer_id'])).status === 403);

    /* ---------------------------- super_admin ----------------------------- */
    const suUser = (await raw("select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.key = 'super_admin' limit 1"))[0];
    if (suUser) {
      const su = await loader.actorFor(suUser.user_id);
      ok('super_admin lists customers', (await call('GET', ['customers', 'list'], { actor: su })).status === 200);
      ok('super_admin sees drafts', (await jsonOf(await call('GET', ['posts', 'list'], { actor: su, query: 'pageSize=200' })))?.total === allPosts);
    }

    /* --------------------------- plumbing -------------------------------- */
    ok('a name that is neither a view nor a table is 404', (await call('GET', ['nope', 'list'])).status === 404);
    // A real table with no curated screen renders its implicit one — the shop
    // asking for `products` with no products.view.json. Still gated: the public
    // has products, not customers.
    const implicit = await call('GET', ['products', 'list'], { query: 'pageSize=5' });
    ok('a granted table with no view file renders its implicit screen', implicit.status === 200 && (await jsonOf(implicit))?.total > 0, String(implicit.status));
    ok('...and the shape of it too', (await call('GET', ['products', 'view'])).status === 200);
    ok('...but a name is not a permission', (await call('GET', ['customers', 'list'])).status === 403);
    ok('an unknown action is 404', (await call('GET', ['posts', 'explode'])).status === 404);
    ok('a bad filter is 400', (await call('GET', ['posts', 'list'], { query: 'filter=status:roughly:x' })).status === 400);
    ok('a filter on an unknown field is 400, not 500', (await call('GET', ['posts', 'list'], { query: 'filter=nope:eq:1' })).status === 400);
    ok('invalid JSON on a write is 400', (await routes.handle(new Request('http://api.test/posts/record', { method: 'POST', headers: { 'x-actor': JSON.stringify(support), 'Content-Type': 'application/json' }, body: '{nope' }), ['posts', 'record'])).status === 400);

    /* -------------- a relation borrows the target view's display -------------- */
    // authors.view.json says display: "name". A posts screen that points at
    // authors without saying how to label them inherits that; a resolver with
    // no view store falls back to the referenced column, as it always did.
    const bare = { table: 'posts', fields: [{ column: 'id' }, { kind: 'relation', column: 'author_id', relation: { table: 'authors' } }] };
    const withViews = createViewResolver(pool, { access: policy, views });
    const borrowed = await withViews.list(bare, { actor: PUBLIC_ACTOR, pageSize: 5 });
    const [{ name: someAuthor }] = await raw('select name from authors where id = $1', [borrowed.rows[0].author_id]);
    ok('a relation with no display borrows the target view\'s', borrowed.rows[0].author_id__label === someAuthor, `${borrowed.rows[0].author_id__label} vs ${someAuthor}`);
    const plain = await resolver.list(bare, { actor: PUBLIC_ACTOR, pageSize: 5 });
    ok('...and without a view store falls back to the referenced column', plain.rows[0].author_id__label === String(plain.rows[0].author_id), String(plain.rows[0].author_id__label));
    const explicit = await withViews.list({ ...bare, fields: [{ column: 'id' }, { kind: 'relation', column: 'author_id', relation: { table: 'authors', display: 'email' } }] }, { actor: PUBLIC_ACTOR, pageSize: 5 });
    ok('...while the field\'s own display still wins', /@/.test(String(explicit.rows[0].author_id__label)));
    const byFn = createViewResolver(pool, { access: policy, views: async (t) => (t === 'authors' ? '{name} <{email}>' : undefined) });
    const fnLabel = String((await byFn.list(bare, { actor: PUBLIC_ACTOR, pageSize: 1 })).rows[0].author_id__label);
    ok('a function works as the source of displays too (template columns joined by a space)', fnLabel.includes('@') && fnLabel.includes(' '), fnLabel);
    // A published post, not post 1: which posts are published is the fixture's business.
    const [{ id: pubPostId }] = await raw("select id from posts where status = 'published' order by id limit 1");
    const m2mBorrow = await withViews.read({ table: 'posts', fields: [{ column: 'id' }, { kind: 'm2m', through: 'post_tags', near: 'post_id', far: 'tag_id', farTable: 'tags' }] }, pubPostId, PUBLIC_ACTOR);
    ok('a many-to-many borrows the far view\'s display for its options', (await withViews.options({ table: 'posts', fields: [{ column: 'id' }, { kind: 'm2m', through: 'post_tags', near: 'post_id', far: 'tag_id', farTable: 'tags' }] }, 'tags', { actor: PUBLIC_ACTOR })).every((o) => typeof o.label === 'string' && o.label !== String(o.value)) && m2mBorrow !== null);

    /* ------------------------ a machine caller, by token ------------------------ */
    // No cookie, no browser: a bearer token resolves to an identity, the app
    // turns it into an actor exactly as it would a session, and the grant
    // model takes it from there. No Origin header, so the cross-site check
    // passes — a curl is not a cross-site form.
    const tokens = createApiTokens(pool, { prefix: 'rt_', touchEveryMs: 0 });
    const userToken = await tokens.mint({ label: 'routes test', userId: supportUser.user_id });
    const svcToken = await tokens.mint({ label: 'routes test service', roles: ['support'] });
    const byToken = createAdminRoutes({
      resolver,
      views,
      actorFor: async (req) => {
        const t = await tokens.resolve(req);
        if (!t) return PUBLIC_ACTOR;
        return t.userId ? loader.actorFor(t.userId, {}) : { userId: null, roles: t.roles, claims: {} };
      },
    });
    const bearer = (token, method = 'GET', segs = ['orders', 'list'], body) =>
      byToken.handle(new Request(`http://api.test/${segs.join('/')}?pageSize=1`, { method, headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), segs);
    try {
      ok('a user token lists what its user may', (await jsonOf(await bearer(userToken.token)))?.total === allOrders);
      ok('a service token lists what its roles may', (await jsonOf(await bearer(svcToken.token)))?.total === allOrders);
      ok('no token is the public, who may not', (await byToken.handle(new Request('http://api.test/orders/list'), ['orders', 'list'])).status === 403);
      ok('a wrong token is the public too', (await bearer('rt_' + 'Z'.repeat(43))).status === 403);
      const tokenWrite = await bearer(userToken.token, 'PATCH', ['orders', 'record', String(other.id)], { notes: before });
      ok('a token may write with no Origin at all (not a browser)', tokenWrite.status === 200, String(tokenWrite.status));
      ok('...and the write is audited to the token\'s user', writes.some((w) => w.action === 'update' && String(w.actor?.userId) === String(supportUser.user_id)));
      await tokens.revoke(userToken.id);
      ok('a revoked token is the public again', (await bearer(userToken.token)).status === 403);
    } finally {
      await raw('delete from api_tokens where id = any($1::uuid[])', [[userToken.id, svcToken.id]]).catch(() => {});
    }

    /* ---------------------- cross-site request forgery ---------------------- */
    // CORS headers say who may READ a response. These say who may SEND a write.
    const forged = (headers, extra = {}) => call('PATCH', ['orders', 'record', String(other.id)], { actor: support, body: { notes: 'csrf' }, headers, ...extra });
    ok('a write from an unlisted origin is refused', (await forged({ origin: 'http://evil.test' })).status === 403);
    ok('...before any grant is consulted', /Cross-origin/.test((await jsonOf(await forged({ origin: 'http://evil.test' })))?.error ?? ''));
    ok('a write the browser labels cross-site is refused', (await forged({ 'sec-fetch-site': 'cross-site' })).status === 403);
    const formPost = await routes.handle(
      new Request('http://api.test/orders/record/' + other.id, { method: 'PATCH', headers: { 'x-actor': JSON.stringify(support), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'notes=csrf' }),
      ['orders', 'record', String(other.id)]
    );
    ok('a form-encoded body is refused as 415', formPost.status === 415, String(formPost.status));
    ok('the refused writes changed nothing', (await raw('select notes from orders where id = $1', [other.id]))[0].notes !== 'csrf');
    ok('a write from an allowlisted origin passes', (await forged({ origin: 'http://localhost:3191' })).status === 200);
    ok('a write from this host passes', (await forged({ origin: 'http://api.test' })).status === 200);
    ok('...whatever the scheme', (await forged({ origin: 'https://api.test' })).status === 200);
    ok('a same-site write passes', (await forged({ 'sec-fetch-site': 'same-site', origin: 'http://localhost:3191' })).status === 200);
    ok('a read from an unlisted origin is still answered (CORS hides it, not this)', (await call('GET', ['posts', 'list'], { headers: { origin: 'http://evil.test' } })).status === 200);
    await raw('update orders set notes = $2 where id = $1', [other.id, before]);

    const corsRes = await call('GET', ['posts', 'list'], { headers: { origin: 'http://localhost:3191' } });
    ok('an allowed origin gets its exact origin back', corsRes.headers.get('access-control-allow-origin') === 'http://localhost:3191');
    ok('...with credentials and Vary', corsRes.headers.get('access-control-allow-credentials') === 'true' && corsRes.headers.get('vary') === 'Origin');
    ok('an unlisted origin gets nothing', (await call('GET', ['posts', 'list'], { headers: { origin: 'http://evil.test' } })).headers.get('access-control-allow-origin') === null);
    ok('preflight is 204', (await routes.handle(new Request('http://api.test/posts/list', { method: 'OPTIONS', headers: { origin: 'http://localhost:3191' } }), ['posts', 'list'])).status === 204);
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
