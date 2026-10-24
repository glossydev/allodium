import { hashPassword } from './passwords.js';
import type { ResetTokens } from './signedTokens.js';
import type { SessionStore } from './sessions.js';
import type { RateLimiter } from './rateLimit.js';
import { crossSiteWrite } from './routes.js';
import { clientIp, jsonResponse, originAllowedBy, preflightResponse, type AllowOrigins } from './http.js';

/**
 * @allodium/auth/reset — the two password-reset routes, written once.
 *
 * Every application rewrites these, and the rewrite is where the mistakes
 * come back: a request endpoint that answers differently for an unknown
 * email and so lists your users; a token that outlives the password it was
 * issued against; sessions that survive the reset that was meant to lock an
 * intruder out. The ceremony here gets those right. What stays yours is every
 * decision: how a user is found, where the hash is stored, what the email
 * says and how it is sent, and where the link points.
 *
 * Optional entry point: import from '@allodium/auth/reset'. A project that
 * does not want it does not load it.
 */

/** The row your lookups return. Nothing else about your schema is assumed. */
export interface ResetUserRow {
  id: string;
  email: string;
  /** argon2id digest. Null for an account with no password (SSO-only): such an account cannot reset one. */
  passwordHash: string | null;
  status?: string | null;
}

export type ResetEvent =
  | { type: 'requested'; email: string; eligible: boolean }
  | { type: 'sent'; userId: string }
  | { type: 'send-failed'; userId: string; error: unknown }
  | { type: 'reset'; userId: string }
  | { type: 'refused'; reason: 'invalid-token' | 'inactive' | 'weak-password'; userId?: string };

export interface ResetRoutesOptions {
  /** `createResetTokens(...)` — keyed on the user's current hash, so a reset kills every outstanding token. */
  tokens: ResetTokens;
  /** For revoking every session once the password changes. */
  sessions: Pick<SessionStore, 'revokeAllForUser'>;
  findUserByEmail(email: string): Promise<ResetUserRow | null>;
  findUserById(id: string): Promise<ResetUserRow | null>;
  /** Store the new argon2id digest — the one write this flow makes to your users table. */
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Where the link in the email points, given the token. */
  resetUrl(token: string): string;
  /**
   * Deliver the link. Called only for an active account that has a password,
   * and NOT awaited before the response: a slow mail server must not make a
   * known email answer slower than an unknown one. Failures reach `onEvent`.
   */
  sendMail(args: { to: string; user: ResetUserRow; resetUrl: string; token: string }): Promise<void>;
  /** Statuses that may reset. Defaults to ['active']. */
  activeStatuses?: string[];
  /** Default 10. Length is the only rule enforced here; composition rules are yours. */
  minPasswordLength?: number;
  /** Throttle for the request endpoint, keyed per email AND per IP. */
  rateLimit?: RateLimiter;
  limits?: { perEmail?: number; perIp?: number; windowMs?: number };
  allowOrigins?: AllowOrigins;
  onEvent?(event: ResetEvent): void;
}

export interface ResetRoutes {
  /** POST { email } — always 200, so the endpoint cannot say which emails exist. */
  request(request: Request): Promise<Response>;
  /** POST { token, password } — 200 on success; 400 for a weak password; 401 for a token that is not valid; 403 for an account that may not sign in. */
  reset(request: Request): Promise<Response>;
  /** OPTIONS — CORS preflight. */
  preflight(request: Request): Response;
}

export function createResetRoutes(opts: ResetRoutesOptions): ResetRoutes {
  const activeStatuses = opts.activeStatuses ?? ['active'];
  const minLength = opts.minPasswordLength ?? 10;
  const perEmail = opts.limits?.perEmail ?? 3;
  const perIp = opts.limits?.perIp ?? 10;
  const windowMs = opts.limits?.windowMs ?? 60 * 60_000;
  const originAllowed = originAllowedBy(opts.allowOrigins);
  const json = (request: Request, body: unknown, status = 200) => jsonResponse(request, opts.allowOrigins, body, status);
  const emit = (e: ResetEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* an observer must never break the flow it observes */
    }
  };

  async function body(request: Request): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = await request.json();
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  const isActive = (user: ResetUserRow) => user.status == null || activeStatuses.includes(user.status);

  return {
    preflight: (request) => preflightResponse(request, opts.allowOrigins, 'POST, OPTIONS'),

    async request(request) {
      const refused = crossSiteWrite(request, originAllowed);
      if (refused) return json(request, { error: refused.message }, refused.status);

      const { email } = (await body(request)) as { email?: unknown };
      if (typeof email !== 'string' || !email.trim()) return json(request, { error: 'Email is required' }, 400);
      const normalized = email.trim().toLowerCase();

      if (opts.rateLimit) {
        const ip = clientIp(request);
        const emailOk = opts.rateLimit(`reset:email:${normalized}`, perEmail, windowMs);
        const ipOk = ip ? opts.rateLimit(`reset:ip:${ip}`, perIp, windowMs) : true;
        if (!emailOk || !ipOk) return json(request, { error: 'Too many attempts. Try again later.' }, 429);
      }

      // The answer is the same whether or not the account exists. Only the
      // email differs, and it goes to the address that was typed, which
      // reveals nothing to the person typing.
      const user = await opts.findUserByEmail(normalized);
      const eligible = !!user && !!user.passwordHash && isActive(user);
      emit({ type: 'requested', email: normalized, eligible });
      if (user && eligible) {
        const token = opts.tokens.make({ id: user.id, password: user.passwordHash });
        void opts
          .sendMail({ to: user.email, user, resetUrl: opts.resetUrl(token), token })
          .then(() => emit({ type: 'sent', userId: user.id }))
          .catch((error: unknown) => emit({ type: 'send-failed', userId: user.id, error }));
      }
      return json(request, { ok: true });
    },

    async reset(request) {
      const refused = crossSiteWrite(request, originAllowed);
      if (refused) return json(request, { error: refused.message }, refused.status);

      const { token, password } = (await body(request)) as { token?: unknown; password?: unknown };
      if (typeof token !== 'string' || !token || typeof password !== 'string') return json(request, { error: 'Token and password are required' }, 400);
      if (password.length < minLength) {
        emit({ type: 'refused', reason: 'weak-password' });
        return json(request, { error: `Password must be at least ${minLength} characters` }, 400);
      }

      // One answer for every way a token can be wrong — malformed, unknown user,
      // bad signature, expired, already used — so the response does not say which.
      const invalid = () => {
        emit({ type: 'refused', reason: 'invalid-token' });
        return json(request, { error: 'This reset link is not valid. Request a new one.' }, 401);
      };
      const payload = opts.tokens.decode(token);
      if (!payload) return invalid();
      const user = await opts.findUserById(payload.u);
      if (!user || !opts.tokens.verify(token, { password: user.passwordHash })) return invalid();
      if (!isActive(user)) {
        // They proved they hold the link; "suspended" is the only answer that
        // lets them do anything about it, and reveals nothing they did not prove.
        emit({ type: 'refused', reason: 'inactive', userId: user.id });
        return json(request, { error: `This account is ${user.status}`, status: user.status }, 403);
      }

      await opts.setPasswordHash(user.id, await hashPassword(password));
      // The token died with the old hash. The sessions die here: a reset that
      // leaves an intruder's session alive has not reset anything.
      await opts.sessions.revokeAllForUser(user.id);
      emit({ type: 'reset', userId: user.id });
      return json(request, { ok: true });
    },
  };
}
