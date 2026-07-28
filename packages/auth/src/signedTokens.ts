import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless HMAC-signed auth artifacts: `${payloadB64url}.${hmacB64url}`, verified with
 * timingSafeEqual — no server-side token store. Payloads are unencrypted b64url JSON:
 * they carry only ids and expiries, nothing secret; the HMAC is what makes them
 * unforgeable.
 *
 * The password-reset variant additionally mixes the user's CURRENT password hash into
 * the HMAC key (`secret + ':' + passwordHash`). A successful reset changes the hash, so
 * every outstanding token for that user stops verifying — single-use without any
 * bookkeeping. This trick is the reason to use these over random-token-in-a-table.
 */

function hmacB64url(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

/** `${b64url(JSON payload)}.${hmac}` — the signing primitive behind every token here. */
export function signPayload(key: string, payload: unknown): string {
  const payloadB64url = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64url}.${hmacB64url(key, payloadB64url)}`;
}

/**
 * Verify a signed token's HMAC (timing-safe) and return its decoded payload, or null.
 * Expiry is the caller's concern — payload shapes differ.
 */
export function verifySignedPayload(key: string, token: string): unknown | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64url = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(hmacB64url(key, payloadB64url));
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payloadB64url, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Password-reset tokens
// ---------------------------------------------------------------------------

export interface ResetTokenPayload {
  /** User id the token was issued for. */
  u: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

export interface ResetTokens {
  /** Issue a token for a user. Throws when the secret is unset (callers guard). */
  make(user: { id: string; password: string | null }): string;
  /**
   * Structure-only decode (NO verification) so the reset route can learn which user to
   * load before verifying. Never trust the result without verify().
   */
  decode(token: string): ResetTokenPayload | null;
  /**
   * Verify against the user's CURRENT password hash: HMAC (timing-safe) + expiry.
   * False on any mismatch, expiry, malformed token, or missing secret.
   */
  verify(token: string, user: { password: string | null }): boolean;
}

/**
 * Reset-token factory. `secret` is read per call (pass `() => process.env.AUTH_SECRET`)
 * so an unset secret degrades per-request rather than at module load.
 */
export function createResetTokens(opts: {
  secret: () => string | undefined;
  ttlMs?: number;
}): ResetTokens {
  const ttlMs = opts.ttlMs ?? 3_600_000; // 1 hour

  const resetKey = (passwordHash: string | null | undefined): string => {
    const secret = opts.secret();
    if (!secret) throw new Error('auth secret is not set — password-reset tokens are not configured');
    return `${secret}:${passwordHash ?? ''}`;
  };

  const decode = (token: string): ResetTokenPayload | null => {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    let payload: { u?: unknown; exp?: unknown };
    try {
      payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload?.u !== 'string' || !payload.u) return null;
    if (typeof payload.exp !== 'number') return null;
    return { u: payload.u, exp: payload.exp };
  };

  return {
    make(user) {
      const payload: ResetTokenPayload = { u: user.id, exp: Date.now() + ttlMs };
      return signPayload(resetKey(user.password), payload);
    },
    decode,
    verify(token, user) {
      if (!opts.secret()) return false;
      let key: string;
      try {
        key = resetKey(user.password);
      } catch {
        return false;
      }
      if (verifySignedPayload(key, token) === null) return false;
      const payload = decode(token);
      return payload !== null && Date.now() < payload.exp;
    },
  };
}

// ---------------------------------------------------------------------------
// One-shot state tokens (OAuth `state` CSRF binding, and similar)
// ---------------------------------------------------------------------------

/** Sign an opaque state string with an expiry — store it in an httpOnly cookie. */
export function makeStateToken(secret: string, state: string, ttlMs: number): string {
  return signPayload(secret, { s: state, exp: Date.now() + ttlMs });
}

/** Verify + unwrap a state token: the stored state, or null on any failure/expiry. */
export function readStateToken(secret: string, token: string): string | null {
  const payload = verifySignedPayload(secret, token) as { s?: unknown; exp?: unknown } | null;
  if (!payload || typeof payload.s !== 'string' || !payload.s) return null;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload.s;
}
