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
 */

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
}

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
    if (m === 'Row not found') return 404;
    if (/^Cannot (filter|scope)/.test(m) || m.startsWith('Invalid view') || m.startsWith('Unknown field')) return 400;
    return 500;
  };

  async function body(request: Request): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = await request.json();
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function definition(name: string, request: Request): Promise<ViewDefinition | null> {
    // `?table=` means the caller knows which table it needs — a related panel
    // does — and the name is only a preference. Both /view and /list honour it,
    // or the columns and the rows would come from two different definitions.
    const table = new URL(request.url).searchParams.get('table');
    return table ? views.loadForTable(name, table) : views.load(name);
  }

  return {
    preflight(request) {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors(request),
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        },
      });
    },

    async handle(request, segments) {
      if (request.method === 'OPTIONS') return this.preflight(request);

      const [name, kind, third] = segments.map((s) => decodeURIComponent(s));
      if (!name || !kind) return fail(request, 'Not found', 404);

      let def: ViewDefinition | null;
      try {
        def = await definition(name, request);
      } catch (e) {
        // A corrupt file is the author's problem and worth saying; "unknown view"
        // would be a lie about a file sitting right there.
        return fail(request, friendlyError(e), 500);
      }
      if (!def) return fail(request, `Unknown view: ${name}`, 404);

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
            await resolver.authorize({ table: field.source.table }, 'read', actor);
            return json(request, { options: await resolver.options(def, third, q.get('search') ?? undefined) });
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
