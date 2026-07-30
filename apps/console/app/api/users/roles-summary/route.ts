import { getDb } from '@/lib/db';
import { ok, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** GET /api/users/roles-summary — roles ordered by rank with member counts (filter chips). */
export async function GET() {
  try {
    const { pool } = getDb();
    const res = await pool.query(
      `select r.id, r.key, r.label, r.rank,
              (select count(*)::int from user_roles ur where ur.role_id = r.id) as members
       from roles r order by r.rank, r.key`
    );
    const total = await pool.query(`select count(*)::int as n from users`);
    return ok({ roles: res.rows, totalUsers: (total.rows[0] as { n: number }).n });
  } catch (e) {
    return oops(e);
  }
}
