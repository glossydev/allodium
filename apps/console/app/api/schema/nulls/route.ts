import type { NextRequest } from 'next/server';
import { countNulls } from '@/lib/ddl';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/schema/nulls?table=&column= — how many rows are NULL.
 *
 * Used to warn BEFORE a SET NOT NULL runs. Postgres's failure here is perfectly
 * clear after the fact, but the console's job is to tell you it will fail while
 * you can still change your mind.
 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const table = q.get('table');
    const column = q.get('column');
    if (!table || !column) return bad('table and column are required');
    const n = await countNulls(table, column);
    if (n === null) return bad('Unknown table or column');
    return ok({ nulls: n });
  } catch (e) {
    return oops(e);
  }
}
