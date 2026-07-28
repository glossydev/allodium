/**
 * Session-cookie triple: access token, refresh token, and a readable expiry timestamp.
 *
 * Every setter AND deleter must use the same attributes: a cookie set with a Domain can
 * only be cleared by a deletion carrying the same Domain, which is why deletion is
 * set-empty-with-maxAge-0 rather than a delete() call.
 *
 * Framework-free: anything with a `set(name, value, options)` method works — both
 * Next.js cookie stores (`await cookies()` and `NextResponse.cookies`) already do.
 */

export interface SessionCookieNames {
  access: string;
  refresh: string;
  expires: string;
}

// A type alias (not an interface) on purpose: aliases get implicit index signatures,
// so the base is assignable to cookie stores' options params.
export type SessionCookieBase = {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
  domain?: string;
};

export interface CookieSetter {
  set(name: string, value: string, options: Record<string, unknown>): unknown;
}

export interface SessionCookies {
  names: SessionCookieNames;
  /** The shared attribute base — evaluated per call so env-driven config stays live. */
  base(): SessionCookieBase;
  /** Write the three session cookies (login, oauth callback, refresh). */
  set(store: CookieSetter, tokens: { accessToken: string; refreshToken: string; expiresAtMs: number }): void;
  /** Clear the cookies with matching attributes (works with or without Domain). */
  clear(store: CookieSetter): void;
}

/**
 * `secure` and `domain` take thunks so deployments that read them from env keep
 * call-time semantics (e.g. `() => process.env.NODE_ENV === 'production'`).
 * `maxAgeSec` should equal the refresh-token TTL — one config value, not three copies.
 */
export function createSessionCookies(opts: {
  names: SessionCookieNames;
  maxAgeSec: number;
  secure: boolean | (() => boolean);
  domain?: string | (() => string | undefined);
}): SessionCookies {
  const secure = typeof opts.secure === 'function' ? opts.secure : () => opts.secure as boolean;
  const domain = typeof opts.domain === 'function' ? opts.domain : () => opts.domain as string | undefined;

  const base = (): SessionCookieBase => {
    const d = domain();
    return {
      httpOnly: true,
      secure: secure(),
      sameSite: 'lax',
      path: '/',
      maxAge: opts.maxAgeSec,
      ...(d ? { domain: d } : {}),
    };
  };

  return {
    names: opts.names,
    base,
    set(store, tokens) {
      const b = base();
      store.set(opts.names.access, tokens.accessToken, b);
      store.set(opts.names.refresh, tokens.refreshToken, b);
      store.set(opts.names.expires, String(tokens.expiresAtMs), b);
    },
    clear(store) {
      const b = { ...base(), maxAge: 0 };
      for (const name of [opts.names.access, opts.names.refresh, opts.names.expires]) {
        store.set(name, '', b);
      }
    },
  };
}
