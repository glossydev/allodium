import { createAccessPolicy, type AccessPolicy, type Actor, type Grant, type GrantPredicate } from './access.js';

/**
 * Reading grants out of a database, and building the actor a request runs as.
 *
 * Separate from the gate itself because the gate must stay pure: rules you can
 * read back without standing up Postgres. This half is the opinionated one — it
 * assumes the roles / user_roles / role_permissions shape Allodium's own seed
 * defines. Every table name is an option, and an application with a different
 * schema can skip this file entirely and hand `createAccessPolicy` its own
 * grants; the gate does not care where they came from.
 *
 * Grants are cached, because otherwise every request pays three queries to learn
 * a matrix that changes when somebody edits it in the console — which is rare
 * and, when it happens, is a `refresh()` away.
 */

/** Anything pg-shaped: a Pool, a Client, a proxy. Same duck as the admin runtime's. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface GrantLoaderOptions {
  /** Table holding role keys. Default "roles", keyed by "key". */
  rolesTable?: string;
  /** Table holding the matrix. Default "role_permissions". */
  grantsTable?: string;
  /** Join table of users to roles. Default "user_roles". */
  userRolesTable?: string;
  /** Roles that bypass the model. Passed straight to the policy. */
  superuserRoles?: string[];
  /** How long a loaded matrix stays good. Default 30s. */
  ttlMs?: number;
}

export interface GrantLoader {
  /** The matrix, cached. */
  grants(): Promise<Grant[]>;
  /** A policy over the current matrix. */
  policy(): Promise<AccessPolicy>;
  /** Role keys a user holds. Empty for an unknown user — which denies, it does not throw. */
  rolesFor(userId: string): Promise<string[]>;
  /**
   * The actor for a signed-in user. `claims` are the app's to supply: which
   * column identifies "this person's rows" is domain knowledge — a customer id
   * here, a chapter id in ChapterHub — and a library that guessed would be wrong
   * in a way nobody notices until it leaks.
   */
  actorFor(userId: string, claims?: Record<string, unknown>): Promise<Actor>;
  /** Drop the cache — call after editing the matrix. */
  refresh(): void;
}

const ident = (n: string) => '"' + n.replaceAll('"', '""') + '"';

/**
 * row_filter arrives as jsonb. Null or an empty array means every row; anything
 * else must be an array of predicates that each name a column.
 *
 * A filter that cannot be read FAILS CLOSED: the whole grant is refused, not
 * widened. The alternative — keep the grant and drop the filter — turns "the
 * public may read published posts" into "the public may read every post" the
 * moment somebody saves `{}` instead of `[]`, with nothing but a log line to say
 * so. That is the failure mode row-level rules exist to prevent, and it is not
 * one a warning is allowed to stand in for.
 */
function parseFilter(raw: unknown, where: string, problems: string[]): { ok: true; filter?: GrantPredicate[] } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true };
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!Array.isArray(value)) {
    problems.push(`${where}: row_filter is not an array of predicates — this grant is REFUSED until it is fixed.`);
    return { ok: false };
  }
  const out: GrantPredicate[] = [];
  for (const p of value) {
    if (!p || typeof p !== 'object' || typeof (p as GrantPredicate).column !== 'string' || !(p as GrantPredicate).column.trim()) {
      problems.push(`${where}: a row_filter entry has no "column" — this grant is REFUSED until it is fixed.`);
      return { ok: false };
    }
    out.push(p as GrantPredicate);
  }
  return out.length ? { ok: true, filter: out } : { ok: true };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function createGrantLoader(db: Queryable, opts: GrantLoaderOptions = {}): GrantLoader {
  const rolesTable = opts.rolesTable ?? 'roles';
  const grantsTable = opts.grantsTable ?? 'role_permissions';
  const userRolesTable = opts.userRolesTable ?? 'user_roles';
  const ttl = opts.ttlMs ?? 30_000;

  let cache: { at: number; grants: Grant[]; problems: string[] } | null = null;

  async function load(): Promise<{ grants: Grant[]; problems: string[] }> {
    if (cache && Date.now() - cache.at < ttl) return cache;
    const res = await db.query(
      `select r.key as role, g.table_name, g.can_create, g.can_read, g.can_update, g.can_delete,
              ${/* row_filter is newer than the table; tolerate its absence */ ''}
              to_jsonb(g) -> 'row_filter' as row_filter
         from ${ident(grantsTable)} g
         join ${ident(rolesTable)} r on r.id = g.role_id
        order by r.key, g.table_name`
    );
    const problems: string[] = [];
    const grants: Grant[] = [];
    for (const row of res.rows as Record<string, unknown>[]) {
      const parsed = parseFilter(row.row_filter, `${row.role} on ${row.table_name}`, problems);
      // A grant whose filter cannot be honoured is not loaded at all. With no
      // grant, the policy denies — the same answer as if the row did not exist,
      // which is the only safe reading of a row that cannot be understood.
      if (!parsed.ok) continue;
      grants.push({
        role: String(row.role),
        table: String(row.table_name),
        create: !!row.can_create,
        read: !!row.can_read,
        update: !!row.can_update,
        delete: !!row.can_delete,
        ...(parsed.filter ? { rowFilter: parsed.filter } : {}),
      });
    }
    cache = { at: Date.now(), grants, problems };
    return cache;
  }

  return {
    async grants() {
      return (await load()).grants;
    },
    async policy() {
      const { grants, problems } = await load();
      const policy = createAccessPolicy(grants, { superuserRoles: opts.superuserRoles });
      // Loading problems and configuration problems are the same kind of thing to
      // whoever has to fix them, so they arrive in one list.
      return { ...policy, problems: [...problems, ...policy.problems] };
    },
    async rolesFor(userId) {
      const res = await db.query(
        `select r.key from ${ident(userRolesTable)} ur join ${ident(rolesTable)} r on r.id = ur.role_id where ur.user_id = $1`,
        [userId]
      );
      return (res.rows as { key: string }[]).map((r) => r.key);
    },
    async actorFor(userId, claims = {}) {
      return { userId, roles: await this.rolesFor(userId), claims };
    },
    refresh() {
      cache = null;
    },
  };
}
