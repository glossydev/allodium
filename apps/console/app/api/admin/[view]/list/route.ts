import type { NextRequest } from 'next/server';
import { parseFilterParams, validateFilter } from '@allodium/admin/view';
import { getViewResolver } from '@/lib/admin-runtime';
import { loadView } from '@/lib/views';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/[view]/list?page=&search=&sort=&direction=&filter=col:op:value
 *
 * `filter` repeats, and the parts are ANDed. Parsing is the package's own codec,
 * not a local copy — the browser hook writes these parameters with the matching
 * encoder, and a second implementation of a wire format is how the two ends drift.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ view: string }> }) {
  try {
    const { view } = await ctx.params;
    const def = await loadView(view);
    if (!def) return bad(`Unknown view: ${view}`, 404);

    const q = request.nextUrl.searchParams;
    const filters = parseFilterParams(q.getAll('filter'));
    const problems = validateFilter(filters, 'filter');
    if (problems.length) return bad(problems.map((p) => `${p.path}: ${p.message}`).join('; '));

    try {
      return ok(
        await getViewResolver().list(def, {
          page: Number(q.get('page')) || 1,
          search: q.get('search') ?? undefined,
          sort: q.get('sort') ?? undefined,
          direction: q.get('direction') === 'asc' ? 'asc' : 'desc',
          filters,
        })
      );
    } catch (e) {
      // A filter naming an unknown or opted-out field is the caller's mistake,
      // not a server fault: 400 with the reason, rather than a 500 that reads
      // like the screen is broken.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('Cannot filter on')) return bad(msg);
      throw e;
    }
  } catch (e) {
    return oops(e);
  }
}
