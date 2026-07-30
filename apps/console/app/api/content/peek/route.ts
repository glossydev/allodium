import type { NextRequest } from 'next/server';
import { peekRow } from '@/lib/dml';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/content/peek?table=&column=&value=
 *
 * One referenced row, trimmed to the columns worth showing in a hover card.
 * Backs the FK peek: hovering a foreign key shows what is on the other end
 * without navigating away.
 *
 * Same guarantees as any read path — catalog-verified identifiers, bound value,
 * masked columns never selected.
 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const table = q.get('table');
    const column = q.get('column');
    const value = q.get('value');
    if (!table || !column) return bad('table and column are required');
    if (value === null || value === '') return bad('value is required');

    const res = await peekRow(table, column, value);
    if (!res.ok) return bad(res.error);
    return ok(res);
  } catch (e) {
    return oops(e);
  }
}
