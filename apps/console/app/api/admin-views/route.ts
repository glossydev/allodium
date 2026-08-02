import { humanize } from '@allodium/admin/view';
import { loadAllViews, schemaRef } from '@/lib/views';
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
        // Same default the resolver applies. A saved file usually has NO title —
        // pruneDefaults strips one that matches humanize(table) — so falling back
        // to the raw table name here made the index disagree with every screen.
        title: v.definition.title ?? humanize(v.definition.table),
        fieldCount: v.definition.fields?.length ?? 0,
      })),
      // So the builder's "what gets written" panel can show the pointer it will
      // stamp, rather than previewing a file missing its first line.
      schemaRef: schemaRef(),
    });
  } catch (e) {
    return oops(e);
  }
}
