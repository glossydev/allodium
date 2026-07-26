/**
 * @allodium/auth — first-party authentication you own outright.
 *
 * Being extracted from a production Next.js SaaS (custom WebAuthn passkeys, Google OIDC,
 * argon2 password sessions, rotating refresh tokens) as its Directus migration proceeds.
 * The design contract, so consumers can build against it today:
 *
 * - Passwords: argon2id via `node-argon2`. Directus-compatible: hashes produced by
 *   Directus verify unchanged (parameters are read from the hash string), so migrations
 *   require zero password resets.
 * - Sessions: server-side session rows (id, user_id, token hash, device label, expiry),
 *   httpOnly cookies, multiple concurrent sessions per user.
 * - Refresh: short-lived access + rotating single-use refresh, with single-flight
 *   middleware guidance for the rotation race (or sliding sessions — your choice).
 * - OIDC: provider-agnostic authorization-code flow (Google first), same-domain
 *   callbacks, one-identity-per-provider policy hooks.
 * - Passkeys: @simplewebauthn-based ceremonies; credentials in your Postgres.
 * - Reset: single-use hashed tokens + your SMTP; anti-enumeration (always-200) contract.
 * - Tenancy: membership/role helpers for the org-per-row multi-tenant pattern.
 */

export const AUTH_PACKAGE_STATUS = 'scaffolding' as const;

/** The session shape consumers can rely on across versions. */
export interface AllodiumSession {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  deviceLabel?: string | null;
}

/** Placeholder to keep the package importable while extraction proceeds. */
export function version(): string {
  return '0.0.1';
}
