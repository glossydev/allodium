import { loadAllViews } from '@/lib/views';
import { ok, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** GET /api/admin-views — the view definitions on disk (the console's own index). */
export async function GET() {
  try {
    const views = await loadAllViews();
    return ok({
      views: views.map((v) => ({
        name: v.name,
        table: v.definition.table,
        title: v.definition.title ?? v.definition.table,
        fieldCount: v.definition.fields?.length ?? 0,
      })),
    });
  } catch (e) {
    return oops(e);
  }
}
