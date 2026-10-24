import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './grants.js';

/**
 * API tokens — how a machine caller becomes an actor.
 *
 * Sessions are for browsers. A job runner, another service, an agent's MCP, a
 * deploy script: none of them has a cookie jar, and the usual answer is one
 * shared secret in an environment variable compared with `!==`, which is a
 * credential nobody can rotate, scope, revoke or attribute. This is the
 * alternative: a row per token, the SECRET STORED AS A DIGEST and shown exactly
 * once at minting, a label that says what holds it, an expiry, a revocation,
 * and a `last_used_at` that says whether it is still in use.
 *
 * A token resolves to an IDENTITY — a user, or a set of roles on its own — and
 * the application turns that into an actor exactly as it does for a session:
 * roles from the token when it carries them, otherwise the user's own through
 * the grant loader; claims from wherever the app gets them. The grant model
 * then treats the caller like anyone else. A service token has no user, so a
 * grant on "your own rows" ($actor.userId) denies it, which is the right
 * answer: a service has no own rows.
 *
 * Tokens carry a recognisable prefix so a leaked one can be found by a secret
 * scanner and so a resolve can refuse a non-token without touching the
 * database. The lookup is by SHA-256 digest, so the database compares digests
 * of 32 random bytes, and nothing about equality timing says anything useful
 * about the token.
 *
 * Required table (see dev/seed/008-api-tokens.sql for the DDL):
 *   id uuid, label, token_hash char(64) unique, user_id uuid null,
 *   roles text[], created_at, expires_at null, last_used_at null, revoked_at null
 */

export interface ApiTokenIdentity {
  id: string;
  label: string;
  /** The user this token acts as, or null for a service token that acts as its roles alone. */
  userId: string | null;
  /** Role keys the token carries. Empty means "the user's own roles" — resolve those through the grant loader. */
  roles: string[];
}

export interface ApiTokenRow extends ApiTokenIdentity {
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenStoreOptions {
  /** Default "api_tokens". */
  table?: string;
  /** Column names, when they differ from the seed's. */
  columns?: Partial<Record<'id' | 'label' | 'tokenHash' | 'userId' | 'roles' | 'createdAt' | 'expiresAt' | 'lastUsedAt' | 'revokedAt', string>>;
  /** What every token starts with. Default "ak_". Pick one unique to your app so a leak is attributable. */
  prefix?: string;
  /** How often a token's last_used_at is written. Default 60 s: a token used in a tight loop must not write on every call. */
  touchEveryMs?: number;
}

export interface ApiTokenStore {
  /** Does this look like one of our tokens? Prefix only; no database. */
  isToken(value: unknown): boolean;
  /**
   * Create a token. The returned `token` is the only time the secret exists in
   * plaintext — show it once, store nothing but the digest.
   */
  mint(args: { label: string; userId?: string | null; roles?: string[]; expiresAt?: Date | string | null }): Promise<{ id: string; token: string }>;
  /**
   * The identity behind a bearer token, or null. Takes a Request (reads
   * `Authorization: Bearer …`) or the token itself. Null for a missing header,
   * a wrong prefix, an unknown, expired or revoked token — all the same answer,
   * so the response cannot say which.
   */
  resolve(from: Request | string): Promise<ApiTokenIdentity | null>;
  /** Revoke by id. True if a live token was revoked. */
  revoke(id: string): Promise<boolean>;
  /** Tokens, newest first. Never the digest. */
  list(opts?: { userId?: string | null; includeRevoked?: boolean }): Promise<ApiTokenRow[]>;
}

const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex');
const ident = (n: string) => '"' + n.replaceAll('"', '""') + '"';

export function createApiTokens(db: Queryable, opts: ApiTokenStoreOptions = {}): ApiTokenStore {
  const table = ident(opts.table ?? 'api_tokens');
  const prefix = opts.prefix ?? 'ak_';
  const touchEveryMs = opts.touchEveryMs ?? 60_000;
  const c = {
    id: 'id',
    label: 'label',
    tokenHash: 'token_hash',
    userId: 'user_id',
    roles: 'roles',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
    lastUsedAt: 'last_used_at',
    revokedAt: 'revoked_at',
    ...(opts.columns ?? {}),
  };
  const col = (k: keyof typeof c) => ident(c[k]);
  const touched = new Map<string, number>();

  const isToken = (value: unknown): boolean => typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length + 16;

  const bearer = (request: Request): string | null => {
    const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
    return m ? m[1] : null;
  };

  const toRow = (r: Record<string, unknown>): ApiTokenRow => ({
    id: String(r[c.id]),
    label: String(r[c.label]),
    userId: r[c.userId] === null || r[c.userId] === undefined ? null : String(r[c.userId]),
    roles: Array.isArray(r[c.roles]) ? (r[c.roles] as unknown[]).map(String) : [],
    createdAt: String(r[c.createdAt]),
    expiresAt: r[c.expiresAt] === null || r[c.expiresAt] === undefined ? null : String(r[c.expiresAt]),
    lastUsedAt: r[c.lastUsedAt] === null || r[c.lastUsedAt] === undefined ? null : String(r[c.lastUsedAt]),
    revokedAt: r[c.revokedAt] === null || r[c.revokedAt] === undefined ? null : String(r[c.revokedAt]),
  });
  const columnsSansDigest = (['id', 'label', 'userId', 'roles', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt'] as const).map(col).join(', ');

  return {
    isToken,

    async mint(args) {
      const token = prefix + randomBytes(32).toString('base64url');
      const expires = args.expiresAt instanceof Date ? args.expiresAt.toISOString() : (args.expiresAt ?? null);
      const res = await db.query(
        `insert into ${table} (${col('label')}, ${col('tokenHash')}, ${col('userId')}, ${col('roles')}, ${col('expiresAt')}) values ($1, $2, $3, $4, $5) returning ${col('id')} as id`,
        [args.label, sha256(token), args.userId ?? null, args.roles ?? [], expires]
      );
      return { id: String((res.rows[0] as { id: unknown }).id), token };
    },

    async resolve(from) {
      const token = typeof from === 'string' ? from : bearer(from);
      if (!isToken(token)) return null;
      const res = await db.query(
        `select ${columnsSansDigest} from ${table}
          where ${col('tokenHash')} = $1 and ${col('revokedAt')} is null and (${col('expiresAt')} is null or ${col('expiresAt')} > now()) limit 1`,
        [sha256(token as string)]
      );
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const found = toRow(row);
      const last = touched.get(found.id) ?? 0;
      if (Date.now() - last > touchEveryMs) {
        touched.set(found.id, Date.now());
        // Bookkeeping must never fail the request it describes.
        await db.query(`update ${table} set ${col('lastUsedAt')} = now() where ${col('id')} = $1`, [found.id]).catch(() => {});
      }
      return { id: found.id, label: found.label, userId: found.userId, roles: found.roles };
    },

    async revoke(id) {
      const res = await db.query(`update ${table} set ${col('revokedAt')} = now() where ${col('id')} = $1 and ${col('revokedAt')} is null`, [id]);
      touched.delete(id);
      return (res.rowCount ?? 0) > 0;
    },

    async list(o = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (o.userId !== undefined) {
        if (o.userId === null) where.push(`${col('userId')} is null`);
        else where.push(`${col('userId')} = $${params.push(o.userId)}`);
      }
      if (!o.includeRevoked) where.push(`${col('revokedAt')} is null`);
      const res = await db.query(
        `select ${columnsSansDigest} from ${table}${where.length ? ' where ' + where.join(' and ') : ''} order by ${col('createdAt')} desc`,
        params
      );
      return (res.rows as Record<string, unknown>[]).map(toRow);
    },
  };
}
