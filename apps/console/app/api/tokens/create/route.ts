import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { getTokens, isMissingTable } from '@/lib/tokens';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tokens/create { label, userId?: string | null, roles?: string[], expiresAt?: string | null }
 *
 * Mints a token and returns the plaintext ONCE. A user token acts as that user
 * (roles come from the user at resolve time); a service token has no user and
 * carries the role keys given here. Role keys are checked against the roles
 * table so a typo cannot mint a token that silently has no grants.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 120) : '';
    if (!label) return bad('A label is required — say what will hold this token');
    const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null;
    const roles = Array.isArray(body.roles) ? body.roles.map(String).map((r) => r.trim()).filter(Boolean) : [];
    if (!userId && !roles.length) return bad('A token acts as a user or carries roles of its own — choose one');
    let expiresAt: string | null = null;
    if (typeof body.expiresAt === 'string' && body.expiresAt.trim()) {
      const d = new Date(body.expiresAt);
      if (Number.isNaN(d.getTime())) return bad('expiresAt is not a date');
      if (d.getTime() <= Date.now()) return bad('expiresAt is already in the past');
      expiresAt = d.toISOString();
    }

    const { pool } = getDb();
    if (userId) {
      const u = await pool.query(`select 1 from users where id = $1::uuid`, [userId]);
      if (!u.rowCount) return bad('No such user');
    }
    if (roles.length) {
      const r = await pool.query(`select key from roles where key = any($1::text[])`, [roles]);
      const known = new Set((r.rows as { key: string }[]).map((x) => x.key));
      const unknown = roles.filter((k) => !known.has(k));
      if (unknown.length) return bad(`Unknown role${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    }

    const minted = await getTokens().mint({ label, userId, roles, expiresAt });
    console.log(`[console] MINT api token "${label}" ${userId ? `as user ${userId}` : `with roles ${roles.join(',')}`}`);
    return ok({ id: minted.id, token: minted.token }, 201);
  } catch (e) {
    if (isMissingTable(e)) return bad('The api_tokens table does not exist yet — apply dev/seed/008-api-tokens.sql', 409);
    return oops(e);
  }
}
