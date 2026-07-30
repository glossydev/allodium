import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';
import { pgErrorMessage } from '@/lib/sql-utils';

export const dynamic = 'force-dynamic';

/**
 * POST /api/users/create { email, displayName?, status?, roleIds?: number[] }
 *
 * password_hash is NOT NULL and masked (so unwritable through the generic DML
 * path, deliberately). The console sets a dev placeholder server-side; real
 * credential flows arrive with @allodium/auth integration.
 */
const DEV_PLACEHOLDER_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000';

const STATUSES = new Set(['active', 'invited', 'suspended', 'deactivated']);

export async function POST(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || !email.includes('@')) return bad('A valid email is required');
    const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : null;
    const status = typeof body.status === 'string' && STATUSES.has(body.status) ? body.status : 'invited';
    const roleIds = Array.isArray(body.roleIds) ? body.roleIds.map(Number).filter(Number.isInteger) : [];

    const client = await getDb().pool.connect();
    try {
      await client.query('begin');
      const userRes = await client.query(
        `insert into users (email, display_name, password_hash, status)
         values ($1, $2, $3, $4::user_status)
         returning id, email, display_name, status`,
        [email, displayName, DEV_PLACEHOLDER_HASH, status]
      );
      const userId = (userRes.rows[0] as { id: string }).id;
      for (const roleId of roleIds) {
        await client.query(
          `insert into user_roles (user_id, role_id, granted_by) values ($1, $2, null) on conflict do nothing`,
          [userId, roleId]
        );
      }
      await client.query('commit');
      console.log(`[console] CREATE user ${email}`);
      return ok({ row: userRes.rows[0] }, 201);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      return bad(pgErrorMessage(e));
    } finally {
      client.release();
    }
  } catch (e) {
    return oops(e);
  }
}
