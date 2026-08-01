/**
 * @allodium/auth — first-party authentication you own outright.
 *
 * Extracted from a production Next.js SaaS as its headless-CMS migration completed:
 * argon2id passwords (Directus-hash compatible — zero password resets), a session store
 * with single-use atomic refresh rotation and cross-surface origin scoping, stateless
 * HMAC reset tokens that self-invalidate on password change, sliding-window rate
 * limiting, and the session-cookie triple with Domain-correct clearing.
 *
 * Everything is a factory taking explicit config — no env vars are read in here, no
 * framework imports. Your app binds names, secrets, and tables once and re-exports;
 * plus an "act as" user switcher that hooks your one identity seam.
 * OIDC and WebAuthn ceremony helpers arrive in a later minor.
 */

export { hashPassword, verifyPassword, DUMMY_ARGON2ID_HASH } from './passwords.js';
export { createRateLimiter, type RateLimiter } from './rateLimit.js';
export {
  signPayload,
  verifySignedPayload,
  createResetTokens,
  makeStateToken,
  readStateToken,
  type ResetTokenPayload,
  type ResetTokens,
} from './signedTokens.js';
export {
  createSessionCookies,
  type SessionCookieNames,
  type SessionCookieBase,
  type CookieSetter,
  type SessionCookies,
} from './cookies.js';
export {
  createSessionStore,
  type SessionStore,
  type MintedSession,
  type OriginScope,
} from './sessions.js';
export {
  createActAs,
  type ActAs,
  type ActAsState,
  type ActAsMode,
  type ActAsRefusal,
  type ActAsAuditEvent,
  type CreateActAsOptions,
} from './actAs.js';
export { firstForwardedIp } from './ip.js';
