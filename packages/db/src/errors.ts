/**
 * Postgres error classification at the app boundary.
 */

/**
 * True when `err` — or anything in its `cause` chain — is a Postgres
 * unique-constraint violation (SQLSTATE 23505), optionally narrowed to one named
 * constraint. Walking `cause` matters: Drizzle (and most query layers) wrap the
 * driver's DatabaseError, so a naive `err.code` check misses every real hit.
 * Use it to turn racy check-then-insert flows into a single INSERT with a
 * friendly duplicate message.
 *
 * Note: constraint names survive table RENAMEs in Postgres — after a migration the
 * name may still be the historical one. Match on what `pg_constraint` actually says.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let depth = 0; depth < 10 && typeof err === 'object' && err !== null; depth++) {
    const e = err as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === '23505' && (constraint === undefined || e.constraint === constraint)) return true;
    err = e.cause;
  }
  return false;
}
