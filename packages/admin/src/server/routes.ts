import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { parseFilterParams, validateFilter, type ViewDefinition } from '../view.js';
import type { ViewResolver } from './resolver.js';
import type { ViewStore } from './views.js';

/**
 * The admin runtime as HTTP.
 *
 * The console has served these endpoints from hand-written handlers since the
 * Admin Builder existed, and a deployed dashboard needs the same six — plus the
 * one thing the console never needed, which is knowing WHO is asking. This is
 * that: the same resolver, behind a gate, with an actor on every call.
 *
 * There is deliberately no separate "content API". A public site fetching
 * published posts and an operator listing orders are the same request against
 * the same resolver; the only difference is the actor, and anonymous is an actor
 * with a role and grants of its own. One enforcement path, or two that drift.
 *
 * Framework-free: a Web Request and the path segments after wherever this was
 * mounted, a Web Response back. `[...path]` in Next, a wildcard in Hono, a
 * split() in plain Node. No env vars are read here.
 *
 * URL contract — fixed, because `@allodium/admin/react` speaks it:
 *   GET    <view>/view                 the ResolvedView the client renders from
 *   GET    <view>/list?…               rows: page, search, sort, direction, filter*, scope*, table
 *   GET    <view>/record/<id>
 *   POST   <view>/record
 *   PATCH  <view>/record/<id>          (PUT accepted)
 *   DELETE <view>/record/<id>
 *   GET    <view>/options/<field>?search=
 * and, when `uploads` is configured, under the reserved name `_files`:
 *   POST   _files                      upload (multipart "file" [+ "title"], or a raw body + X-Filename) → the files row, 201
 *   GET    _files/<id>[?download]      the bytes, with the safe serving headers
 *   DELETE _files/<id>                 the row and the bytes
 */

/**
 * The byte store, as this package needs to see it — the shape of
 * `@allodium/storage`'s StorageDriver, declared structurally because neither
 * package imports the other.
 */
export interface StorageDriverLike {
  put(diskName: string, data: Buffer): Promise<void>;
  stream(diskName: string): Promise<{ stream: Readable; size: number } | null>;
  delete(diskName: string): Promise<void>;
}

/**
 * Uploads through the admin: bytes to a driver, metadata to a files table,
 * both gated by the grant on that table. A `file` widget on a relation field
 * is the form's end of this.
 */
export interface UploadOptions {
  driver: StorageDriverLike;
  /**
   * The headers a stored file is served with. Pass `@allodium/storage`'s
   * `assetContentHeaders`. Required rather than defaulted so the one policy
   * that keeps an uploaded SVG from becoming a script on your origin lives in
   * one place and is not re-derived here.
   */
  serve(opts: { type: string | null | undefined; size: number; downloadName: string; forceDownload?: boolean; isProtected?: boolean }): Record<string, string>;
  /**
   * The on-disk extension for an upload. `@allodium/storage`'s `diskExtension`
   * knows MIME types; the default takes the client filename's extension when
   * it is a simple one and stores everything else as "bin".
   */
  extension?(mimeType: string | null, filename: string): string;
  /** The files table. Default "files", in the shape the console's Files silo expects. */
  table?: string;
  /** Its column names, when they differ from disk_name / filename / mime_type / filesize_bytes / title. */
  columns?: Partial<{ diskName: string; filename: string; mimeType: string; size: string; title: string }>;
  /** Largest upload accepted. Default 10 MiB. Enforced on the stream, before anything is buffered. */
  maxBytes?: number;
  /** Only these MIME types — exact, or "image/*". Default: anything; the serving headers keep unsafe types from rendering inline. */
  accept?: string[];
}

export interface AdminRoutesOptions {
  /** Built with a real `access` policy. Building it 'unrestricted' here is the console's job, not yours. */
  resolver: ViewResolver;
  views: ViewStore;
  /**
   * Who is asking. REQUIRED, called on every request.
   *
   * Resolve the session cookie to an actor, and return your public actor for
   * a request with no session — anonymous is a principal with grants, not a
   * missing one. There is no default, because the wrong default is every table
   * readable by anyone with the URL.
   */
  actorFor(request: Request): Promise<unknown>;
  /** Exact origins allowed to call with credentials. Omit for same-origin. */
  allowOrigins?: string[] | ((origin: string) => boolean);
  /** Every successful write, for an audit log. */
  onWrite?(event: { action: 'create' | 'update' | 'delete'; table: string; id: unknown; actor: unknown }): void;
  /** File uploads and serving, under `_files`. Omit and that name is a 404 like any other. */
  uploads?: UploadOptions;
}

/* -------------------------------- uploads -------------------------------- */

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** What the first bytes say the file is, for the raster types a browser renders inline. */
export function sniffImage(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const defaultExtension = (_type: string | null, name: string): string => {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
};

/**
 * The body, or null the moment it exceeds `max`. Read from the stream, chunk
 * by chunk, so an oversize upload is refused after `max` bytes rather than
 * after all of them — `request.formData()` would buffer the lot first, which
 * makes a size limit a comment rather than a limit.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      // Release the reader rather than cancel the stream. Node's request body
      // source can still be mid-enqueue when a cancel lands, and it then
      // throws on a later tick where nothing can catch it — the process dies
      // for an upload that was merely too big. Released, the stream simply
      // stops being pulled; a browser never gets this far anyway, because it
      // sends Content-Length and the check above refuses before the first byte.
      try {
        reader.releaseLock();
      } catch {
        /* nothing to release */
      }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A signed-in actor, structurally: the public actor carries no user id. */
const isSignedIn = (actor: unknown): boolean =>
  !!actor && typeof actor === 'object' && (actor as { userId?: unknown }).userId !== null && (actor as { userId?: unknown }).userId !== undefined;

export interface AdminRoutes {
  /** Dispatch one request. `segments` are the path parts after the mount point. */
  handle(request: Request, segments: string[]): Promise<Response>;
  /** OPTIONS — CORS preflight. */
  preflight(request: Request): Response;
}

/**
 * A database error, worded for the person who caused it.
 *
 * pg nests the useful part — `detail` says WHICH constraint, `hint` says what to
 * do — a frame or two down a `cause` chain. The top message alone is "insert or
 * update violates foreign key constraint", which tells an operator nothing they
 * can act on.
 */
export function friendlyError(e: unknown): string {
  let cur: unknown = e;
  let best: { message: string; detail?: string; hint?: string } | null = null;
  for (let i = 0; i < 5 && cur; i++) {
    const c = cur as { message?: string; detail?: string; hint?: string; cause?: unknown };
    if (typeof c.message === 'string' && c.message) {
      if (!best || c.detail || c.hint) best = { message: c.message, detail: c.detail, hint: c.hint };
    }
    cur = c.cause;
  }
  if (!best) return 'Request failed';
  return [best.message, best.detail, best.hint].filter(Boolean).join(' — ');
}

export function createAdminRoutes(opts: AdminRoutesOptions): AdminRoutes {
  const { resolver, views } = opts;

  const originAllowed = (origin: string) =>
    !!opts.allowOrigins && (typeof opts.allowOrigins === 'function' ? opts.allowOrigins(origin) : opts.allowOrigins.includes(origin));

  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get('origin');
    if (!origin || !originAllowed(origin)) return {};
    // Exact origin, never "*": a wildcard is ignored alongside credentials, and
    // Vary keeps a shared cache from handing one origin's response to another.
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
  };

  const json = (request: Request, body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(request) } });
  const fail = (request: Request, error: string, status: number) => json(request, { error }, status);

  /**
   * The resolver's refusals carry their meaning in the message, which is the one
   * place the SQL layer can put it. Turned into status codes here:
   *   Not permitted        → 403   the table, not a row — its existence is not secret
   *   Row not found        → 404   a row outside a grant answers like a missing one
   *   Cannot filter / scope → 400   the caller's request, not the server's fault
   */
  const status = (e: unknown): number => {
    const m = e instanceof Error ? e.message : String(e);
    if (m.startsWith('Not permitted')) return 403;
    if (m === 'Row not found' || m.startsWith('Unknown table')) return 404;
    if (/^Cannot (filter|scope)/.test(m) || m.startsWith('Invalid view') || m.startsWith('Unknown field')) return 400;
    // Postgres says whose fault a failure is, in the SQLSTATE class: 22 is a
    // data exception (bad value for the type), 23 an integrity violation (a
    // duplicate, a missing parent, a NOT NULL). Both are the request, not the
    // server — 400, with pg's own detail, so the operator can fix what they sent.
    let cur: unknown = e;
    for (let i = 0; i < 5 && cur; i++) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string' && /^2[23]/.test(code)) return 400;
      cur = (cur as { cause?: unknown }).cause;
    }
    return 500;
  };

  /**
   * The cross-site request forgery check, for every write.
   *
   * CORS headers decide whether a script may READ a response; the request and
   * its cookies have already arrived by then. SameSite cookies cover most of
   * the gap but not sibling subdomains, which is how a site and its back office
   * are usually deployed. So a write whose Origin is neither this host nor on
   * the allowlist is refused, a body not typed as JSON is refused (a cross-site
   * form cannot send that type without a preflight), and a request the browser
   * itself labels cross-site is refused. Only the host of the origin is
   * compared, not the scheme, because behind a reverse proxy the handler sees
   * http where the browser sent https.
   *
   * Declared here as well as in @allodium/auth, on purpose: neither package
   * imports the other, and both need it.
   */
  const crossSiteWrite = (request: Request, anyBodyType = false): { status: number; message: string } | null => {
    const origin = request.headers.get('origin');
    if (origin) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === new URL(request.url).host;
      } catch {
        /* an unparseable Origin is not this host */
      }
      if (!sameHost && !originAllowed(origin)) return { status: 403, message: `Cross-origin request from ${origin} refused` };
    } else if (request.headers.get('sec-fetch-site') === 'cross-site') {
      return { status: 403, message: 'Cross-site request refused' };
    }
    // An upload is multipart by nature, so its body type proves nothing; the
    // origin checks above are what stand between it and a cross-site form.
    if (anyBodyType) return null;
    const type = request.headers.get('content-type');
    if (type && !/^\s*application\/json\b/i.test(type)) return { status: 415, message: 'Expected application/json' };
    return null;
  };

  /* ------------------------------ _files ------------------------------ */

  const uploads = opts.uploads;
  const filesTable = uploads?.table ?? 'files';
  const cols = { diskName: 'disk_name', filename: 'filename', mimeType: 'mime_type', size: 'filesize_bytes', title: 'title', ...(uploads?.columns ?? {}) };

  async function upload(request: Request, actor: unknown): Promise<Response> {
    const u = uploads!;
    // The gate first, before a byte is read: an upload nobody may make should
    // not cost the server the upload.
    await resolver.authorize({ table: filesTable }, 'create', actor);
    const max = u.maxBytes ?? 10 * 1024 * 1024;
    const tooBig = () => fail(request, `The file exceeds the ${max}-byte limit`, 413);
    if (Number(request.headers.get('content-length')) > max) return tooBig();
    const bytes = await readCapped(request, max);
    if (!bytes) return tooBig();

    const contentType = request.headers.get('content-type') ?? '';
    let file: { name: string; type: string; data: Buffer; title: string | null };
    if (/^\s*multipart\/form-data/i.test(contentType)) {
      let form: FormData;
      try {
        form = await new Response(bytes as unknown as BodyInit, { headers: { 'content-type': contentType } }).formData();
      } catch {
        return fail(request, 'Malformed multipart body', 400);
      }
      const f = form.get('file');
      if (!(f instanceof File)) return fail(request, 'Expected a "file" field', 400);
      const t = form.get('title');
      file = {
        name: f.name || 'upload',
        type: f.type || 'application/octet-stream',
        data: Buffer.from(await f.arrayBuffer()),
        title: typeof t === 'string' && t.trim() ? t.trim() : null,
      };
    } else {
      const raw = request.headers.get('x-filename');
      if (!raw) return fail(request, 'Send multipart/form-data with a "file" field, or a raw body with an X-Filename header', 400);
      let name = raw;
      try {
        name = decodeURIComponent(raw);
      } catch {
        /* keep it as sent */
      }
      file = { name, type: contentType.split(';')[0].trim() || 'application/octet-stream', data: Buffer.from(bytes), title: null };
    }
    if (!file.data.length) return fail(request, 'The file is empty', 400);
    // The stored filename is a download name, never a path.
    file.name = file.name.replace(/[\\/]/g, '_').slice(0, 255);

    // A raster type is checked against its own first bytes. The browser will
    // render these inline, so "image/png" has to actually be one; a declared
    // type is the client's claim, and the client is whoever it is.
    const sniffed = sniffImage(file.data);
    if (RASTER.has(file.type) && sniffed !== file.type) {
      return fail(request, `The content is not ${file.type}${sniffed ? ` (it looks like ${sniffed})` : ''}`, 415);
    }
    if (u.accept && !u.accept.some((a) => (a.endsWith('/*') ? file.type.startsWith(a.slice(0, -1)) : a === file.type))) {
      return fail(request, `${file.type} is not an accepted type`, 415);
    }

    const diskName = `${randomUUID()}.${(u.extension ?? defaultExtension)(file.type, file.name)}`;
    await u.driver.put(diskName, file.data);
    let row: Record<string, unknown>;
    try {
      row = await resolver.create(
        { table: filesTable },
        {
          [cols.diskName]: diskName,
          [cols.filename]: file.name,
          [cols.mimeType]: file.type,
          [cols.size]: file.data.length,
          ...(file.title !== null ? { [cols.title]: file.title } : {}),
        },
        actor
      );
    } catch (e) {
      // Bytes without a row are an orphan nothing can reach; take them back.
      await u.driver.delete(diskName).catch(() => {});
      throw e;
    }
    const view = await resolver.resolve({ table: filesTable });
    opts.onWrite?.({ action: 'create', table: filesTable, id: view.primaryKey ? row[view.primaryKey] : undefined, actor });
    return json(request, row, 201);
  }

  async function serve(request: Request, id: string, actor: unknown, forceDownload: boolean): Promise<Response> {
    const u = uploads!;
    // A read of the files table, row scope and all: a file the actor may not
    // see answers as absent, exactly like a record.
    const row = await resolver.read({ table: filesTable }, id, actor);
    if (!row) return fail(request, 'Not found', 404);
    const diskName = String(row[cols.diskName] ?? '');
    const found = diskName ? await u.driver.stream(diskName) : null;
    if (!found) return fail(request, 'The file record exists but its bytes are missing', 404);
    const headers = u.serve({
      type: (row[cols.mimeType] as string | null | undefined) ?? null,
      size: found.size,
      downloadName: String(row[cols.filename] ?? diskName),
      forceDownload,
      // What a signed-in person may see is theirs; what the public may see is
      // everyone's, and a shared cache may keep it.
      isProtected: isSignedIn(actor),
    });
    return new Response(Readable.toWeb(found.stream) as unknown as ReadableStream, { status: 200, headers: { ...headers, ...cors(request) } });
  }

  async function removeFile(request: Request, id: string, actor: unknown): Promise<Response> {
    const u = uploads!;
    const row = await resolver.read({ table: filesTable }, id, actor);
    if (!row) return fail(request, 'Not found', 404);
    await resolver.remove({ table: filesTable }, id, actor);
    opts.onWrite?.({ action: 'delete', table: filesTable, id, actor });
    const diskName = String(row[cols.diskName] ?? '');
    if (diskName) await u.driver.delete(diskName).catch(() => {});
    return json(request, { ok: true });
  }

  async function files(request: Request, rest: string[]): Promise<Response> {
    if (!uploads) return fail(request, 'Not found', 404);
    const [id, extra] = rest;
    const actor = await opts.actorFor(request);
    try {
      switch (`${request.method}${id !== undefined ? ' :id' : ''}${extra !== undefined ? '/x' : ''}`) {
        case 'POST':
          return await upload(request, actor);
        case 'GET :id':
          return await serve(request, id, actor, new URL(request.url).searchParams.has('download'));
        case 'DELETE :id':
          return await removeFile(request, id, actor);
        default:
          return fail(request, 'Not found', 404);
      }
    } catch (e) {
      const code = status(e);
      return fail(request, code === 500 ? friendlyError(e) : (e as Error).message, code);
    }
  }

  async function body(request: Request): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = await request.json();
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function definition(name: string, request: Request): Promise<ViewDefinition> {
    // `?table=` means the caller knows which table it needs — a related panel
    // does — and the name is only a preference. Both /view and /list honour it,
    // or the columns and the rows would come from two different definitions.
    const table = new URL(request.url).searchParams.get('table');
    if (table) return views.loadForTable(name, table);
    // No file of that name: treat the name as a table. A granted table with no
    // curated screen renders its implicit one — every visible column — which is
    // what "omission means the sensible default" has meant everywhere else, and
    // what a storefront asking for `products` expects. A name that is not a
    // table either fails in the resolver as Unknown table, which is the 404.
    // The gate still decides who may read it; a name is not a permission.
    return (await views.load(name)) ?? views.loadForTable(name, name);
  }

  return {
    preflight(request) {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors(request),
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
          'Access-Control-Max-Age': '600',
        },
      });
    },

    async handle(request, segments) {
      if (request.method === 'OPTIONS') return this.preflight(request);
      const isFiles = segments[0] === '_files';
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const refused = crossSiteWrite(request, isFiles);
        if (refused) return fail(request, refused.message, refused.status);
      }
      if (isFiles) return files(request, segments.slice(1).map((s) => decodeURIComponent(s)));

      const [name, kind, third] = segments.map((s) => decodeURIComponent(s));
      if (!name || !kind) return fail(request, 'Not found', 404);

      let def: ViewDefinition;
      try {
        def = await definition(name, request);
      } catch (e) {
        // A corrupt file is the author's problem and worth saying; "unknown view"
        // would be a lie about a file sitting right there.
        return fail(request, friendlyError(e), 500);
      }

      const actor = await opts.actorFor(request);
      const q = new URL(request.url).searchParams;

      try {
        switch (`${request.method} ${kind}${third !== undefined ? '/:x' : ''}`) {
          case 'GET view': {
            // The shape of a table you may not read is still a leak — column
            // names, enum members, which tables it points at. Gate it as a read.
            await resolver.authorize(def, 'read', actor);
            return json(request, await resolver.resolve(def));
          }

          case 'GET list': {
            const filters = parseFilterParams(q.getAll('filter'));
            const scope = parseFilterParams(q.getAll('scope'));
            const problems = [...validateFilter(filters, 'filter'), ...validateFilter(scope, 'scope')];
            if (problems.length) return fail(request, problems.map((p) => `${p.path}: ${p.message}`).join('; '), 400);
            return json(
              request,
              await resolver.list(def, {
                actor,
                page: Number(q.get('page')) || 1,
                pageSize: q.get('pageSize') ? Number(q.get('pageSize')) : undefined,
                search: q.get('search') ?? undefined,
                sort: q.get('sort') ?? undefined,
                direction: q.get('direction') === 'asc' ? 'asc' : q.get('direction') === 'desc' ? 'desc' : undefined,
                filters,
                scope,
              })
            );
          }

          case 'GET record/:x': {
            const row = await resolver.read(def, third, actor);
            return row ? json(request, row) : fail(request, 'Not found', 404);
          }

          case 'POST record': {
            const values = await body(request);
            if (!values) return fail(request, 'Invalid JSON body', 400);
            const row = await resolver.create(def, values, actor);
            const view = await resolver.resolve(def);
            opts.onWrite?.({ action: 'create', table: def.table, id: view.primaryKey ? row[view.primaryKey] : undefined, actor });
            return json(request, row, 201);
          }

          case 'PATCH record/:x':
          case 'PUT record/:x': {
            const values = await body(request);
            if (!values) return fail(request, 'Invalid JSON body', 400);
            const row = await resolver.update(def, third, values, actor);
            opts.onWrite?.({ action: 'update', table: def.table, id: third, actor });
            return json(request, row);
          }

          case 'DELETE record/:x': {
            await resolver.remove(def, third, actor);
            opts.onWrite?.({ action: 'delete', table: def.table, id: third, actor });
            return json(request, { ok: true });
          }

          case 'GET options/:x': {
            // Options are rows of ANOTHER table, so the read being gated is a read
            // of that one — an operator who may not see customers must not be
            // able to enumerate them through an order form's dropdown.
            const view = await resolver.resolve(def);
            const field = view.fields.find((f) => f.key === third);
            if (!field?.source) return fail(request, `No relation field "${third}"`, 404);
            // The table-level answer is thrown here; the row-level scope of that
            // grant is applied inside options(), so a picker over a table the
            // actor may only partly read offers only the part.
            await resolver.authorize({ table: field.source.table }, 'read', actor);
            return json(request, { options: await resolver.options(def, third, { search: q.get('search') ?? undefined, actor }) });
          }

          default:
            return fail(request, 'Not found', 404);
        }
      } catch (e) {
        const code = status(e);
        return fail(request, code === 500 ? friendlyError(e) : (e as Error).message, code);
      }
    },
  };
}
