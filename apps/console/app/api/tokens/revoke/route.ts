import type { NextRequest } from 'next/server';
import { getTokens, isMissingTable } from '@/lib/tokens';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** POST /api/tokens/revoke { id } — a revoked token resolves to nothing from the next request on. */
export async function POST(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id) return bad('id is required');
    const revoked = await getTokens().revoke(id);
    if (!revoked) return bad('No live token with that id', 404);
    console.log(`[console] REVOKE api token ${id}`);
    return ok({ ok: true });
  } catch (e) {
    if (isMissingTable(e)) return bad('The api_tokens table does not exist yet — apply dev/seed/008-api-tokens.sql', 409);
    return oops(e);
  }
}
