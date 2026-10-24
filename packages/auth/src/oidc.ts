import { createPublicKey, randomBytes, verify as verifySignature, type KeyObject } from 'node:crypto';
import { makeStateToken, readStateToken } from './signedTokens.js';
import type { SessionStore } from './sessions.js';
import type { SessionCookies } from './cookies.js';
import { headerCookieSetter, readCookie } from './routes.js';
import { clientIp, redirectResponse } from './http.js';

/**
 * @allodium/auth/oidc — sign in with an OpenID Connect provider (Google, and
 * anything else that publishes a discovery document), written once.
 *
 * The ceremony is the same everywhere and the mistakes are the same
 * everywhere: a state that is not bound to the browser that started the
 * flow, a token exchange that trusts the response, and — the common one — an
 * identity token whose SIGNATURE is never checked, on the grounds that it
 * arrived over TLS from the provider. It did; but the thing that decides who
 * you are has to be verified, not trusted, and the provider publishes its
 * keys precisely so that you can. This verifies: signature against the
 * provider's current keys, issuer, audience, expiry, and the nonce this
 * browser was handed when the flow began.
 *
 * What stays yours is the one real decision, `onIdentity`: given verified
 * claims, which of your users is this — found, created, or refused. The
 * package never touches your users table.
 *
 * Optional entry point: import from '@allodium/auth/oidc'.
 */

export interface OidcClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  hd?: string;
  [claim: string]: unknown;
}

export type OidcFailure =
  | 'provider' // the provider sent back an error instead of a code
  | 'state' // the state did not match the cookie this browser was given
  | 'exchange' // the code could not be exchanged for tokens
  | 'token' // the identity token did not verify
  | 'unverified-email' // the provider does not vouch for the address
  | 'not-registered' // onIdentity returned null
  | 'inactive'; // the user exists but may not sign in

export type OidcEvent =
  | { type: 'started' }
  | { type: 'signed-in'; userId: string; sub: string }
  | { type: 'refused'; reason: OidcFailure; detail?: string; sub?: string };

export interface OidcLoginOptions {
  /** The provider's issuer, exactly as it appears in its tokens — "https://accounts.google.com". */
  issuer: string;
  clientId: string;
  clientSecret: string | (() => string);
  /** The absolute URL of your callback route, registered with the provider. */
  redirectUri: string;
  /** Default "openid email profile". */
  scope?: string;
  /** Extra authorization parameters — `{ prompt: 'select_account' }`, `{ hd: 'example.com' }`. */
  authParams?: Record<string, string>;
  /** Skip discovery by naming the endpoints yourself. */
  endpoints?: { authorization: string; token: string; jwks: string };
  /** Signs the state cookie. Any long random string. */
  stateSecret: string | (() => string);
  /** How long a started flow stays valid. Default 10 minutes. */
  stateTtlMs?: number;
  /** Default "oidc_state". Scope it per surface if two flows can share a host. */
  stateCookie?: string;
  /** Secure attribute on the state cookie. Default: true unless redirectUri is http. */
  cookieSecure?: boolean | (() => boolean);
  /** Refuse a token whose email_verified is not true. Default true. Set false only for a provider that never sends it. */
  requireVerifiedEmail?: boolean;
  /**
   * THE decision: which of your users these verified claims are. Find them by
   * `sub` (stable) or by email, create them if that is your policy, or return
   * null to refuse. Whatever you return is signed in.
   */
  onIdentity(claims: OidcClaims, ctx: { request: Request }): Promise<{ id: string; status?: string | null } | null>;
  sessions: Pick<SessionStore, 'mint'>;
  cookies: SessionCookies;
  /** The surface the session belongs to — same value your other routes use. */
  origin: string;
  /** Statuses allowed to sign in. Defaults to ['active']. */
  activeStatuses?: string[];
  /** Where to send the browser after signing in. */
  successRedirect: string | ((user: { id: string }) => string);
  /** Where to send it when the flow fails. A string gets `?error=<reason>`; a function gets the reason. */
  failureRedirect: string | ((reason: OidcFailure) => string);
  /** Injectable for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Clock skew tolerated on exp/iat, in seconds. Default 60. */
  clockToleranceSec?: number;
  /** How long fetched provider keys are kept. Default 10 minutes; an unknown key id refetches once regardless. */
  jwksTtlMs?: number;
  onEvent?(event: OidcEvent): void;
}

export interface OidcLogin {
  /** GET — begins the flow: sets the state cookie, redirects to the provider. */
  start(request: Request): Promise<Response>;
  /** GET — the provider's return: verifies everything, signs the user in, redirects. */
  callback(request: Request): Promise<Response>;
  /** Verify an identity token on its own. Throws with a reason when it does not verify. */
  verifyIdToken(idToken: string, expectedNonce?: string): Promise<OidcClaims>;
}

/** Google, for the common case: `createOidcLogin({ issuer: GOOGLE_ISSUER, ... })`. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

const b64url = (s: string): Buffer => Buffer.from(s, 'base64url');
const decodeJson = (s: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(b64url(s).toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export function createOidcLogin(opts: OidcLoginOptions): OidcLogin {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const scope = opts.scope ?? 'openid email profile';
  const stateTtlMs = opts.stateTtlMs ?? 10 * 60_000;
  const stateCookie = opts.stateCookie ?? 'oidc_state';
  const tolerance = opts.clockToleranceSec ?? 60;
  const jwksTtlMs = opts.jwksTtlMs ?? 10 * 60_000;
  const activeStatuses = opts.activeStatuses ?? ['active'];
  const requireVerifiedEmail = opts.requireVerifiedEmail ?? true;
  const secret = () => (typeof opts.stateSecret === 'function' ? opts.stateSecret() : opts.stateSecret);
  const clientSecret = () => (typeof opts.clientSecret === 'function' ? opts.clientSecret() : opts.clientSecret);
  const cookieSecure = () =>
    typeof opts.cookieSecure === 'function' ? opts.cookieSecure() : (opts.cookieSecure ?? !opts.redirectUri.startsWith('http://'));
  const emit = (e: OidcEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* an observer must never break the flow it observes */
    }
  };

  /* ------------------------------ discovery ------------------------------ */
  let endpoints: Promise<{ authorization: string; token: string; jwks: string }> | null = opts.endpoints ? Promise.resolve(opts.endpoints) : null;
  const discover = () => {
    if (!endpoints) {
      endpoints = (async () => {
        const url = opts.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
        const doc = (await res.json()) as Record<string, unknown>;
        const pick = (k: string) => {
          const v = doc[k];
          if (typeof v !== 'string') throw new Error(`discovery document has no ${k}`);
          return v;
        };
        return { authorization: pick('authorization_endpoint'), token: pick('token_endpoint'), jwks: pick('jwks_uri') };
      })().catch((e) => {
        endpoints = null; // try again next time rather than caching a failure
        throw e;
      });
    }
    return endpoints;
  };

  /* -------------------------------- keys --------------------------------- */
  let keys: { at: number; byKid: Map<string, KeyObject>; all: KeyObject[] } | null = null;
  async function loadKeys(force = false) {
    if (!force && keys && Date.now() - keys.at < jwksTtlMs) return keys;
    const { jwks } = await discover();
    const res = await fetchFn(jwks);
    if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
    const doc = (await res.json()) as { keys?: Jwk[] };
    const byKid = new Map<string, KeyObject>();
    const all: KeyObject[] = [];
    for (const jwk of doc.keys ?? []) {
      if (jwk.use && jwk.use !== 'sig') continue;
      try {
        const key = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
        all.push(key);
        if (jwk.kid) byKid.set(jwk.kid, key);
      } catch {
        /* a key we cannot import is a key we cannot verify with */
      }
    }
    keys = { at: Date.now(), byKid, all };
    return keys;
  }

  async function verifyIdToken(idToken: string, expectedNonce?: string): Promise<OidcClaims> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (!header || !payload) throw new Error('malformed JWT');
    const alg = header.alg;
    if (alg !== 'RS256' && alg !== 'ES256') throw new Error(`unsupported alg ${String(alg)}`);
    const kid = typeof header.kid === 'string' ? header.kid : undefined;

    // The key by id, refetching once if the provider has rotated since we last looked.
    let loaded = await loadKeys();
    let candidates = kid ? (loaded.byKid.has(kid) ? [loaded.byKid.get(kid)!] : []) : loaded.all;
    if (!candidates.length && kid) {
      loaded = await loadKeys(true);
      candidates = loaded.byKid.has(kid) ? [loaded.byKid.get(kid)!] : [];
    }
    if (!candidates.length) throw new Error('no key to verify with');

    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = b64url(parts[2]);
    const good = candidates.some((key) =>
      alg === 'RS256' ? verifySignature('sha256', data, key, sig) : verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
    );
    if (!good) throw new Error('bad signature');

    const claims = payload as unknown as OidcClaims;
    const issuer = opts.issuer.replace(/\/$/, '');
    const iss = typeof claims.iss === 'string' ? claims.iss.replace(/\/$/, '') : '';
    // Google issues both forms; both mean Google.
    if (iss !== issuer && iss !== issuer.replace(/^https:\/\//, '') && `https://${iss}` !== issuer) throw new Error('wrong issuer');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(opts.clientId)) throw new Error('wrong audience');
    if (typeof claims.azp === 'string' && claims.azp !== opts.clientId) throw new Error('wrong authorized party');
    const now = Date.now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + tolerance < now) throw new Error('expired');
    if (typeof claims.iat === 'number' && claims.iat - tolerance > now) throw new Error('issued in the future');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('no subject');
    if (expectedNonce !== undefined && claims.nonce !== expectedNonce) throw new Error('nonce mismatch');
    return claims;
  }

  /* ------------------------------- cookies ------------------------------- */
  const setState = (jar: ReturnType<typeof headerCookieSetter>, value: string) =>
    jar.setter.set(stateCookie, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: Math.ceil(stateTtlMs / 1000), secure: cookieSecure() });
  const clearState = (jar: ReturnType<typeof headerCookieSetter>) =>
    jar.setter.set(stateCookie, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0, secure: cookieSecure() });

  const failTo = (reason: OidcFailure) => {
    if (typeof opts.failureRedirect === 'function') return opts.failureRedirect(reason);
    const u = new URL(opts.failureRedirect, opts.redirectUri);
    u.searchParams.set('error', reason);
    return u.toString();
  };

  return {
    verifyIdToken,

    async start() {
      const { authorization } = await discover();
      const state = randomBytes(16).toString('base64url');
      const nonce = randomBytes(16).toString('base64url');
      const jar = headerCookieSetter();
      setState(jar, makeStateToken(secret(), `${state}.${nonce}`, stateTtlMs));
      const u = new URL(authorization);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', opts.clientId);
      u.searchParams.set('redirect_uri', opts.redirectUri);
      u.searchParams.set('scope', scope);
      u.searchParams.set('state', state);
      u.searchParams.set('nonce', nonce);
      for (const [k, v] of Object.entries(opts.authParams ?? {})) u.searchParams.set(k, v);
      emit({ type: 'started' });
      return redirectResponse(u.toString(), jar);
    },

    async callback(request) {
      const jar = headerCookieSetter();
      clearState(jar); // one flow per cookie, whatever happens next
      const fail = (reason: OidcFailure, detail?: string, sub?: string) => {
        emit({ type: 'refused', reason, detail, sub });
        return redirectResponse(failTo(reason), jar);
      };

      const q = new URL(request.url).searchParams;
      if (q.get('error')) return fail('provider', q.get('error') ?? undefined);
      const code = q.get('code');
      const state = q.get('state');
      if (!code || !state) return fail('provider', 'no code');

      // The state must match the one THIS browser was handed, signed and
      // unexpired. It binds the callback to the start, which is what stops a
      // login being forced onto a browser that never asked for one.
      const cookie = readCookie(request, stateCookie);
      const stored = cookie ? readStateToken(secret(), cookie) : null;
      const [expectedState, nonce] = stored ? stored.split('.') : [null, null];
      if (!expectedState || expectedState !== state || !nonce) return fail('state');

      const { token: tokenEndpoint } = await discover();
      let idToken: string;
      try {
        const res = await fetchFn(tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: opts.redirectUri, client_id: opts.clientId, client_secret: clientSecret() }),
        });
        if (!res.ok) return fail('exchange', String(res.status));
        const tokens = (await res.json()) as { id_token?: unknown };
        if (typeof tokens.id_token !== 'string') return fail('exchange', 'no id_token');
        idToken = tokens.id_token;
      } catch (e) {
        return fail('exchange', e instanceof Error ? e.message : String(e));
      }

      let claims: OidcClaims;
      try {
        claims = await verifyIdToken(idToken, nonce);
      } catch (e) {
        return fail('token', e instanceof Error ? e.message : String(e));
      }
      if (requireVerifiedEmail && claims.email_verified !== true) return fail('unverified-email', undefined, claims.sub);

      const user = await opts.onIdentity(claims, { request });
      if (!user) return fail('not-registered', undefined, claims.sub);
      if (user.status != null && !activeStatuses.includes(user.status)) return fail('inactive', user.status, claims.sub);

      const minted = await opts.sessions.mint({ userId: user.id, origin: opts.origin, ip: clientIp(request), userAgent: request.headers.get('user-agent') });
      opts.cookies.set(jar.setter, { accessToken: minted.accessToken, refreshToken: minted.refreshToken, expiresAtMs: Date.now() + minted.expires });
      emit({ type: 'signed-in', userId: user.id, sub: claims.sub });
      return redirectResponse(typeof opts.successRedirect === 'function' ? opts.successRedirect(user) : opts.successRedirect, jar);
    },
  };
}
