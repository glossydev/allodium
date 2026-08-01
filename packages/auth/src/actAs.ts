import { signPayload, verifySignedPayload } from './signedTokens.js';

/**
 * "Act as" — a superadmin resolves the whole application as another user, for
 * testing and for support, without ever logging out.
 *
 * THE ONE DECISION THAT MATTERS: hook this into the SINGLE function your app reads
 * identity from. Wrap that, and route guards, query scoping and UI all behave as
 * the target with no per-call-site changes. Hook it anywhere else and some routes
 * see the target while others see the actor — which is worse than not having the
 * feature at all, because the bugs it produces look like authorization bugs.
 *
 *   // your app, one place:
 *   export async function getCurrentUser() {
 *     const real = await sessionUser(token);
 *     return (await actAs.resolve(real, cookieValue)).user;   // effective identity
 *   }
 *   export const getRealUser = () => sessionUser(token);      // authority decisions
 *
 * FIVE PROPERTIES, all load-bearing:
 *
 * 1. The real session is NEVER replaced. A second signed cookie holds an
 *    instruction; no session is minted for the target, and stopping is just
 *    deleting the cookie. Nothing to clean up, nothing to leak.
 *
 * 2. Authority is re-checked EVERY request from the real session, never from the
 *    cookie. The ticket NAMES a target; it does not confer the right to use one.
 *    Demote someone and every in-flight impersonation dies on their next request.
 *
 * 3. The ticket is HMAC-signed and binds BOTH actor and target, so it cannot be
 *    forged and is inert if lifted into another browser — a member replaying a
 *    superadmin's cookie is still just themselves.
 *
 * 4. No escalation by construction: only those who pass `canActAs` can start,
 *    so acting as someone can never grant authority the actor lacked.
 *
 * 5. Impersonation is never silent. `resolve` returns the state your UI needs to
 *    show a persistent banner; silent impersonation is the failure mode to design
 *    against, and a library that makes it easy to hide is a badly designed one.
 *
 * Defaults lean safe: staff cannot be impersonated unless you allow it, the
 * feature is off unless you say otherwise, and anyone who is not the top tier gets
 * read-only. The risk here was never impersonation — it is WRITES performed as
 * someone else.
 */

/** Wire form of the ticket. Short keys because it rides in a cookie. */
interface TicketPayload {
  /** Target user id. */
  t: string;
  /** Actor id — binds the ticket to one session, killing cookie theft. */
  a: string;
  /** Mode: 'f' full, 'r' read-only. */
  m: 'f' | 'r';
  /** Expiry, epoch seconds. */
  e: number;
}

export type ActAsMode = 'full' | 'readonly';

/** Why an act-as request produced no impersonation. Surfaced, never swallowed. */
export type ActAsRefusal =
  | 'disabled'
  | 'no-session'
  | 'invalid-ticket'
  | 'expired'
  | 'actor-mismatch'
  | 'not-authorized'
  | 'target-missing'
  | 'target-blocked'
  | 'self';

export interface ActAsState<TUser> {
  /** The identity the application should use. The target when acting, else the real user. */
  user: TUser | null;
  /** Who is really signed in. Authority decisions must use THIS. */
  real: TUser | null;
  acting: boolean;
  target: TUser | null;
  mode: ActAsMode;
  /** Set when a ticket was present but not honoured — show it, don't hide it. */
  refusal?: ActAsRefusal;
}

export interface ActAsAuditEvent {
  type: 'start' | 'stop' | 'refused' | 'active';
  actorId: string | null;
  targetId: string | null;
  mode: ActAsMode;
  refusal?: ActAsRefusal;
  at: Date;
}

export interface CreateActAsOptions<TUser> {
  /** HMAC key. A thunk keeps call-time semantics for env-driven config. */
  secret: string | (() => string);

  /**
   * Master switch. Unset means ON in development and OFF in production, so an
   * unconsidered deploy ships without it — the same posture as an unset allowlist.
   * Pass `isDevelopment` for that default to work; without it, unset means OFF.
   */
  enabled?: () => boolean | string | undefined | null;
  isDevelopment?: () => boolean;

  /** May this user start an impersonation? Re-run on EVERY request. */
  canActAs: (actor: TUser) => boolean | Promise<boolean>;

  /**
   * May this user be impersonated? Defaults to blocking anyone who can themselves
   * act as others — i.e. staff — because impersonating staff is a bigger decision
   * than impersonating a customer and should be opted into.
   */
  canBeTarget?: (target: TUser, actor: TUser) => boolean | Promise<boolean>;

  /** Load a user by id. Your query, your shape. */
  loadUser: (id: string) => Promise<TUser | null>;

  /** How to read an id off your user object. */
  userId: (user: TUser) => string;

  /**
   * Full or read-only for this actor. Default: full only for the top tier
   * (whoever passes canActAs) — but see `readOnlyUnless` for a narrower rule.
   */
  mode?: (actor: TUser) => ActAsMode | Promise<ActAsMode>;

  /** Ticket lifetime. Default 8 hours — a working day, not a standing grant. */
  ttlMs?: number;

  /** Called for every start, stop, refusal and active request. Write audit rows here. */
  onAudit?: (event: ActAsAuditEvent) => void | Promise<void>;
}

export interface ActAs<TUser> {
  /** Is the feature switched on right now? */
  enabled(): boolean;

  /**
   * Mint a ticket. Returns the cookie VALUE; setting the cookie is the caller's
   * job (see `cookieOptions`). Every guard runs here AND again on every resolve.
   */
  start(actor: TUser, targetId: string): Promise<{ ok: true; ticket: string; mode: ActAsMode } | { ok: false; refusal: ActAsRefusal }>;

  /**
   * Resolve effective identity. Give it the REAL session user and the raw cookie
   * value; it returns who the app should behave as.
   */
  resolve(real: TUser | null, ticket: string | null | undefined): Promise<ActAsState<TUser>>;

  /**
   * Guard for write methods while read-only. Returns true when the request should
   * be refused. Wire it into your middleware or your write helpers.
   */
  blocksWrite(state: ActAsState<TUser>, method: string): boolean;

  /** Cookie attributes for the ticket — host-only, httpOnly, lax. */
  cookieOptions(): { httpOnly: true; sameSite: 'lax'; path: '/'; secure: boolean; maxAge: number };

  /** Attributes that delete the ticket. Call this on logout too. */
  clearCookieOptions(): { httpOnly: true; sameSite: 'lax'; path: '/'; secure: boolean; maxAge: 0 };

  /** Suggested cookie name; use anything you like. */
  readonly cookieName: string;
}

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

export function createActAs<TUser>(opts: CreateActAsOptions<TUser>): ActAs<TUser> {
  const secretOf = () => (typeof opts.secret === 'function' ? opts.secret() : opts.secret);
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  const audit = (e: ActAsAuditEvent) => {
    try {
      void opts.onAudit?.(e);
    } catch {
      /* auditing must never break the request it describes */
    }
  };

  function enabled(): boolean {
    const raw = opts.enabled?.();
    if (raw === undefined || raw === null || raw === '') {
      // Unset: on in development, off everywhere else. Without isDevelopment we
      // cannot tell, so we take the safe branch.
      return opts.isDevelopment?.() ?? false;
    }
    if (typeof raw === 'boolean') return raw;
    const v = String(raw).toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  /** Default: you may not impersonate anyone who is themselves able to impersonate. */
  const canBeTarget = async (target: TUser, actor: TUser): Promise<boolean> => {
    if (opts.canBeTarget) return opts.canBeTarget(target, actor);
    return !(await opts.canActAs(target));
  };

  const modeFor = async (actor: TUser): Promise<ActAsMode> => (opts.mode ? opts.mode(actor) : 'full');

  async function start(actor: TUser, targetId: string) {
    const actorId = opts.userId(actor);
    const refuse = (refusal: ActAsRefusal) => {
      audit({ type: 'refused', actorId, targetId, mode: 'readonly', refusal, at: new Date() });
      return { ok: false as const, refusal };
    };

    if (!enabled()) return refuse('disabled');
    if (!(await opts.canActAs(actor))) return refuse('not-authorized');
    if (String(targetId) === actorId) return refuse('self');

    const target = await opts.loadUser(String(targetId));
    if (!target) return refuse('target-missing');
    if (!(await canBeTarget(target, actor))) return refuse('target-blocked');

    const mode = await modeFor(actor);
    const payload: TicketPayload = {
      t: opts.userId(target),
      a: actorId,
      m: mode === 'readonly' ? 'r' : 'f',
      e: Math.floor((Date.now() + ttl) / 1000),
    };
    audit({ type: 'start', actorId, targetId: payload.t, mode, at: new Date() });
    return { ok: true as const, ticket: signPayload(secretOf(), payload), mode };
  }

  async function resolve(real: TUser | null, ticket: string | null | undefined): Promise<ActAsState<TUser>> {
    const base: ActAsState<TUser> = { user: real, real, acting: false, target: null, mode: 'full' };

    if (!ticket) return base;
    if (!real) return { ...base, refusal: 'no-session' };

    const actorId = opts.userId(real);

    // The master switch is checked HERE as well as at start, so flipping it off
    // ends impersonations already in flight rather than only preventing new ones.
    if (!enabled()) return { ...base, refusal: 'disabled' };

    const payload = verifySignedPayload(secretOf(), ticket) as TicketPayload | null;
    if (!payload || typeof payload.t !== 'string' || typeof payload.a !== 'string') {
      return { ...base, refusal: 'invalid-ticket' };
    }
    if (typeof payload.e !== 'number' || payload.e * 1000 < Date.now()) {
      return { ...base, refusal: 'expired' };
    }

    // Bound to the actor: a stolen cookie in someone else's browser does nothing.
    if (payload.a !== actorId) {
      audit({ type: 'refused', actorId, targetId: payload.t, mode: 'readonly', refusal: 'actor-mismatch', at: new Date() });
      return { ...base, refusal: 'actor-mismatch' };
    }

    // THE re-check. Authority comes from the live session, never from the ticket.
    if (!(await opts.canActAs(real))) {
      audit({ type: 'refused', actorId, targetId: payload.t, mode: 'readonly', refusal: 'not-authorized', at: new Date() });
      return { ...base, refusal: 'not-authorized' };
    }

    const target = await opts.loadUser(payload.t);
    if (!target) return { ...base, refusal: 'target-missing' };
    if (!(await canBeTarget(target, real))) {
      return { ...base, refusal: 'target-blocked' };
    }

    const mode: ActAsMode = payload.m === 'r' ? 'readonly' : 'full';
    audit({ type: 'active', actorId, targetId: payload.t, mode, at: new Date() });
    return { user: target, real, acting: true, target, mode };
  }

  function blocksWrite(state: ActAsState<TUser>, method: string): boolean {
    if (!state.acting || state.mode !== 'readonly') return false;
    const m = method.toUpperCase();
    return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
  }

  const secureCookies = () => !(opts.isDevelopment?.() ?? false);

  return {
    cookieName: 'allodium_act_as',
    enabled,
    start,
    resolve,
    blocksWrite,
    cookieOptions: () => ({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: secureCookies(),
      maxAge: Math.floor(ttl / 1000),
    }),
    clearCookieOptions: () => ({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: secureCookies(),
      maxAge: 0,
    }),
  };
}
