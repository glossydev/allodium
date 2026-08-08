import type { NextRequest } from 'next/server';
import { getViewResolver } from '@/lib/admin-runtime';
import { loadView, loadViewForTable } from '@/lib/views';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/[view]/view — the ResolvedView the client renders from.
 *
 * `?table=` means the caller knows which table it needs (a related panel does)
 * and the name in the path is only a preference — see loadViewForTable. Both
 * this route and /list must resolve the SAME way, or a panel would render the
 * columns of one screen and fetch the rows of another.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ view: string }> }) {
  try {
    const { view } = await ctx.params;
    const wantTable = request.nextUrl.searchParams.get('table');
    const def = wantTable ? await loadViewForTable(view, wantTable) : await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    return ok(await getViewResolver().resolve(def));
  } catch (e) {
    return oops(e);
  }
}
