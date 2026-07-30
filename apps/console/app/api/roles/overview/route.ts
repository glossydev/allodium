import { getDb } from '@/lib/db';
import { getCatalog } from '@/lib/catalog';
import { ok, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/roles/overview — roles (by rank) with member + grant counts, plus the
 * live table list the matrix renders against.
 */
export async function GET() {
  try {
    const { pool } = getDb();
    const [rolesRes, cat] = await Promise.all([
      pool.query(
        `select r.id, r.key, r.label, r.description, r.rank,
                (select count(*)::int from user_roles ur where ur.role_id = r.id) as members,
                (select count(*)::int from role_permissions rp where rp.role_id = r.id) as grants
         from roles r order by r.rank, r.key`
      ),
      getCatalog(),
    ]);
    return ok({ roles: rolesRes.rows, tables: [...cat.tables.keys()].sort() });
  } catch (e) {
    return oops(e);
  }
}
