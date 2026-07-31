import type { NextRequest } from 'next/server';
import { getViewResolver } from '@/lib/admin-runtime';
import { loadView } from '@/lib/views';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';
import { pgErrorMessage } from '@/lib/sql-utils';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ view: string; id: string }> };

/** GET — one record, with relation labels and many-to-many members resolved. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { view, id } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    const row = await getViewResolver().read(def, id);
    if (!row) return bad('Not found', 404);
    return ok(row);
  } catch (e) {
    return oops(e);
  }
}

/** PATCH — update columns and reconcile many-to-many sets. */
export async function PATCH(request: NextRequest, ctx: Ctx) {
  try {
    const { view, id } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    try {
      const row = await getViewResolver().update(def, id, body as Record<string, unknown>);
      console.log(`[admin] UPDATE ${def.table} ${id}`);
      return ok(row);
    } catch (e) {
      return bad(pgErrorMessage(e));
    }
  } catch (e) {
    return oops(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { view, id } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    try {
      await getViewResolver().remove(def, id);
      console.log(`[admin] DELETE ${def.table} ${id}`);
      return ok({ ok: true });
    } catch (e) {
      return bad(pgErrorMessage(e));
    }
  } catch (e) {
    return oops(e);
  }
}
