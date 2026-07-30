import type { NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { assetContentHeaders } from '@allodium/storage';
import { getDb } from '@/lib/db';
import { bad, oops } from '@/lib/api-helpers';
import { driver } from '../../driver';

export const dynamic = 'force-dynamic';

/**
 * GET /api/files/[id]/raw[?download] — stream bytes with @allodium/storage's
 * safe-serving headers (nosniff, svg-as-attachment stored-XSS guard). The
 * console is a dev tool, so everything serves as protected/no-cache.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad('Invalid file id');

    const res = await getDb().pool.query(
      `select disk_name, filename, mime_type from files where id = $1::uuid`,
      [id]
    );
    if (!res.rows.length) return bad('File not found', 404);
    const f = res.rows[0] as { disk_name: string; filename: string; mime_type: string | null };

    const s = await driver.stream(f.disk_name);
    if (!s) return bad('Bytes missing on disk — metadata exists but no file at UPLOADS_DIR', 404);

    const headers = assetContentHeaders({
      type: f.mime_type,
      size: s.size,
      downloadName: f.filename || f.disk_name,
      forceDownload: request.nextUrl.searchParams.has('download'),
      isProtected: true,
    });

    return new Response(Readable.toWeb(s.stream) as ReadableStream, { headers });
  } catch (e) {
    return oops(e);
  }
}
