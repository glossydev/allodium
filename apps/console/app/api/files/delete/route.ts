import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';
import { driver, referencesFor } from '../driver';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/files/delete { id } — refused while referenced (the refs are the
 * error message), then metadata row + bytes (driver delete is idempotent, so a
 * missing-on-disk file deletes cleanly).
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const id = String(body.id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad('Invalid file id');

    const refs = (await referencesFor([id])).get(id) ?? [];
    if (refs.length) {
      return bad(
        `Still referenced by ${refs.map((r) => `${r.table}.${r.column} (${r.count} row${r.count === 1 ? '' : 's'})`).join(', ')} — unlink first`,
        409
      );
    }

    const res = await getDb().pool.query(`delete from files where id = $1::uuid returning disk_name`, [id]);
    if (!res.rows.length) return bad('File not found', 404);
    await driver.delete((res.rows[0] as { disk_name: string }).disk_name);

    console.log(`[console] DELETE file ${id}`);
    return ok({ ok: true });
  } catch (e) {
    return oops(e);
  }
}
