import { catalogForClient, getRowCounts } from '@/lib/catalog';
import { ok, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** GET /api/schema — catalog + exact row counts (schema silo scans; that's its job). */
export async function GET() {
  try {
    const [cat, counts] = await Promise.all([catalogForClient(), getRowCounts()]);
    return ok({
      ...cat,
      tables: cat.tables.map((t) => ({ ...t, rowCount: counts.get(t.name) ?? 0 })),
    });
  } catch (e) {
    return oops(e);
  }
}
