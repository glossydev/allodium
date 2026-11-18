import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { getTokens, isMissingTable } from '@/lib/tokens';
import { ok, bad, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tokens/list?revoked=1
 *
 * Every token, newest first, with the email of the user it acts as (a service
 * token has none). Never the digest — the store does not return it either.
 */
export async function GET(request: NextRequest) {
  try {
    const includeRevoked = request.nextUrl.searchParams.get('revoked') === '1';
    const rows = await getTokens().list({ includeRevoked });
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
    const emails = new Map<string, string>();
    if (userIds.length) {
      const res = await getDb().pool.query(`select id, email from users where id = any($1::uuid[])`, [userIds]);
      for (const u of res.rows as { id: string; email: string }[]) emails.set(String(u.id), u.email);
    }
    return ok({
      rows: rows.map((r) => ({ ...r, userEmail: r.userId ? (emails.get(r.userId) ?? null) : null })),
    });
  } catch (e) {
    if (isMissingTable(e)) return bad('The api_tokens table does not exist yet — apply dev/seed/008-api-tokens.sql', 409);
    return oops(e);
  }
}
