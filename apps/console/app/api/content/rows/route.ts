import type { NextRequest } from 'next/server';
import { selectRows, type Filter, type FilterOp } from '@/lib/dml';
import { ok, bad, oops, parseFilterParams } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const OPS: ReadonlySet<string> = new Set(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'null', 'notnull']);

/** GET /api/content/rows?table=&page=&pageSize=&sort=&dir=&f=col:op:val (f repeatable) */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const table = q.get('table');
    if (!table) return bad('Missing table');

    const filters: Filter[] = [];
    for (const f of parseFilterParams(q)) {
      if (!OPS.has(f.op)) return bad(`Unknown filter op: ${f.op}`);
      filters.push({ col: f.col, op: f.op as FilterOp, val: f.val });
    }

    const res = await selectRows({
      table,
      page: Number(q.get('page')) || 1,
      pageSize: Number(q.get('pageSize')) || 50,
      sort: q.get('sort'),
      dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
      filters,
    });
    if (!res.ok) return bad(res.error);
    return ok(res);
  } catch (e) {
    return oops(e);
  }
}
