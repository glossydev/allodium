import type { NextRequest } from 'next/server';
import { proposeView } from '@/lib/view-builder';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin-views/propose?table=posts
 *
 * A draft definition for a table: every non-secret column as a field, foreign keys
 * as relations with a guessed display column, and any detected many-to-many. The
 * builder opens on this so you start by editing a real screen rather than an
 * empty form.
 */
export async function GET(request: NextRequest) {
  try {
    const table = request.nextUrl.searchParams.get('table');
    if (!table) return bad('table is required');
    const proposed = await proposeView(table);
    if (!proposed) return bad(`Unknown table: ${table}`, 404);
    return ok(proposed);
  } catch (e) {
    return oops(e);
  }
}
