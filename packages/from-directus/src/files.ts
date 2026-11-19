/**
 * Files: the manifest, and the check that every byte made it.
 *
 * Directus wrote each upload to `<uploads>/<filename_disk>`; @allodium/storage's disk
 * driver reads `<root>/<disk_name>`. The decommission plan renames the column and
 * keeps the value, so copying the directory IS the migration. What is left is proving
 * it: every row has a file, and the sizes match.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileManifestEntry, Queryable } from './types.js';

/** Every row of directus_files, with the on-disk name it should have under the storage root. */
export async function fileManifest(db: Queryable): Promise<FileManifestEntry[]> {
  const res = await db.query(`select id, storage, filename_disk, filename_download, type, filesize from directus_files order by uploaded_on nulls last, id`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    storage: String(r.storage),
    diskName: r.filename_disk === null || r.filename_disk === undefined ? null : String(r.filename_disk),
    filename: String(r.filename_download),
    mimeType: r.type === null || r.type === undefined ? null : String(r.type),
    bytes: r.filesize === null || r.filesize === undefined ? null : Number(r.filesize),
  }));
}

export interface FileCheck {
  present: number;
  missing: FileManifestEntry[];
  /** On disk but a different size from the row — a truncated copy. */
  sizeMismatch: { entry: FileManifestEntry; onDisk: number }[];
  /** Rows with no filename_disk at all (Directus never finished the upload). */
  noDiskName: FileManifestEntry[];
}

/** Check a copied uploads directory against the manifest. */
export async function checkFiles(manifest: FileManifestEntry[], root: string): Promise<FileCheck> {
  const out: FileCheck = { present: 0, missing: [], sizeMismatch: [], noDiskName: [] };
  for (const e of manifest) {
    if (!e.diskName) {
      out.noDiskName.push(e);
      continue;
    }
    try {
      const s = await stat(join(root, e.diskName));
      if (e.bytes !== null && s.size !== e.bytes) out.sizeMismatch.push({ entry: e, onDisk: s.size });
      else out.present++;
    } catch {
      out.missing.push(e);
    }
  }
  return out;
}
