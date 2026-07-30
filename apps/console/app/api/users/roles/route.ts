import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** POST /api/users/roles { userId, roleId, action: 'grant' | 'revoke' } */
export async function POST(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const userId = String(body.userId ?? '');
    const roleId = Number(body.roleId);
    if (!userId || !Number.isInteger(roleId)) return bad('userId and roleId are required');

    const { pool } = getDb();
    if (body.action === 'grant') {
      // granted_by NULL = console-issued; operator identity arrives with console auth.
      await pool.query(
        `insert into user_roles (user_id, role_id, granted_by) values ($1::uuid, $2, null) on conflict do nothing`,
        [userId, roleId]
      );
      console.log(`[console] GRANT role ${roleId} -> ${userId}`);
      return ok({ ok: true });
    }
    if (body.action === 'revoke') {
      const res = await pool.query(`delete from user_roles where user_id = $1::uuid and role_id = $2`, [userId, roleId]);
      console.log(`[console] REVOKE role ${roleId} -x- ${userId}`);
      if (!res.rowCount) return bad('Grant not found');
      return ok({ ok: true });
    }
    return bad('Unknown action');
  } catch (e) {
    return oops(e);
  }
}
