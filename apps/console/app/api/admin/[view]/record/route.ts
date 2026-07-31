import type { NextRequest } from 'next/server';
import { getViewResolver } from '@/lib/admin-runtime';
import { loadView } from '@/lib/views';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';
import { pgErrorMessage } from '@/lib/sql-utils';

export const dynamic = 'force-dynamic';

/** POST /api/admin/[view]/record — create. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ view: string }> }) {
  try {
    const { view } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    try {
      const row = await getViewResolver().create(def, body as Record<string, unknown>);
      console.log(`[admin] INSERT ${def.table}`);
      return ok(row, 201);
    } catch (e) {
      return bad(pgErrorMessage(e));
    }
  } catch (e) {
    return oops(e);
  }
}
