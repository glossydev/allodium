import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { ok, oops } from '@/lib/api-helpers';
import { referencesFor, onDisk, type FileRef } from '../driver';

export const dynamic = 'force-dynamic';

/** GET /api/files/list?page=&q=&sort=&dir= — metadata + refs + on-disk truth. */

const SORTS: Record<string, string> = {
  filename: 'filename',
  filesize_bytes: 'filesize_bytes',
  uploaded_at: 'uploaded_at',
};

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const page = Math.max(1, Number(q.get('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.get('pageSize')) || 50));
    const sortCol = SORTS[q.get('sort') ?? ''] ?? 'uploaded_at';
    const dir = q.get('dir') === 'asc' ? 'asc' : 'desc';

    const params: unknown[] = [];
    let where = '';
    const search = q.get('q');
    if (search) {
      params.push('%' + search + '%');
      where = ` where filename ilike $1 or title ilike $1`;
    }

    const { pool } = getDb();
    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `select id::text as id, disk_name, filename, mime_type, filesize_bytes::float8 as filesize_bytes, title,
                to_char(uploaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as uploaded_at
         from files${where}
         order by ${sortCol} ${dir} nulls last
         limit ${pageSize} offset ${(page - 1) * pageSize}`,
        params
      ),
      pool.query(`select count(*)::int as n from files${where}`, params),
    ]);

    const rows = rowsRes.rows as {
      id: string;
      disk_name: string;
      filename: string;
      mime_type: string | null;
      filesize_bytes: number | null;
      title: string | null;
      uploaded_at: string;
    }[];

    const refs = await referencesFor(rows.map((r) => r.id));
    const withMeta = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        referencedBy: (refs.get(r.id) ?? []) as FileRef[],
        onDisk: await onDisk(r.disk_name),
      }))
    );

    return ok({ rows: withMeta, total: (countRes.rows[0] as { n: number }).n, page, pageSize });
  } catch (e) {
    return oops(e);
  }
}
