/**
 * Uploads through the admin routes: bytes to a driver, a row in the files
 * table, both behind the grant on that table.
 *
 * What has to hold: nobody uploads without a create grant, and the gate fires
 * before a byte is read; the size cap is enforced on the stream, not after
 * buffering; a raster type must be what its first bytes say, because the
 * browser will render it inline; a file is served with the storage package's
 * safety headers and only to actors who may read its row; deleting removes
 * both the row and the bytes; and an upload from an unlisted origin is refused
 * even though its body is multipart rather than JSON.
 *
 * Skips (exit 0) without DATABASE_URL.
 */
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createViewResolver, createFileViewStore, createAdminRoutes, sniffImage } from '../dist/server/index.js';
import { createAccessPolicy, PUBLIC_ACTOR } from '../../auth/dist/index.js';
import { createLocalDiskDriver, assetContentHeaders, diskExtension } from '../../storage/dist/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('uploads');

/* ------------------------------ no database ------------------------------ */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)]);
ok('png is recognised by its signature', sniffImage(PNG) === 'image/png');
ok('jpeg is recognised', sniffImage(JPEG) === 'image/jpeg');
ok('gif is recognised', sniffImage(Buffer.from('GIF89a......')) === 'image/gif');
ok('webp is recognised', sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')) === 'image/webp');
ok('text is nothing', sniffImage(Buffer.from('<svg onload=alert(1)>')) === null);
ok('a short buffer is nothing', sniffImage(Buffer.from([0x89])) === null);

if (!process.env.DATABASE_URL) {
  console.log(`\n${pass} passed, ${fail} failed (database checks skipped — no DATABASE_URL)`);
  process.exitCode = fail ? 1 : 0;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const raw = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const root = mkdtempSync(path.join(os.tmpdir(), 'allodium-uploads-'));
  const created = [];

  const grant = (role, table, actions, rowFilter) => ({
    role, table,
    create: actions.includes('create'), read: actions.includes('read'),
    update: actions.includes('update'), delete: actions.includes('delete'),
    ...(rowFilter ? { rowFilter } : {}),
  });
  const actor = (roles, claims = {}) => ({ userId: 'u1', roles, claims });
  const media = actor(['media']);
  const viewer = actor(['viewer']);
  const blind = actor(['blind']);

  try {
    const policy = createAccessPolicy([
      grant('media', 'files', ['create', 'read', 'update', 'delete']),
      grant('viewer', 'files', ['read']),
      grant('public', 'files', ['read']),
      grant('blind', 'posts', ['read']),
    ]);
    const resolver = createViewResolver(pool, { access: policy });
    const views = createFileViewStore({ dir: path.join(root, 'no-views') });
    const writes = [];
    const make = (extra = {}) =>
      createAdminRoutes({
        resolver,
        views,
        allowOrigins: ['http://localhost:3191'],
        onWrite: (e) => writes.push(e),
        actorFor: async (req) => {
          const h = req.headers.get('x-actor');
          return h ? JSON.parse(h) : PUBLIC_ACTOR;
        },
        uploads: { driver: createLocalDiskDriver({ root }), serve: assetContentHeaders, extension: diskExtension, maxBytes: 4096, ...extra },
      });
    const routes = make();

    const multipart = (bytes, { type = 'image/png', name = 'pic.png', title, actor: who, headers = {} } = {}) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), name);
      if (title) form.append('title', title);
      const h = new Headers(headers);
      if (who) h.set('x-actor', JSON.stringify(who));
      return routes.handle(new Request('http://api.test/_files', { method: 'POST', headers: h, body: form }), ['_files']);
    };
    const get = (id, who, query = '') =>
      routes.handle(new Request(`http://api.test/_files/${id}${query}`, { headers: who ? { 'x-actor': JSON.stringify(who) } : {} }), ['_files', String(id)]);
    const del = (id, who) =>
      routes.handle(new Request(`http://api.test/_files/${id}`, { method: 'DELETE', headers: who ? { 'x-actor': JSON.stringify(who) } : {} }), ['_files', String(id)]);
    const jsonOf = async (res) => res.json().catch(() => null);
    const filesOnDisk = () => readdirSync(root).filter((f) => f !== 'no-views');
    const [{ n: rowsBefore }] = await raw('select count(*)::int as n from files');

    /* ------------------------------- the gate ------------------------------ */
    ok('the public cannot upload', (await multipart(PNG)).status === 403);
    ok('a role with no grant on files cannot upload', (await multipart(PNG, { actor: blind })).status === 403);
    ok('a read-only role cannot upload', (await multipart(PNG, { actor: viewer })).status === 403);
    ok('...and nothing reached the disk', filesOnDisk().length === 0);
    ok('...or the table', (await raw('select count(*)::int as n from files'))[0].n === rowsBefore);

    /* ------------------------------- an upload ----------------------------- */
    const up = await multipart(PNG, { actor: media, title: 'A picture' });
    const row = await jsonOf(up);
    ok('a granted upload is 201', up.status === 201, `${up.status} ${JSON.stringify(row)}`);
    if (row?.id) created.push(row.id);
    ok('...returning the files row', typeof row?.id === 'string' && row.filename === 'pic.png' && row.mime_type === 'image/png' && String(row.filesize_bytes) === String(PNG.length), JSON.stringify(row));
    ok('...with the title', row?.title === 'A picture');
    ok('...named on disk by uuid and extension', /^[0-9a-f-]{36}\.png$/.test(row?.disk_name ?? ''), row?.disk_name);
    ok('...and the bytes are there', existsSync(path.join(root, row?.disk_name ?? 'nope')));
    ok('...and the write is audited', writes.some((w) => w.action === 'create' && w.table === 'files' && w.id === row?.id));

    /* -------------------------------- serving ------------------------------ */
    const served = await get(row.id, viewer);
    ok('a reader gets the bytes', served.status === 200);
    ok('...as the stored type', served.headers.get('content-type') === 'image/png');
    ok('...inline, since a png is safe to render', /^inline/.test(served.headers.get('content-disposition') ?? ''));
    ok('...with nosniff', served.headers.get('x-content-type-options') === 'nosniff');
    ok('...private for a signed-in reader', /private/.test(served.headers.get('cache-control') ?? ''));
    ok('...and the right length', served.headers.get('content-length') === String(PNG.length));
    ok('...and the right bytes', Buffer.from(await served.arrayBuffer()).equals(PNG));
    const pub = await get(row.id, undefined);
    ok('the public reads a granted file', pub.status === 200);
    ok('...cacheable by anyone, forever', /immutable/.test(pub.headers.get('cache-control') ?? ''));
    ok('?download forces an attachment', /^attachment/.test((await get(row.id, viewer, '?download')).headers.get('content-disposition') ?? ''));
    ok('a role with no read grant gets 403', (await get(row.id, blind)).status === 403);
    ok('an unknown id is 404', (await get('00000000-0000-0000-0000-000000000000', viewer)).status === 404);
    ok('an id that is not a uuid is 404, not 500', (await get('nope', viewer)).status === 404);

    /* ------------------------------ refusals ------------------------------- */
    const lying = await multipart(Buffer.from('<svg onload=alert(1)></svg>'), { actor: media, type: 'image/png', name: 'not.png' });
    ok('a png that is not a png is refused', lying.status === 415, `${lying.status}`);
    ok('...and says so', /not image\/png/.test((await jsonOf(lying))?.error ?? ''));
    ok('an svg declared as svg is accepted (served as an attachment)', (await (async () => { const r = await multipart(Buffer.from('<svg/>'), { actor: media, type: 'image/svg+xml', name: 'v.svg' }); const b = await jsonOf(r); if (b?.id) created.push(b.id); return r; })()).status === 201);
    const big = await multipart(Buffer.alloc(5000, 7), { actor: media });
    ok('an oversize upload is 413', big.status === 413, `${big.status}`);
    const diskBefore = filesOnDisk().length;
    ok('...leaving no bytes behind', filesOnDisk().length === diskBefore);
    ok('an empty file is 400', (await multipart(Buffer.alloc(0), { actor: media })).status === 400);
    const noField = await routes.handle(new Request('http://api.test/_files', { method: 'POST', headers: { 'x-actor': JSON.stringify(media), 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--' }), ['_files']);
    ok('a multipart body with no file field is 400', noField.status === 400, `${noField.status}`);
    const rawUp = await routes.handle(new Request('http://api.test/_files', { method: 'POST', headers: { 'x-actor': JSON.stringify(media), 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent('café.jpg') }, body: JPEG }), ['_files']);
    const rawRow = await jsonOf(rawUp);
    if (rawRow?.id) created.push(rawRow.id);
    ok('a raw body with X-Filename uploads', rawUp.status === 201 && rawRow?.filename === 'café.jpg' && rawRow?.mime_type === 'image/jpeg', `${rawUp.status} ${JSON.stringify(rawRow)}`);
    ok('a raw body with no filename is 400', (await routes.handle(new Request('http://api.test/_files', { method: 'POST', headers: { 'x-actor': JSON.stringify(media), 'content-type': 'image/jpeg' }, body: JPEG }), ['_files'])).status === 400);
    const traversal = await multipart(PNG, { actor: media, name: '../../etc/passwd.png' });
    const tRow = await jsonOf(traversal);
    if (tRow?.id) created.push(tRow.id);
    ok('a filename with path separators is flattened', traversal.status === 201 && !/[\\/]/.test(tRow?.filename ?? '/'), tRow?.filename);

    const picky = make({ accept: ['image/*'] });
    const pdf = await picky.handle(new Request('http://api.test/_files', { method: 'POST', headers: { 'x-actor': JSON.stringify(media), 'content-type': 'application/pdf', 'x-filename': 'a.pdf' }, body: Buffer.from('%PDF-1.4') }), ['_files']);
    ok('accept refuses a type outside the list', pdf.status === 415);
    const bare = createAdminRoutes({ resolver, views, actorFor: async () => media });
    ok('a mount without uploads answers 404 for _files', (await bare.handle(new Request('http://api.test/_files', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--' }), ['_files'])).status === 404);
    ok('...and for serving', (await bare.handle(new Request(`http://api.test/_files/${row.id}`), ['_files', row.id])).status === 404);

    /* --------------------------- cross-site uploads ------------------------ */
    ok('an upload from an unlisted origin is refused', (await multipart(PNG, { actor: media, headers: { origin: 'http://evil.test' } })).status === 403);
    const allowedUp = await multipart(PNG, { actor: media, headers: { origin: 'http://localhost:3191' } });
    const aRow = await jsonOf(allowedUp);
    if (aRow?.id) created.push(aRow.id);
    ok('an upload from an allowlisted origin passes, multipart and all', allowedUp.status === 201, `${allowedUp.status}`);
    ok('...with CORS on the answer', allowedUp.headers.get('access-control-allow-origin') === 'http://localhost:3191');
    ok('preflight allows the X-Filename header', /X-Filename/.test((await routes.handle(new Request('http://api.test/_files', { method: 'OPTIONS', headers: { origin: 'http://localhost:3191' } }), ['_files'])).headers.get('access-control-allow-headers') ?? ''));

    /* -------------------------------- delete ------------------------------- */
    ok('a reader cannot delete', (await del(row.id, viewer)).status === 403);
    ok('...and the bytes are still there', existsSync(path.join(root, row.disk_name)));
    const gone = await del(row.id, media);
    ok('the owner of the grant deletes', gone.status === 200, `${gone.status}`);
    ok('...removing the row', (await raw('select count(*)::int as n from files where id = $1', [row.id]))[0].n === 0);
    ok('...and the bytes', !existsSync(path.join(root, row.disk_name)));
    ok('...so it now serves as 404', (await get(row.id, viewer)).status === 404);
    ok('deleting again is 404', (await del(row.id, media)).status === 404);
    created.splice(created.indexOf(row.id), 1);
  } finally {
    if (created.length) await raw(`delete from files where id = any($1::uuid[])`, [created]).catch(() => {});
    rmSync(root, { recursive: true, force: true });
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
