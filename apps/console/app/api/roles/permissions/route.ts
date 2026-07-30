import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { getCatalog } from '@/lib/catalog';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';
import { pgErrorMessage } from '@/lib/sql-utils';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/roles/permissions?roleId= — a role's grant rows.
 * PUT  /api/roles/permissions { roleId, grants: [{table_name, can_create, can_read, can_update, can_delete}] }
 *
 * PUT is the matrix save: upsert rows with any flag set, delete rows with none.
 * table_name is a SOFT reference — it must exist in the live catalog OR already
 * be granted (so stale rows for dropped tables can still be cleaned up).
 */

interface Grant {
  table_name: string;
  can_create: boolean;
  can_read: boolean;
  can_update: boolean;
  can_delete: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const roleId = Number(request.nextUrl.searchParams.get('roleId'));
    if (!Number.isInteger(roleId)) return bad('roleId is required');
    const res = await getDb().pool.query(
      `select table_name, can_create, can_read, can_update, can_delete
       from role_permissions where role_id = $1 order by table_name`,
      [roleId]
    );
    return ok({ grants: res.rows });
  } catch (e) {
    return oops(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const roleId = Number(body.roleId);
    if (!Number.isInteger(roleId)) return bad('roleId is required');
    if (!Array.isArray(body.grants)) return bad('grants must be an array');

    const cat = await getCatalog();
    const { pool } = getDb();
    const existing = await pool.query(`select table_name from role_permissions where role_id = $1`, [roleId]);
    const known = new Set((existing.rows as { table_name: string }[]).map((r) => r.table_name));

    const grants: Grant[] = [];
    for (const raw of body.grants as unknown[]) {
      const g = raw as Partial<Grant>;
      const name = typeof g.table_name === 'string' ? g.table_name : '';
      if (!name || (!cat.tables.has(name) && !known.has(name))) {
        return bad(`Unknown table: ${name || '(empty)'}`);
      }
      grants.push({
        table_name: name,
        can_create: !!g.can_create,
        can_read: !!g.can_read,
        can_update: !!g.can_update,
        can_delete: !!g.can_delete,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const g of grants) {
        const any = g.can_create || g.can_read || g.can_update || g.can_delete;
        if (any) {
          await client.query(
            `insert into role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (role_id, table_name)
             do update set can_create = $3, can_read = $4, can_update = $5, can_delete = $6`,
            [roleId, g.table_name, g.can_create, g.can_read, g.can_update, g.can_delete]
          );
        } else {
          await client.query(`delete from role_permissions where role_id = $1 and table_name = $2`, [roleId, g.table_name]);
        }
      }
      await client.query('commit');
      console.log(`[console] PERMISSIONS role ${roleId}: ${grants.length} grants saved`);
      return ok({ ok: true });
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
