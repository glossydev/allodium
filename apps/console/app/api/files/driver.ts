import 'server-only';
import path from 'node:path';
import { createLocalDiskDriver } from '@allodium/storage';
import { getCatalog } from '@/lib/catalog';
import { getDb } from '@/lib/db';
import { qid } from '@/lib/sql-utils';

/**
 * The console's storage driver + reference scanner.
 *
 * Bytes live under UPLOADS_DIR via @allodium/storage (thunk root — env is read
 * at call time, the app's convention). Metadata lives in the files table.
 * The two systems CAN disagree — seeded rows deliberately have no bytes — and
 * the Files silo shows that instead of hiding it.
 */

export const driver = createLocalDiskDriver({
  root: () => process.env.UPLOADS_DIR || path.join(process.cwd(), '.uploads'),
});

export interface FileRef {
  table: string;
  column: string;
  count: number;
}

/**
 * For a set of file ids, find every row in every table that references them —
 * discovered from the live FK graph, so new file columns are picked up
 * automatically. Returns fileId → refs.
 */
export async function referencesFor(fileIds: string[]): Promise<Map<string, FileRef[]>> {
  const out = new Map<string, FileRef[]>();
  if (!fileIds.length) return out;

  const cat = await getCatalog();
  const refs: { table: string; column: string }[] = [];
  for (const t of cat.tables.values()) {
    for (const fk of t.foreignKeysOut) {
      if (fk.refTable === 'files') refs.push({ table: t.name, column: fk.column });
    }
  }

  const { pool } = getDb();
  for (const r of refs) {
    // Identifiers come from the catalog (they exist); values are bound params.
    const res = await pool.query(
      `select ${qid(r.column)}::text as file_id, count(*)::int as n
       from ${qid(r.table)}
       where ${qid(r.column)} = any($1::uuid[])
       group by ${qid(r.column)}`,
      [fileIds]
    );
    for (const row of res.rows as { file_id: string; n: number }[]) {
      (out.get(row.file_id) ?? out.set(row.file_id, []).get(row.file_id)!).push({
        table: r.table,
        column: r.column,
        count: row.n,
      });
    }
  }
  return out;
}

/** Does the driver actually hold bytes for this disk name? */
export async function onDisk(diskName: string): Promise<boolean> {
  const s = await driver.stream(diskName);
  if (!s) return false;
  s.stream.destroy();
  return true;
}
