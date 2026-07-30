import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/users/list?page=&pageSize=&role=<key>&status=&q=
 *
 * Users with their roles aggregated — the role-first lens the Users silo is
 * built around. Secrets never leave the database: password_hash/mfa_secret are
 * not selected; has_mfa is derived metadata. Sort is a fixed allowlist.
 */

const SORTS: Record<string, string> = {
  email: 'u.email',
  created_at: 'u.created_at',
  last_login_at: 'u.last_login_at',
};

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const page = Math.max(1, Number(q.get('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.get('pageSize')) || 50));
    const sortCol = SORTS[q.get('sort') ?? ''] ?? 'u.created_at';
    const dir = q.get('dir') === 'asc' ? 'asc' : 'desc';

    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    const role = q.get('role');
    if (role) {
      where.push(
        `exists (select 1 from user_roles ur2 join roles r2 on r2.id = ur2.role_id where ur2.user_id = u.id and r2.key = ${p(role)})`
      );
    }
    const status = q.get('status');
    if (status) where.push(`u.status = ${p(status)}::user_status`);
    const search = q.get('q');
    if (search) {
      const like = p('%' + search + '%');
      where.push(`(u.email ilike ${like} or u.display_name ilike ${like})`);
    }
    const whereSql = where.length ? ' where ' + where.join(' and ') : '';

    const { pool } = getDb();
    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `select u.id, u.email, u.display_name, u.status,
                (u.mfa_secret is not null) as has_mfa,
                to_char(u.last_login_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_login_at,
                to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
                c.id as customer_id,
                coalesce(
                  (select json_agg(json_build_object(
                            'key', r.key, 'label', r.label, 'rank', r.rank,
                            'granted_at', to_char(ur.granted_at at time zone 'UTC', 'YYYY-MM-DD'),
                            'granted_by', gb.email)
                          order by r.rank)
                   from user_roles ur
                   join roles r on r.id = ur.role_id
                   left join users gb on gb.id = ur.granted_by
                   where ur.user_id = u.id),
                  '[]'::json) as roles
         from users u
         left join customers c on c.user_id = u.id
         ${whereSql}
         order by ${sortCol} ${dir} nulls last
         limit ${pageSize} offset ${(page - 1) * pageSize}`,
        params
      ),
      pool.query(`select count(*)::int as n from users u${whereSql}`, params),
    ]);

    return ok({
      rows: rowsRes.rows,
      total: (countRes.rows[0] as { n: number }).n,
      page,
      pageSize,
    });
  } catch (e) {
    return oops(e);
  }
}
