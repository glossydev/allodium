import { verifyPassword, DUMMY_ARGON2ID_HASH } from './passwords.js';
import { firstForwardedIp } from './ip.js';
import type { SessionStore } from './sessions.js';
import type { SessionCookies, CookieSetter } from './cookies.js';
import type { RateLimiter } from './rateLimit.js';

/**
 * The four endpoints every app rewrites, written once.
 *
 * Login, logout, refresh and me are not interesting — which is exactly why they
 * are worth shipping. Each one has two or three details that are easy to get
 * wrong and silent when you do: a login that reveals which emails exist by
 * returning faster for unknown ones; a /me that hands back the raw user row with
 * its password hash; a refresh that clears the session on a network blip.
 *
 * Framework-free, like the rest of this package: these take a Web `Request` and
 * return a Web `Response`, which is what a Next route handler, Hono, and a plain
 * Node server with an adapter all speak. No env vars are read here.
 */

/** The row your user lookup returns. Nothing else about your schema is assumed. */
export interface AuthUserRow {
  id: string;
  /** argon2id digest. Null for an account with no password (SSO-only) — always refused here. */
  passwordHash: string | null;
  /** Anything non-active refuses with a DISTINGUISHABLE reason; see the note on login. */
  status?: string | null;
}

export interface AuthRoutesOptions {
  sessions: SessionStore;
  cookies: SessionCookies;
  /**
   * The surface these sessions belong to — "site", "admin". Stored on the session
   * and used to scope resolution, so a cookie moved between surfaces resolves to
   * nothing. This is the whole reason `origin` exists on the store.
   */
  origin: string;
  /** Look up by email. Return null for unknown — the timing is equalised for you. */
  findUserByEmail(email: string): Promise<AuthUserRow | null>;
  /**
   * What /me puts on the wire. REQUIRED, and required to be explicit.
   *
   * `resolveUser` hands back the raw database row, which on a users table means
   * the password hash. Defaulting to "the row" would leak it from an endpoint
   * whose entire job is to be called by a browser; defaulting to a guessed subset
   * would be this library deciding what your users may see about themselves.
   */
  toPublicUser(row: Record<string, unknown>): unknown;
  /** Statuses allowed to sign in. Defaults to ['active']. */
  activeStatuses?: string[];
  /** Optional: attach roles and claims to /me, from the grant loader. */
  actorFor?(userId: string): Promise<unknown>;
  /** Optional login throttle. Keyed per email AND per IP — see below. */
  rateLimit?: RateLimiter;
  limits?: { perEmail?: number; perIp?: number; windowMs?: number };
  /**
   * Origins allowed to call these endpoints with credentials.
   *
   * A cross-origin browser client cannot read a response without
   * Access-Control-Allow-Origin naming its exact origin, and cannot send cookies
   * without Allow-Credentials — and the wildcard is forbidden in combination with
   * credentials, so this must be an allowlist. Omit it for a same-origin app.
   */
  allowOrigins?: string[] | ((origin: string) => boolean);
}

export interface AuthRoutes {
  /** POST — { email, password } */
  login(request: Request): Promise<Response>;
  /** POST — revokes the session by whatever the cookie jar holds. 500 with cookies intact if the revoke itself failed. */
  logout(request: Request): Promise<Response>;
  /** POST — single-use rotation of the refresh cookie. */
  refresh(request: Request): Promise<Response>;
  /** GET — the current user, or 401. */
  me(request: Request): Promise<Response>;
  /** OPTIONS — CORS preflight for any of the above. */
  preflight(request: Request): Response;
}

/* --------------------------- cookie plumbing --------------------------- */

const ATTR: Record<string, string> = {
  httpOnly: 'HttpOnly',
  secure: 'Secure',
  sameSite: 'SameSite',
  path: 'Path',
  maxAge: 'Max-Age',
  domain: 'Domain',
  expires: 'Expires',
};

/**
 * A `CookieSetter` that writes into response headers.
 *
 * The cookie helper speaks the Next/`cookies()` shape — `set(name, value, opts)`
 * — so bridging it to a Web Response means serialising here. Every cookie gets
 * its own Set-Cookie header; folding them into one comma-separated value is a
 * classic way to lose all but the first.
 */
export function headerCookieSetter(): { setter: CookieSetter; applyTo(headers: Headers): void } {
  const jar: string[] = [];
  return {
    setter: {
      set(name: string, value: string, options: Record<string, unknown> = {}) {
        const parts = [`${name}=${encodeURIComponent(value)}`];
        for (const [key, raw] of Object.entries(options)) {
          if (raw === undefined || raw === null || raw === false) continue;
          const attr = ATTR[key];
          if (!attr) continue;
          if (raw === true) parts.push(attr);
          else if (key === 'sameSite') parts.push(`${attr}=${String(raw).charAt(0).toUpperCase()}${String(raw).slice(1)}`);
          else parts.push(`${attr}=${String(raw)}`);
        }
        jar.push(parts.join('; '));
      },
    },
    applyTo(headers) {
      for (const c of jar) headers.append('Set-Cookie', c);
    },
  };
}

/** Read one cookie from a request. No dependency, and no need for a general parser. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Refuse a state-changing request that a browser sent from a site this app did
 * not name — the cross-site request forgery check.
 *
 * CORS headers alone do not do this. They decide whether a script may READ the
 * response; the request itself, cookies and all, has already reached the
 * handler. SameSite cookies cover most of the gap, but not two surfaces on
 * sibling subdomains, which are "same site" to a cookie and different origins
 * to everything else — and that is exactly how a public site and its back
 * office get deployed.
 *
 * Three cheap facts settle it. A browser always sends Origin on a cross-origin
 * POST, so an Origin that is neither this host nor allowlisted is refused. A
 * cross-site form cannot set `Content-Type: application/json` without a
 * preflight, so a body typed as anything else is refused. And modern browsers
 * label the request's provenance in Sec-Fetch-Site, which catches the case
 * where Origin is absent. A request with no Origin, no provenance label and no
 * body — curl, a server, a same-origin fetch — passes.
 *
 * Only the HOST of the origin is compared, not the scheme: behind a reverse
 * proxy the handler sees http://host while the browser sent https://host, and
 * refusing every write on that mismatch would be a very quiet outage.
 */
export function crossSiteWrite(request: Request, originAllowed: (origin: string) => boolean): { status: number; message: string } | null {
  const origin = request.headers.get('origin');
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === new URL(request.url).host;
    } catch {
      /* an unparseable Origin is not this host */
    }
    if (!sameHost && !originAllowed(origin)) return { status: 403, message: `Cross-origin request from ${origin} refused` };
  } else if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return { status: 403, message: 'Cross-site request refused' };
  }
  const type = request.headers.get('content-type');
  if (type && !/^\s*application\/json\b/i.test(type)) return { status: 415, message: 'Expected application/json' };
  return null;
}

/* ------------------------------- factory ------------------------------- */

export function createAuthRoutes(opts: AuthRoutesOptions): AuthRoutes {
  const activeStatuses = opts.activeStatuses ?? ['active'];
  const perEmail = opts.limits?.perEmail ?? 5;
  const perIp = opts.limits?.perIp ?? 20;
  const windowMs = opts.limits?.windowMs ?? 15 * 60_000;

  const originAllowed = (origin: string): boolean => {
    if (!opts.allowOrigins) return false;
    return typeof opts.allowOrigins === 'function' ? opts.allowOrigins(origin) : opts.allowOrigins.includes(origin);
  };

  /** CORS headers for a request, or nothing when it is same-origin or not allowed. */
  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get('origin');
    if (!origin || !originAllowed(origin)) return {};
    return {
      // The exact origin, never "*": a wildcard is ignored when credentials are
      // in play, and these endpoints are nothing but credentials.
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
  };

  const json = (request: Request, body: unknown, status = 200, cookieHeaders?: { applyTo(h: Headers): void }): Response => {
    const headers = new Headers({ 'Content-Type': 'application/json', ...cors(request) });
    cookieHeaders?.applyTo(headers);
    return new Response(JSON.stringify(body), { status, headers });
  };

  const clientIp = (request: Request): string | null =>
    firstForwardedIp(request.headers.get('x-forwarded-for')) ?? request.headers.get('x-real-ip') ?? null;

  async function body(request: Request): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = await request.json();
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  return {
    preflight(request) {
      const headers = new Headers({
        ...cors(request),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return new Response(null, { status: 204, headers });
    },

    async login(request) {
      // Login CSRF is real: a forged sign-in as the attacker's account puts the
      // victim's later activity in a session the attacker can read.
      const refused = crossSiteWrite(request, originAllowed);
      if (refused) return json(request, { error: refused.message }, refused.status);

      const { email, password } = (await body(request)) as { email?: string; password?: string };
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return json(request, { error: 'Email and password are required' }, 400);
      }

      const ip = clientIp(request);
      if (opts.rateLimit) {
        // Per email AND per IP: per-email alone lets one host walk a user list,
        // per-IP alone lets a botnet grind one account.
        const emailOk = opts.rateLimit(`login:email:${email.toLowerCase()}`, perEmail, windowMs);
        const ipOk = ip ? opts.rateLimit(`login:ip:${ip}`, perIp, windowMs) : true;
        if (!emailOk || !ipOk) return json(request, { error: 'Too many attempts. Try again later.' }, 429);
      }

      const user = await opts.findUserByEmail(email);

      // Verify against a real digest even when the account does not exist, so an
      // unknown email costs the same time as a wrong password. Skipping this is
      // how a login endpoint becomes an account-enumeration oracle.
      const digest = user?.passwordHash ?? DUMMY_ARGON2ID_HASH;
      const correct = await verifyPassword(digest, password);
      if (!user || !user.passwordHash || !correct) {
        return json(request, { error: 'Those details do not match an account' }, 401);
      }

      // Status failures ARE distinguishable, deliberately: the person typed the
      // right password, and "your account is suspended" is the only answer that
      // lets them do anything about it. It reveals nothing they did not prove.
      if (user.status != null && !activeStatuses.includes(user.status)) {
        return json(request, { error: `This account is ${user.status}`, status: user.status }, 403);
      }

      const minted = await opts.sessions.mint({
        userId: user.id,
        origin: opts.origin,
        ip,
        userAgent: request.headers.get('user-agent'),
      });
      const jar = headerCookieSetter();
      opts.cookies.set(jar.setter, {
        accessToken: minted.accessToken,
        refreshToken: minted.refreshToken,
        expiresAtMs: Date.now() + minted.expires,
      });
      const row = await opts.sessions.resolveUser(minted.accessToken, { origin: { equals: opts.origin } });
      return json(request, { user: row ? opts.toPublicUser(row) : null, expires: minted.expires }, 200, jar);
    },

    async logout(request) {
      const refused = crossSiteWrite(request, originAllowed);
      if (refused) return json(request, { error: refused.message }, refused.status);

      const accessToken = readCookie(request, opts.cookies.names.access);
      const refreshToken = readCookie(request, opts.cookies.names.refresh);
      // The cookies are cleared only once the session is gone. Clearing them over
      // a revoke that failed would leave someone believing they are signed out
      // while their session lives on in the database — the one outcome a logout
      // must never produce. A failure here is a 500 with the cookies intact, so
      // the person sees "try again" rather than a lie.
      try {
        await opts.sessions.revoke({ accessToken, refreshToken });
      } catch {
        return json(request, { error: 'Sign-out did not complete — try again' }, 500);
      }
      const jar = headerCookieSetter();
      opts.cookies.clear(jar.setter);
      return json(request, { ok: true }, 200, jar);
    },

    async refresh(request) {
      const refused = crossSiteWrite(request, originAllowed);
      if (refused) return json(request, { error: refused.message }, refused.status);

      const refreshToken = readCookie(request, opts.cookies.names.refresh);
      if (!refreshToken) return json(request, { error: 'No session' }, 401);

      // Scoped to this surface, as /me is: a refresh cookie carried over from
      // the other surface must not rotate here and come back wearing this
      // surface's cookie names.
      const minted = await opts.sessions.rotate(refreshToken, { origin: { equals: opts.origin } });
      // A 401 here means the token is genuinely spent or unknown. Cookies are NOT
      // cleared: of two concurrent refreshes exactly one wins by design, and
      // clearing on the loser would sign out a perfectly good session.
      if (!minted) return json(request, { error: 'Session expired' }, 401);

      const jar = headerCookieSetter();
      opts.cookies.set(jar.setter, {
        accessToken: minted.accessToken,
        refreshToken: minted.refreshToken,
        expiresAtMs: Date.now() + minted.expires,
      });
      return json(request, { expires: minted.expires }, 200, jar);
    },

    async me(request) {
      const accessToken = readCookie(request, opts.cookies.names.access);
      if (!accessToken) return json(request, { error: 'Not signed in' }, 401);

      // Scoped to this surface: a cookie lifted from the admin origin and replayed
      // at the site resolves to nothing, which is the point of storing an origin.
      const row = await opts.sessions.resolveUser(accessToken, { origin: { equals: opts.origin } });
      if (!row) return json(request, { error: 'Not signed in' }, 401);

      const user = opts.toPublicUser(row);
      const actor = opts.actorFor ? await opts.actorFor(String((row as { id?: unknown }).id)) : undefined;
      return json(request, actor === undefined ? { user } : { user, actor }, 200);
    },
  };
}
