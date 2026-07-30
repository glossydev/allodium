import type { NextRequest } from 'next/server';
import { getReadOnlyDb } from '@/lib/db';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';
import { pgErrorMessage } from '@/lib/sql-utils';
import { assertSingleStatement } from '@/lib/sql-guard';
import { isMaskedColumn } from '@/lib/masking';
import { getCatalog } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

const ROW_CAP = 500;

/**
 * POST /api/sql { query } — read-only SQL console.
 *
 * Three independent layers, because the first one alone was provably NOT enough:
 *   1. assertSingleStatement — one statement per run. Multi-statement input could
 *      otherwise begin `set transaction read write; … ; commit;` and persist a write
 *      before the rollback (a real, verified bypass — see lib/sql-guard.ts).
 *   2. A read-only transaction with a 10s statement timeout, rolled back
 *      unconditionally.
 *   3. When CONSOLE_RO_DATABASE_URL is set, a role holding only SELECT. Privileges
 *      survive anything the session can SET.
 *
 * Masked columns are redacted from results using pg's per-field tableID/columnID —
 * mechanical, no SQL parsing — so the console's masking doctrine holds here too
 * instead of quietly exempting this lane.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return bad('Empty query');

    const guard = assertSingleStatement(query);
    if (!guard.ok) return bad(guard.error!);

    console.log(`[console] sql: ${query.slice(0, 200)}`);

    const { db, leastPrivilege } = getReadOnlyDb();
    const client = await db.pool.connect();
    try {
      const started = Date.now();
      await client.query('begin');
      await client.query('set transaction read only');
      await client.query('set local statement_timeout = 10000');
      const res = await client.query({ text: query, rowMode: 'array' });
      const ms = Date.now() - started;

      const fields = (res.fields ?? []).map((f) => f.name);
      const rows = (res.rows ?? []) as unknown[][];

      // Redact masked columns by resolving each field's source relation via the
      // catalog's pg_class oids. Computed expressions have tableID 0 and pass through.
      const masked = await maskedFieldIndexes(res.fields ?? []);
      const shaped = rows.slice(0, ROW_CAP).map((row) => row.map((v, i) => (masked.has(i) ? '••• masked •••' : v)));

      return ok({
        fields,
        rows: shaped,
        rowCount: res.rowCount ?? rows.length,
        truncated: rows.length > ROW_CAP,
        ms,
        maskedColumns: [...masked].map((i) => fields[i]),
        leastPrivilege,
      });
    } catch (e) {
      return bad(pgErrorMessage(e));
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  } catch (e) {
    return oops(e);
  }
}

/** Field indexes whose (relation, attnum) resolves to a masked column. */
async function maskedFieldIndexes(fields: { tableID: number; columnID: number }[]): Promise<Set<number>> {
  const out = new Set<number>();
  const withTable = fields.filter((f) => f.tableID > 0);
  if (!withTable.length) return out;

  const cat = await getCatalog();
  // Map every masked column to "oid:attnum" once, then match fields against it.
  // relationOids comes from the catalog load so no extra query is needed here.
  const maskedKeys = new Set<string>();
  for (const t of cat.tables.values()) {
    if (t.oid === undefined) continue;
    for (const c of t.columns) {
      if (c.masked && c.attnum !== undefined) maskedKeys.add(`${t.oid}:${c.attnum}`);
    }
  }
  fields.forEach((f, i) => {
    if (f.tableID > 0 && maskedKeys.has(`${f.tableID}:${f.columnID}`)) out.add(i);
  });
  // Fallback for any masked name that slipped through oid resolution (e.g. a view):
  // match on column name, which is what the client would render anyway.
  fields.forEach((f, i) => {
    const name = (f as unknown as { name: string }).name;
    if (!out.has(i) && name && [...cat.tables.keys()].some((t) => isMaskedColumn(t, name))) out.add(i);
  });
  return out;
}
