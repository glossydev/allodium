/**
 * Who is asking, and what they may see.
 *
 * Authentication answers "who are you"; this answers "what does that let you
 * touch". It lives beside the session store because both are about the principal,
 * and because the content API and the admin API have to gate identically — one
 * enforcement path, not two implementations that drift.
 *
 * Pure and synchronous on purpose: grants in, decision out. Loading grants is a
 * database question and lives in `createGrantLoader`; enforcing a decision is a
 * SQL question and lives in the resolver. Keeping the DECISION free of both is
 * what makes the rules testable by reading them back, which matters more here
 * than anywhere else in this codebase — a permission bug is silent and expensive.
 */

export type Action = 'create' | 'read' | 'update' | 'delete';

export const ACTIONS: readonly Action[] = ['create', 'read', 'update', 'delete'];

/**
 * A predicate restricting which ROWS a grant covers.
 *
 * Structurally identical to `@allodium/admin`'s `Predicate`, and deliberately so:
 * a grant's row filter is handed straight to the resolver's scope channel with no
 * translation step. It is redeclared rather than imported because auth must not
 * depend on admin — the content API needs this gate without the admin runtime.
 * The two shapes have to stay compatible; that is a guard worth writing when the
 * resolver is wired, not a comment worth trusting.
 *
 * `value` may reference the actor: `"$actor.customerId"` resolves from the
 * actor's claims at decision time.
 */
export interface GrantPredicate {
  column: string;
  op?: string;
  value?: unknown;
}

/** One role's permission on one table. */
export interface Grant {
  role: string;
  table: string;
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
  /**
   * Rows this grant covers. Absent or empty means every row.
   *
   * This is the half a table×action matrix cannot express — "a member sees their
   * own orders" is a grant on `orders` restricted to `customer_id = $actor.customerId`.
   */
  rowFilter?: GrantPredicate[];
}

/**
 * The principal a request runs as.
 *
 * `roles` is a SET, not a role: `users` is one table for staff and customers, and
 * the seed's own comment says a person may hold several at once (staff who also
 * shop). Grants therefore UNION across roles rather than resolving to one.
 */
export interface Actor {
  /** Null for anonymous — which is a real actor with real grants, not an absence. */
  userId: string | null;
  /** Role keys held. */
  roles: string[];
  /**
   * Values a granted row filter may reference. `$actor.customerId` reads
   * `claims.customerId`. The app supplies these: which column identifies "this
   * person's rows" is domain knowledge, not something a library can infer.
   */
  claims: Record<string, unknown>;
}

export const PUBLIC_ROLE = 'public';

/** Anonymous. Carries the public role, so unauthenticated access is granted, never assumed. */
export const PUBLIC_ACTOR: Actor = Object.freeze({ userId: null, roles: [PUBLIC_ROLE], claims: {} });

export interface AccessDecision {
  allowed: boolean;
  /**
   * The rows the decision covers, as a disjunction of conjunctions: a row is
   * inside the decision when EVERY predicate of ANY one group holds. Each group
   * is one role's row filter with the actor's claims substituted; a person who
   * holds two restricted roles may touch the union of what each allows, because
   * holding a second role can never take access away.
   *
   * `[[]]` — a single empty group — is unrestricted, which is only ever the
   * result of an unrestricted grant, never of a missing one. A refusal carries
   * `[]`: zero groups cover zero rows.
   */
  scopes: GrantPredicate[][];
  /**
   * The single group, for callers written when a decision could carry only one:
   * predicates to AND into the query, empty meaning unrestricted.
   *
   * When the decision is a disjunction of SEVERAL groups there is no single
   * conjunction to hand back, and reading this throws. Returning one group would
   * be narrower than granted and wrong for whoever holds the other role;
   * returning none would be wider than granted, which is the failure that makes
   * row-level rules worse than none. A caller that may meet a multi-role actor
   * reads `scopes`.
   */
  scope: GrantPredicate[];
  /** Why, in words. Goes in logs and refusal bodies; a denial should never be a mystery. */
  reason: string;
}

export interface AccessPolicyOptions {
  /**
   * Roles that bypass the grant model entirely. Named rather than hardcoded, but
   * defaulted, because a deployment that forgets to configure this should still
   * have a working super_admin rather than a silently locked-out one.
   *
   * A superuser role holds ZERO grant rows deliberately: grants on it would be
   * misleading, since it never consults them. That makes "no rows found" and "not
   * permitted" the same shape in the data and completely different in meaning —
   * so they must never share a code path.
   */
  superuserRoles?: string[];
}

export interface AccessPolicy {
  /** May this actor do this to this table, and over which rows? */
  can(actor: Actor, table: string, action: Action): AccessDecision;
  /** Every grant that applies to an actor, for debugging and for the console to show. */
  grantsFor(actor: Actor): Grant[];
  /** Configuration this policy cannot honour — surfaced, never silently ignored. */
  problems: string[];
}

/** Resolve `$actor.x` references against the actor's claims. */
function substitute(
  predicates: GrantPredicate[],
  actor: Actor
): { ok: true; scope: GrantPredicate[] } | { ok: false; missing: string } {
  const out: GrantPredicate[] = [];
  for (const p of predicates) {
    if (typeof p.value !== 'string' || !p.value.startsWith('$actor.')) {
      out.push(p);
      continue;
    }
    const claim = p.value.slice('$actor.'.length);
    const value = claim === 'userId' ? actor.userId : actor.claims[claim];
    // A claim the actor does not carry must DENY, never widen. Dropping the
    // predicate would turn "your own orders" into "all orders" — the failure
    // mode that makes row-level rules worse than none.
    if (value === undefined || value === null) return { ok: false, missing: claim };
    out.push({ ...p, value });
  }
  return { ok: true, scope: out };
}

const sameFilter = (a: GrantPredicate[] | undefined, b: GrantPredicate[] | undefined) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** The one unrestricted shape: a single group with nothing in it. */
const EVERY_ROW: GrantPredicate[][] = [[]];

/**
 * Build a decision whose `scope` agrees with its `scopes`. With one group (or
 * none, for a refusal) `scope` is a plain property. With several it is a getter
 * that throws — see the field's doc for why neither "pick one" nor "pick none"
 * is acceptable. Non-enumerable in that case so a decision still serialises
 * for a log line; `scopes` carries the answer.
 */
function decide(allowed: boolean, scopes: GrantPredicate[][], reason: string): AccessDecision {
  if (scopes.length <= 1) return { allowed, scopes, scope: scopes[0] ?? [], reason };
  const d = { allowed, scopes, reason } as AccessDecision;
  Object.defineProperty(d, 'scope', {
    enumerable: false,
    get(): GrantPredicate[] {
      throw new Error(
        `this decision covers ${scopes.length} alternative row scopes (${reason}); no single scope can stand for them — read decision.scopes`
      );
    },
  });
  return d;
}

export function createAccessPolicy(grants: Grant[], opts: AccessPolicyOptions = {}): AccessPolicy {
  const superuserRoles = opts.superuserRoles ?? ['super_admin'];
  const problems: string[] = [];

  for (const g of grants) {
    if (superuserRoles.includes(g.role)) {
      problems.push(
        `"${g.role}" is a superuser role and bypasses the grant model, but a grant on ${g.table} exists for it — it has no effect and reads as if it did.`
      );
    }
  }

  const grantsFor = (actor: Actor) => grants.filter((g) => actor.roles.includes(g.role));

  return {
    problems,
    grantsFor,
    can(actor, table, action) {
      const superRole = actor.roles.find((r) => superuserRoles.includes(r));
      if (superRole) {
        // Explicit branch, deliberately before any grant lookup: a superuser is
        // allowed BECAUSE of the role, not because a search happened to find
        // something. Sharing the "found grants" path would mean a query bug that
        // returns nothing reads as "permitted" for exactly the wrong account.
        return decide(true, EVERY_ROW, `role "${superRole}" bypasses the permission model`);
      }

      const applicable = grants.filter((g) => actor.roles.includes(g.role) && g.table === table && g[action]);
      if (!applicable.length) {
        const held = actor.roles.length ? actor.roles.join(', ') : 'no roles';
        return decide(false, [], `no grant for ${action} on ${table} (holding: ${held})`);
      }

      // The most permissive grant wins: holding two roles cannot leave you with
      // less than either alone. One unrestricted grant therefore ends it.
      const unrestricted = applicable.find((g) => !g.rowFilter?.length);
      if (unrestricted) {
        return decide(true, EVERY_ROW, `"${unrestricted.role}" may ${action} all of ${table}`);
      }

      // Every applicable grant is row-restricted. Their union is an OR: one
      // group per distinct filter, and a row inside ANY group is inside the
      // decision. Two roles with the same filter are one group, not two.
      const distinct = applicable.filter(
        (g, i) => applicable.findIndex((o) => sameFilter(o.rowFilter, g.rowFilter)) === i
      );

      const scopes: GrantPredicate[][] = [];
      const granted: string[] = [];
      const unsatisfied: string[] = [];
      for (const g of distinct) {
        // "Its own rows" only if the filter actually references the actor. A grant
        // restricted to published posts is not ownership, and a reason string that
        // says it is will mislead whoever reads it in a log at 2am.
        const owned = g.rowFilter!.some((p) => typeof p.value === 'string' && p.value.startsWith('$actor.'));
        const which = owned ? 'its own rows of' : 'some rows of';
        const sub = substitute(g.rowFilter!, actor);
        if (!sub.ok) {
          // A group whose claim this actor lacks covers no rows OF THIS ACTOR'S,
          // so it is left out of the union. That only ever narrows: the other
          // groups stand on their own, and if there are none the actor is refused
          // — never widened to every row, which dropping the predicate would do.
          unsatisfied.push(`"${g.role}" may ${action} only ${which} ${table}, but this actor carries no "${sub.missing}" claim`);
          continue;
        }
        scopes.push(sub.scope);
        granted.push(`"${g.role}" may ${action} ${which} ${table}`);
      }

      if (!scopes.length) return decide(false, [], unsatisfied.join('; '));
      const reason = scopes.length === 1
        ? granted[0]
        : `${granted.join(', or ')} — a row inside either is permitted`;
      return decide(true, scopes, unsatisfied.length ? `${reason} (${unsatisfied.join('; ')})` : reason);
    },
  };
}
