import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { diskExtension } from '@allodium/storage';
import { getDb } from '@/lib/db';
import { ok, bad, oops } from '@/lib/api-helpers';
import { driver } from '../driver';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/files/upload (multipart: file, title?)
 *
 * The file row exists the moment the upload lands — reference it from content
 * whenever you're ready. (The two-pass import dance this kills is a founding
 * grievance: content first for ids, then attachments. Never again.)
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return bad('No file in form data');
    if (file.size === 0) return bad('Empty file');
    if (file.size > MAX_BYTES) return bad(`File too large (${Math.round(file.size / 1024 / 1024)} MB — cap is 25 MB)`);

    const titleRaw = form.get('title');
    const title = typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim() : null;

    const ext = diskExtension(file.type || null, file.name || null);
    const diskName = `${randomUUID()}${ext ? '.' + ext : ''}`;

    // Bytes first (an orphan file on disk is harmless), then the metadata row.
    await driver.put(diskName, Buffer.from(await file.arrayBuffer()));
    const res = await getDb().pool.query(
      `insert into files (disk_name, filename, mime_type, filesize_bytes, title)
       values ($1, $2, $3, $4, $5)
       returning id::text as id, disk_name, filename, mime_type, filesize_bytes::float8 as filesize_bytes, title,
                 to_char(uploaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as uploaded_at`,
      [diskName, file.name || diskName, file.type || null, file.size, title]
    );

    console.log(`[console] UPLOAD ${diskName} (${file.size} bytes)`);
    return ok({ row: res.rows[0] }, 201);
  } catch (e) {
    return oops(e);
  }
}
