import type { NextRequest } from 'next/server';
import { getViewResolver } from '@/lib/admin-runtime';
import { loadView } from '@/lib/views';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** GET /api/admin/[view]/options/[field]?search= — selectable rows for a relation. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ view: string; field: string }> }) {
  try {
    const { view, field } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    const options = await getViewResolver().options(def, field, request.nextUrl.searchParams.get('search') ?? undefined);
    return ok({ options });
  } catch (e) {
    return oops(e);
  }
}
