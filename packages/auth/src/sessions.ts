import { createHash, randomBytes } from 'node:crypto';
import { and, eq, getTableColumns, gt, lt, ne, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * First-party session store: short-lived access token + single-use rotating refresh
 * token, both opaque (prefix + 32 random bytes base64url). Tokens live only in httpOnly
 * cookies; the database stores sha256 hex digests. The prefixes are how middleware and
 * read paths recognize these tokens without any flag column — pick ones unique to your
 * app (they also namespace tokens during a migration's parallel-run).
 *
 * Required `sessions` table shape (drizzle property names, string-mode timestamptz):
 *   id, userId, accessHash (char 64), refreshHash (char 64), accessExpiresAt,
 *   refreshExpiresAt, lastUsedAt, ip (varchar 64), userAgent (varchar 255),
 *   origin (varchar) — with UNIQUE indexes on both hash columns.
 * Required `users` table shape: an `id` property the sessions.userId FK points at.
 */

export interface MintedSession {
  accessToken: string;
  refreshToken: string;
  /** Access-token TTL in ms — the `expires` value auth endpoints put on the wire. */
  expires: number;
}

/** Origin scoping for resolveUser — see the note on cross-surface token isolation. */
export type OriginScope = { equals: string } | { not: string };

export interface SessionStore {
  accessTtlMs: number;
  refreshTtlMs: number;
  /**
   * Plain booleans on purpose (not type predicates): a predicate would narrow
   * `string | undefined` to `never` in callers' else-branches (legacy token paths).
   */
  isAccessToken(t: unknown): boolean;
  isRefreshToken(t: unknown): boolean;
  /**
   * Create a session for a user. Caller has already authenticated them. ttlMs overrides
   * the access TTL for fixed-length sessions with no refresh cycle (admin surfaces);
   * the returned `expires` is always the store's standard TTL, matching what refresh
   * endpoints advertise.
   */
  mint(args: {
    userId: string;
    origin: string;
    ip?: string | null;
    userAgent?: string | null;
    ttlMs?: number;
  }): Promise<MintedSession>;
  /**
   * Single-use refresh rotation. Atomic: the UPDATE's WHERE consumes the old refresh
   * hash, so of two concurrent refreshes with the same token exactly one wins (the loser
   * gets null → 401 → single-flight middleware forgiveness keeps the winner's cookies).
   * Sliding window: each rotation extends the refresh expiry by refreshTtlMs.
   *
   * Refuses — null, nothing issued — when the session's user no longer passes
   * `isUserActive`, or when `origin` is given and the session belongs to another
   * surface. A suspended account must not be able to keep its session alive by
   * refreshing, and a refresh cookie lifted from one surface must not rotate at
   * another; both were holes that resolveUser closed and rotate left open.
   */
  rotate(refreshToken: string, opts?: { origin?: OriginScope }): Promise<MintedSession | null>;
  /**
   * Resolve an access token to its raw user row (drizzle camelCase properties — map to
   * your wire shape and strip credential columns in YOUR binding). Null on unknown or
   * expired token, or when isUserActive rejects the row.
   *
   * Origin scoping is real security logic when two surfaces share the store (an app and
   * an admin console): scope each surface so a cookie value manually moved across
   * origins resolves to nothing.
   */
  resolveUser(accessToken: string, opts?: { origin?: OriginScope }): Promise<Record<string, unknown> | null>;
  /**
   * Logout: revoke by EVERY token the cookie jar holds, not the first one that
   * looks right. After a rotation in another tab the access cookie here is stale
   * and matches nothing, while the refresh cookie may still be live — revoking by
   * the access token alone then deletes nothing and the session survives logout.
   *
   * Throws when the database refuses. Swallowing that would let the caller clear
   * the cookies over a session that still exists, which is a person believing
   * they are signed out when they are not.
   */
  revoke(tokens: { accessToken?: string; refreshToken?: string }): Promise<void>;
  /** Revoke all of a user's sessions (password reset), optionally sparing one access token. */
  revokeAllForUser(userId: string, opts?: { exceptAccessToken?: string }): Promise<void>;
}

const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex');

/* The drizzle call sites cast through `any`: typing a caller-supplied table pair
 * generically against drizzle's builder generics costs far more than it buys at this
 * layer, and the column-property contract is documented above. */
export function createSessionStore(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  sessions: PgTable;
  users: PgTable;
  accessPrefix: string;
  refreshPrefix: string;
  accessTtlMs?: number;
  refreshTtlMs?: number;
  /** Gate on the joined user row (e.g. status === 'active'). Default: allow all. */
  isUserActive?: (row: Record<string, unknown>) => boolean;
  /** Rotation lazily deletes sessions dead longer than this. Default 24 h. */
  sweepGraceMs?: number;
}): SessionStore {
  const {
    db,
    accessPrefix,
    refreshPrefix,
    accessTtlMs = 15 * 60_000,
    refreshTtlMs = 7 * 24 * 3_600_000,
    isUserActive = () => true,
    sweepGraceMs = 24 * 3_600_000,
  } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions = opts.sessions as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users = opts.users as any;

  const isAccessToken = (t: unknown): boolean => typeof t === 'string' && t.startsWith(accessPrefix);
  const isRefreshToken = (t: unknown): boolean => typeof t === 'string' && t.startsWith(refreshPrefix);
  const newToken = (prefix: string): string => prefix + randomBytes(32).toString('base64url');
  /** The surface restriction as WHERE conditions — none when unscoped. Shared by every read of a session. */
  const originClause = (scope: OriginScope | undefined) =>
    scope === undefined ? [] : 'equals' in scope ? [eq(sessions.origin, scope.equals)] : [ne(sessions.origin, scope.not)];

  return {
    accessTtlMs,
    refreshTtlMs,
    isAccessToken,
    isRefreshToken,

    async mint(args) {
      const accessToken = newToken(accessPrefix);
      const refreshToken = newToken(refreshPrefix);
      const now = Date.now();
      await db.insert(sessions).values({
        userId: args.userId,
        accessHash: sha256(accessToken),
        refreshHash: sha256(refreshToken),
        accessExpiresAt: new Date(now + (args.ttlMs ?? accessTtlMs)).toISOString(),
        refreshExpiresAt: new Date(now + refreshTtlMs).toISOString(),
        ip: args.ip ? args.ip.slice(0, 64) : null,
        userAgent: args.userAgent ? args.userAgent.slice(0, 255) : null,
        origin: args.origin,
      });
      return { accessToken, refreshToken, expires: accessTtlMs };
    },

    async rotate(refreshToken, callOpts = {}) {
      if (!isRefreshToken(refreshToken)) return null;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const hash = sha256(refreshToken);
      const live = [eq(sessions.refreshHash, hash), gt(sessions.refreshExpiresAt, nowIso), ...originClause(callOpts.origin)];

      // Whose session this is, checked BEFORE anything is issued. isUserActive is
      // the caller's predicate over the user row, so it cannot go in the WHERE;
      // the single-use guarantee is unaffected, because the UPDATE below still
      // consumes the hash atomically.
      const found = await db
        .select({ u: getTableColumns(users) })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(...live))
        .limit(1);
      const u = found[0]?.u as Record<string, unknown> | undefined;
      if (!u || !isUserActive(u)) return null;

      const accessToken = newToken(accessPrefix);
      const nextRefreshToken = newToken(refreshPrefix);
      const rotated = await db
        .update(sessions)
        .set({
          accessHash: sha256(accessToken),
          refreshHash: sha256(nextRefreshToken),
          accessExpiresAt: new Date(now + accessTtlMs).toISOString(),
          refreshExpiresAt: new Date(now + refreshTtlMs).toISOString(),
          lastUsedAt: nowIso,
        })
        .where(and(...live))
        .returning({ id: sessions.id });
      if (!rotated.length) return null;

      // Lazy sweep: drop long-dead sessions on the way through.
      try {
        await db.delete(sessions).where(lt(sessions.refreshExpiresAt, new Date(now - sweepGraceMs).toISOString()));
      } catch {
        /* housekeeping only */
      }

      return { accessToken, refreshToken: nextRefreshToken, expires: accessTtlMs };
    },

    async resolveUser(accessToken, callOpts = {}) {
      if (!isAccessToken(accessToken)) return null;
      const rows = await db
        .select({ u: getTableColumns(users) })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(
            eq(sessions.accessHash, sha256(accessToken)),
            gt(sessions.accessExpiresAt, new Date().toISOString()),
            ...originClause(callOpts.origin)
          )
        )
        .limit(1);
      const u = rows[0]?.u as Record<string, unknown> | undefined;
      if (!u || !isUserActive(u)) return null;
      return u;
    },

    async revoke(tokens) {
      const byEither = [];
      if (tokens.accessToken && isAccessToken(tokens.accessToken)) byEither.push(eq(sessions.accessHash, sha256(tokens.accessToken)));
      if (tokens.refreshToken && isRefreshToken(tokens.refreshToken)) byEither.push(eq(sessions.refreshHash, sha256(tokens.refreshToken)));
      if (!byEither.length) return;
      await db.delete(sessions).where(byEither.length === 1 ? byEither[0] : or(...byEither));
    },

    async revokeAllForUser(userId, callOpts = {}) {
      const except =
        callOpts.exceptAccessToken && isAccessToken(callOpts.exceptAccessToken)
          ? sha256(callOpts.exceptAccessToken)
          : null;
      await db
        .delete(sessions)
        .where(except ? and(eq(sessions.userId, userId), ne(sessions.accessHash, except)) : eq(sessions.userId, userId));
    },
  };
}
