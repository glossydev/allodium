import type { NextRequest } from 'next/server';
import type { ViewDefinition } from '@allodium/admin/view';
import { validateViewDefinition } from '@allodium/admin/view';
import { deleteView, loadView, saveView } from '@/lib/views';
import { pruneDefaults } from '@/lib/view-builder';
import { getViewResolver } from '@/lib/admin-runtime';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ name: string }> };

/** GET — the raw definition, for re-opening in the builder. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    const definition = await loadView(name);
    if (!definition) return bad(`Unknown view: ${name}`, 404);
    return ok({ name, definition });
  } catch (e) {
    return oops(e);
  }
}

/**
 * PUT — save. The definition is pruned of anything the runtime would infer, then
 * resolved once before writing: a file that cannot render is not worth committing,
 * and finding out at save time beats finding out on the dashboard.
 */
export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    const body = await jsonBody(request);
    if (!body?.definition) return bad('definition is required');

    const check = validateViewDefinition(body.definition);
    if (!check.ok) return bad(check.problems.map((p) => `${p.path}: ${p.message}`).join('; '));

    const pruned = pruneDefaults(check.view as ViewDefinition);

    let warnings: string[] = [];
    try {
      const resolved = await getViewResolver().resolve(pruned);
      warnings = resolved.warnings;
    } catch (e) {
      return bad(`This definition would not render: ${e instanceof Error ? e.message : String(e)}`);
    }

    const res = await saveView(name, pruned);
    if (!res.ok) return bad(res.error);
    console.log(`[console] SAVE view ${name}.view.json`);
    // res.definition, not `pruned` — saveView stamps the $schema pointer, and the
    // response should be the bytes that hit the disk.
    return ok({ name, definition: res.definition, path: res.path, warnings });
  } catch (e) {
    return oops(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    if (!(await deleteView(name))) return bad('Not found', 404);
    console.log(`[console] DELETE view ${name}.view.json`);
    return ok({ ok: true });
  } catch (e) {
    return oops(e);
  }
}
