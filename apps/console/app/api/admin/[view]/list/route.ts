import type { NextRequest } from 'next/server';
import { getViewResolver } from '@/lib/admin-runtime';
import { loadView } from '@/lib/views';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** GET /api/admin/[view]/list?page=&search=&sort=&direction= */
export async function GET(request: NextRequest, ctx: { params: Promise<{ view: string }> }) {
  try {
    const { view } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);
    const q = request.nextUrl.searchParams;
    return ok(
      await getViewResolver().list(def, {
        page: Number(q.get('page')) || 1,
        search: q.get('search') ?? undefined,
        sort: q.get('sort') ?? undefined,
        direction: q.get('direction') === 'asc' ? 'asc' : 'desc',
      })
    );
  } catch (e) {
    return oops(e);
  }
}
