import { randomBytes } from 'node:crypto';
import type { Queryable } from './grants.js';
import { makeStateToken, readStateToken } from './signedTokens.js';
import type { SessionStore } from './sessions.js';
import type { SessionCookies } from './cookies.js';
import { crossSiteWrite, headerCookieSetter, readCookie } from './routes.js';
import { clientIp, jsonResponse, originAllowedBy, preflightResponse, type AllowOrigins } from './http.js';

/**
 * @allodium/auth/passkeys — WebAuthn registration and sign-in, written once.
 *
 * The ceremonies come from @simplewebauthn/server, which is an OPTIONAL peer:
 * it is imported lazily inside the factory, so a project that never imports
 * this entry point never loads it, and one that does gets a 503 that says to
 * install it rather than a crash at startup.
 *
 * What the package decides, because it is the same everywhere: the challenge
 * travels in a signed, HttpOnly, single-use cookie with its purpose and (for
 * registration) the user bound in — no server-side challenge table, nothing to
 * clean up, nothing a second tab can race; a usernameless login that requires
 * user verification, because a passkey is a passwordless single factor and a
 * bare stolen key must not sign in; the authenticator's signature counter is
 * kept and a regression refuses; the user handle in an assertion must name the
 * credential's owner. What stays yours: who is signed in, where credentials
 * are stored (a default store over the seed's table is included), which user
 * a credential belongs to and whether they may sign in.
 */

/* ------------------------------- the store -------------------------------- */

export interface PasskeyRecord {
  id: string;
  userId: string;
  /** base64url, as the browser reports it. */
  credentialId: string;
  /** base64url of the COSE public key. */
  publicKey: string;
  counter: number;
  transports: string[];
  label: string | null;
  backedUp: boolean;
  deviceType: string | null;
  createdAt?: string | null;
  lastUsedAt?: string | null;
}

export interface PasskeyStore {
  credentialsFor(userId: string): Promise<PasskeyRecord[]>;
  findByCredentialId(credentialId: string): Promise<PasskeyRecord | null>;
  save(record: Omit<PasskeyRecord, 'id' | 'createdAt' | 'lastUsedAt'>): Promise<{ id: string }>;
  /** After a successful sign-in: the new counter and the moment. */
  touch(id: string, counter: number): Promise<void>;
  /** Only the owner may remove. True if something was removed. */
  remove(id: string, userId: string): Promise<boolean>;
}

const ident = (n: string) => '"' + n.replaceAll('"', '""') + '"';

/**
 * The default store, over the table in dev/seed/009-passkeys.sql. Column names
 * may be renamed; the shape may not.
 */
export function createPasskeyStore(
  db: Queryable,
  opts: { table?: string; columns?: Partial<Record<'id' | 'userId' | 'credentialId' | 'publicKey' | 'counter' | 'transports' | 'label' | 'backedUp' | 'deviceType' | 'createdAt' | 'lastUsedAt', string>> } = {}
): PasskeyStore {
  const table = ident(opts.table ?? 'passkeys');
  const c = {
    id: 'id',
    userId: 'user_id',
    credentialId: 'credential_id',
    publicKey: 'public_key',
    counter: 'counter',
    transports: 'transports',
    label: 'label',
    backedUp: 'backed_up',
    deviceType: 'device_type',
    createdAt: 'created_at',
    lastUsedAt: 'last_used_at',
    ...(opts.columns ?? {}),
  };
  const col = (k: keyof typeof c) => ident(c[k]);
  const all = (Object.keys(c) as (keyof typeof c)[]).map((k) => `${col(k)} as ${ident(k)}`).join(', ');
  const toRecord = (r: Record<string, unknown>): PasskeyRecord => ({
    id: String(r.id),
    userId: String(r.userId),
    credentialId: String(r.credentialId),
    publicKey: String(r.publicKey),
    counter: Number(r.counter) || 0,
    transports: Array.isArray(r.transports) ? (r.transports as unknown[]).map(String) : [],
    label: r.label == null ? null : String(r.label),
    backedUp: !!r.backedUp,
    deviceType: r.deviceType == null ? null : String(r.deviceType),
    createdAt: r.createdAt == null ? null : String(r.createdAt),
    lastUsedAt: r.lastUsedAt == null ? null : String(r.lastUsedAt),
  });
  return {
    async credentialsFor(userId) {
      const res = await db.query(`select ${all} from ${table} where ${col('userId')} = $1 order by ${col('createdAt')} asc`, [userId]);
      return (res.rows as Record<string, unknown>[]).map(toRecord);
    },
    async findByCredentialId(credentialId) {
      const res = await db.query(`select ${all} from ${table} where ${col('credentialId')} = $1 limit 1`, [credentialId]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      return row ? toRecord(row) : null;
    },
    async save(r) {
      const res = await db.query(
        `insert into ${table} (${col('userId')}, ${col('credentialId')}, ${col('publicKey')}, ${col('counter')}, ${col('transports')}, ${col('label')}, ${col('backedUp')}, ${col('deviceType')})
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${col('id')} as id`,
        [r.userId, r.credentialId, r.publicKey, r.counter, r.transports, r.label, r.backedUp, r.deviceType]
      );
      return { id: String((res.rows[0] as { id: unknown }).id) };
    },
    async touch(id, counter) {
      await db.query(`update ${table} set ${col('counter')} = $2, ${col('lastUsedAt')} = now() where ${col('id')} = $1`, [id, counter]);
    },
    async remove(id, userId) {
      const res = await db.query(`delete from ${table} where ${col('id')} = $1 and ${col('userId')} = $2`, [id, userId]);
      return (res.rowCount ?? 0) > 0;
    },
  };
}

/* ------------------------------- the routes ------------------------------- */

export type PasskeyEvent =
  | { type: 'registered'; userId: string; credentialId: string }
  | { type: 'signed-in'; userId: string; credentialId: string }
  | { type: 'removed'; userId: string; id: string }
  | { type: 'refused'; stage: 'register' | 'login'; reason: string; userId?: string };

export interface PasskeysOptions {
  /** The relying party id: your hostname, "example.com". Thunk for env-driven config. */
  rpID: string | (() => string);
  /** Shown by the authenticator — your product's name. */
  rpName: string;
  /** The origin(s) the ceremonies happen on, "https://example.com". */
  origin: string | string[] | (() => string | string[]);
  /** Signs the challenge cookie. Any long random string. */
  challengeSecret: string | (() => string);
  /** Default 5 minutes. */
  challengeTtlMs?: number;
  /** Default "webauthn_challenge". */
  challengeCookie?: string;
  /** Secure attribute on the challenge cookie. Default: true unless the origin is http. */
  cookieSecure?: boolean | (() => boolean);
  store: PasskeyStore;
  /** The signed-in user, for registration, listing and removal. Null answers 401. */
  currentUser(request: Request): Promise<{ id: string; name: string; displayName?: string | null } | null>;
  /** For sign-in: the owner of a credential. Null or inactive refuses. */
  findUserById(id: string): Promise<{ id: string; status?: string | null } | null>;
  /** What a successful sign-in returns to the browser. Default `{ id }`. */
  toPublicUser?(user: { id: string; status?: string | null }): unknown;
  sessions: Pick<SessionStore, 'mint'>;
  cookies: SessionCookies;
  /** The `origin` stored on sessions minted here — "passkey", or your surface's name. */
  sessionOrigin: string;
  activeStatuses?: string[];
  /** Sign-in is a single factor: default "required". Registration defaults to "preferred". */
  userVerification?: 'required' | 'preferred';
  registrationUserVerification?: 'required' | 'preferred' | 'discouraged';
  /** Default: offer platform and roaming authenticators alike, resident key preferred. */
  residentKey?: 'required' | 'preferred' | 'discouraged';
  allowOrigins?: AllowOrigins;
  onEvent?(event: PasskeyEvent): void;
}

export interface Passkeys {
  /** POST, signed in — options for `startRegistration()`; sets the challenge cookie. */
  registerOptions(request: Request): Promise<Response>;
  /** POST, signed in — `{ response, label? }` from `startRegistration()`; stores the credential. */
  registerVerify(request: Request): Promise<Response>;
  /** POST, public — options for a usernameless `startAuthentication()`; sets the challenge cookie. */
  loginOptions(request: Request): Promise<Response>;
  /** POST, public — `{ response }` from `startAuthentication()`; mints a session. */
  loginVerify(request: Request): Promise<Response>;
  /** GET, signed in — the user's passkeys, without their public keys. */
  list(request: Request): Promise<Response>;
  /** DELETE, signed in — remove one of the user's own passkeys. */
  remove(request: Request, id: string): Promise<Response>;
  preflight(request: Request): Response;
}

type Lib = typeof import('@simplewebauthn/server');

export function createPasskeys(opts: PasskeysOptions): Passkeys {
  const rpID = () => (typeof opts.rpID === 'function' ? opts.rpID() : opts.rpID);
  const origins = () => {
    const o = typeof opts.origin === 'function' ? opts.origin() : opts.origin;
    return Array.isArray(o) ? o : [o];
  };
  const secret = () => (typeof opts.challengeSecret === 'function' ? opts.challengeSecret() : opts.challengeSecret);
  const ttlMs = opts.challengeTtlMs ?? 5 * 60_000;
  const cookieName = opts.challengeCookie ?? 'webauthn_challenge';
  const cookieSecure = () => (typeof opts.cookieSecure === 'function' ? opts.cookieSecure() : (opts.cookieSecure ?? !origins()[0]?.startsWith('http://')));
  const activeStatuses = opts.activeStatuses ?? ['active'];
  const loginUV = opts.userVerification ?? 'required';
  const regUV = opts.registrationUserVerification ?? 'preferred';
  const originAllowed = originAllowedBy(opts.allowOrigins);
  const emit = (e: PasskeyEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* observers never break the flow */
    }
  };
  const json = (request: Request, body: unknown, status = 200, jar?: ReturnType<typeof headerCookieSetter>) => jsonResponse(request, opts.allowOrigins, body, status, jar);

  // The peer, loaded on first use. A missing install is a 503 with the fix in it.
  let lib: Promise<Lib> | null = null;
  const load = (): Promise<Lib> => {
    if (!lib) {
      lib = import('@simplewebauthn/server').catch((e: unknown) => {
        lib = null;
        throw new PasskeysUnavailable(e);
      });
    }
    return lib;
  };

  async function body(request: Request): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = await request.json();
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /* ----------------------------- the challenge ----------------------------- */
  type Purpose = 'reg' | 'auth';
  const setChallenge = (jar: ReturnType<typeof headerCookieSetter>, purpose: Purpose, challenge: string, userId: string | null) =>
    jar.setter.set(cookieName, makeStateToken(secret(), JSON.stringify({ c: challenge, p: purpose, u: userId }), ttlMs), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.ceil(ttlMs / 1000),
      secure: cookieSecure(),
    });
  const clearChallenge = (jar: ReturnType<typeof headerCookieSetter>) =>
    jar.setter.set(cookieName, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0, secure: cookieSecure() });
  /**
   * Single use, three ways. The response clears the cookie, so a browser does
   * not send it twice; a captured assertion carries a counter the stored one
   * has already passed; and this process remembers every challenge it has
   * accepted until the cookie would have expired anyway, so a client that
   * kept the cookie and re-signed cannot use the same challenge again here.
   * (Across several instances the first two still hold; the set is per process.)
   */
  const spent = new Map<string, number>();
  const markSpent = (challenge: string) => {
    const now = Date.now();
    for (const [c, at] of spent) if (now - at > ttlMs) spent.delete(c);
    spent.set(challenge, now);
  };
  /** The challenge this browser was handed for this purpose, or null. The caller clears the cookie whatever happens. */
  const readChallenge = (request: Request, purpose: Purpose): { challenge: string; userId: string | null } | null => {
    const raw = readCookie(request, cookieName);
    const state = raw ? readStateToken(secret(), raw) : null;
    if (!state) return null;
    try {
      const v = JSON.parse(state) as { c?: unknown; p?: unknown; u?: unknown };
      if (v.p !== purpose || typeof v.c !== 'string' || !v.c) return null;
      if (spent.has(v.c)) return null;
      return { challenge: v.c, userId: typeof v.u === 'string' && v.u ? v.u : null };
    } catch {
      return null;
    }
  };

  const withLib = async (request: Request, fn: (sw: Lib) => Promise<Response>): Promise<Response> => {
    try {
      return await fn(await load());
    } catch (e) {
      if (e instanceof PasskeysUnavailable) return json(request, { error: 'Passkeys are not available on this server: install @simplewebauthn/server' }, 503);
      throw e;
    }
  };

  return {
    preflight: (request) => preflightResponse(request, opts.allowOrigins, 'GET, POST, DELETE, OPTIONS'),

    registerOptions(request) {
      return withLib(request, async (sw) => {
        const refused = crossSiteWrite(request, originAllowed);
        if (refused) return json(request, { error: refused.message }, refused.status);
        const user = await opts.currentUser(request);
        if (!user) return json(request, { error: 'Not signed in' }, 401);
        const existing = await opts.store.credentialsFor(user.id);
        const options = await sw.generateRegistrationOptions({
          rpName: opts.rpName,
          rpID: rpID(),
          userName: user.name,
          userDisplayName: user.displayName ?? user.name,
          userID: new TextEncoder().encode(user.id),
          attestationType: 'none',
          // The browser refuses to register an authenticator the user already has.
          excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
          authenticatorSelection: { residentKey: opts.residentKey ?? 'preferred', userVerification: regUV },
        });
        const jar = headerCookieSetter();
        setChallenge(jar, 'reg', options.challenge, user.id);
        return json(request, options, 200, jar);
      });
    },

    registerVerify(request) {
      return withLib(request, async (sw) => {
        const refused = crossSiteWrite(request, originAllowed);
        if (refused) return json(request, { error: refused.message }, refused.status);
        const jar = headerCookieSetter();
        clearChallenge(jar);
        const user = await opts.currentUser(request);
        if (!user) return json(request, { error: 'Not signed in' }, 401, jar);
        const { response, label } = (await body(request)) as { response?: unknown; label?: unknown };
        if (!response || typeof response !== 'object') return json(request, { error: 'Missing passkey response' }, 400, jar);

        // Bound to this user at registerOptions time: a challenge minted for
        // one account cannot register a key on another.
        const challenge = readChallenge(request, 'reg');
        if (!challenge || challenge.userId !== user.id) {
          emit({ type: 'refused', stage: 'register', reason: 'challenge', userId: user.id });
          return json(request, { error: 'The passkey challenge expired — start again' }, 400, jar);
        }

        let verification: Awaited<ReturnType<Lib['verifyRegistrationResponse']>>;
        try {
          verification = await sw.verifyRegistrationResponse({
            response: response as never,
            expectedChallenge: challenge.challenge,
            expectedOrigin: origins(),
            expectedRPID: rpID(),
            requireUserVerification: regUV === 'required',
          });
        } catch (e) {
          emit({ type: 'refused', stage: 'register', reason: e instanceof Error ? e.message : 'verification', userId: user.id });
          return json(request, { error: 'The passkey could not be verified' }, 400, jar);
        }
        if (!verification.verified) {
          emit({ type: 'refused', stage: 'register', reason: 'not verified', userId: user.id });
          return json(request, { error: 'The passkey could not be verified' }, 400, jar);
        }
        markSpent(challenge.challenge);
        const info = verification.registrationInfo;
        const transports = (info.credential.transports ?? (response as { response?: { transports?: string[] } }).response?.transports ?? []) as string[];
        const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : null;
        const saved = await opts.store.save({
          userId: user.id,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
          counter: info.credential.counter,
          transports,
          label: name,
          backedUp: info.credentialBackedUp,
          deviceType: info.credentialDeviceType,
        });
        emit({ type: 'registered', userId: user.id, credentialId: info.credential.id });
        return json(request, { id: saved.id, label: name, transports, backedUp: info.credentialBackedUp }, 201, jar);
      });
    },

    loginOptions(request) {
      return withLib(request, async (sw) => {
        const refused = crossSiteWrite(request, originAllowed);
        if (refused) return json(request, { error: refused.message }, refused.status);
        // Usernameless: no allowCredentials, so the browser offers whatever
        // passkeys it holds for this relying party.
        const options = await sw.generateAuthenticationOptions({ rpID: rpID(), allowCredentials: [], userVerification: loginUV });
        const jar = headerCookieSetter();
        setChallenge(jar, 'auth', options.challenge, null);
        return json(request, options, 200, jar);
      });
    },

    loginVerify(request) {
      return withLib(request, async (sw) => {
        const refused = crossSiteWrite(request, originAllowed);
        if (refused) return json(request, { error: refused.message }, refused.status);
        const jar = headerCookieSetter();
        clearChallenge(jar);
        const { response } = (await body(request)) as { response?: { id?: unknown; response?: { userHandle?: unknown } } };
        if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !response.id) {
          return json(request, { error: 'Missing passkey response' }, 400, jar);
        }
        const challenge = readChallenge(request, 'auth');
        if (!challenge) {
          emit({ type: 'refused', stage: 'login', reason: 'challenge' });
          return json(request, { error: 'The passkey challenge expired — start again' }, 400, jar);
        }
        // One answer for every way a sign-in can fail short of a known account
        // that may not sign in: the response must not say which.
        const refuse = (reason: string, userId?: string) => {
          emit({ type: 'refused', stage: 'login', reason, userId });
          return json(request, { error: 'Passkey sign-in failed' }, 401, jar);
        };

        const record = await opts.store.findByCredentialId(response.id);
        if (!record) return refuse('unknown credential');
        // The user handle names the owner; an assertion claiming someone else is wrong by construction.
        const handle = response.response?.userHandle;
        if (typeof handle === 'string' && handle) {
          let decoded = '';
          try {
            decoded = Buffer.from(handle, 'base64url').toString('utf8');
          } catch {
            /* not ours */
          }
          if (decoded !== record.userId) return refuse('user handle mismatch', record.userId);
        }

        let verification: Awaited<ReturnType<Lib['verifyAuthenticationResponse']>>;
        try {
          verification = await sw.verifyAuthenticationResponse({
            response: response as never,
            expectedChallenge: challenge.challenge,
            expectedOrigin: origins(),
            expectedRPID: rpID(),
            credential: {
              id: record.credentialId,
              publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')),
              counter: record.counter,
              transports: record.transports as never,
            },
            requireUserVerification: loginUV === 'required',
          });
        } catch (e) {
          return refuse(e instanceof Error ? e.message : 'verification', record.userId);
        }
        if (!verification.verified) return refuse('not verified', record.userId);
        markSpent(challenge.challenge);

        const user = await opts.findUserById(record.userId);
        if (!user) return refuse('no user', record.userId);
        if (user.status != null && !activeStatuses.includes(user.status)) {
          emit({ type: 'refused', stage: 'login', reason: 'inactive', userId: user.id });
          return json(request, { error: `This account is ${user.status}`, status: user.status }, 403, jar);
        }

        await opts.store.touch(record.id, verification.authenticationInfo.newCounter);
        const minted = await opts.sessions.mint({ userId: user.id, origin: opts.sessionOrigin, ip: clientIp(request), userAgent: request.headers.get('user-agent') });
        opts.cookies.set(jar.setter, { accessToken: minted.accessToken, refreshToken: minted.refreshToken, expiresAtMs: Date.now() + minted.expires });
        emit({ type: 'signed-in', userId: user.id, credentialId: record.credentialId });
        return json(request, { user: opts.toPublicUser ? opts.toPublicUser(user) : { id: user.id }, expires: minted.expires }, 200, jar);
      });
    },

    async list(request) {
      const user = await opts.currentUser(request);
      if (!user) return json(request, { error: 'Not signed in' }, 401);
      const rows = await opts.store.credentialsFor(user.id);
      // Never the public key: it is not a secret, but it is not the browser's business either.
      return json(request, {
        passkeys: rows.map((r) => ({ id: r.id, label: r.label, transports: r.transports, backedUp: r.backedUp, deviceType: r.deviceType, createdAt: r.createdAt ?? null, lastUsedAt: r.lastUsedAt ?? null })),
      });
    },

    async remove(request, id) {
      const refused = crossSiteWrite(request, originAllowed);
      if (refused) return json(request, { error: refused.message }, refused.status);
      const user = await opts.currentUser(request);
      if (!user) return json(request, { error: 'Not signed in' }, 401);
      // Someone else's passkey and no such passkey answer the same way.
      const removed = await opts.store.remove(id, user.id);
      if (!removed) return json(request, { error: 'Not found' }, 404);
      emit({ type: 'removed', userId: user.id, id });
      return json(request, { ok: true });
    },
  };
}

class PasskeysUnavailable extends Error {
  constructor(cause: unknown) {
    super('@simplewebauthn/server is not installed');
    this.name = 'PasskeysUnavailable';
    this.cause = cause;
  }
}
