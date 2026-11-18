import 'server-only';
import { createApiTokens } from '@allodium/auth';
import { getDb } from './db';

/**
 * The API-token store the console manages — the same factory a deployed app
 * binds, over the same `api_tokens` table (dev/seed/008-api-tokens.sql), so a
 * token minted here is exactly what the app's `actorFor` will resolve.
 *
 * The console never sees a token after minting: the plaintext is returned once
 * to the operator and only its digest is stored. There is no "show token" and
 * there never will be.
 */
export function getTokens() {
  const g = globalThis as { __allodiumTokens?: ReturnType<typeof createApiTokens> };
  g.__allodiumTokens ??= createApiTokens(getDb().pool);
  return g.__allodiumTokens;
}

/** Postgres's "relation does not exist" — the table has not been seeded yet. */
export const isMissingTable = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: string }).code === '42P01';
