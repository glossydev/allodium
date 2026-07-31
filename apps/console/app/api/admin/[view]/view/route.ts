import { getViewResolver } from '@/lib/admin-runtime';
import { loadView } from '@/lib/views';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** GET /api/admin/[view]/view — the ResolvedView the client renders from. */
export async function GET(_req: Request, ctx: { params: Promise<{ view: string }> }) {
  try {
    const { view } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    return ok(await getViewResolver().resolve(def));
  } catch (e) {
    return oops(e);
  }
}
