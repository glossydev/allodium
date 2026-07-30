import 'server-only';

/**
 * Identifier + cast utilities for the console's dynamic SQL.
 *
 * The console builds SQL from user-influenced names by design (it's a database
 * console), so safety is layered and non-optional:
 *
 *   1. Names that reach SQL are either (a) verified to exist in the live catalog
 *      (browse/DML paths — see catalog.ts / dml.ts), or (b) validated against the
 *      strict identifier grammar below (DDL paths creating NEW names).
 *   2. Every identifier is still %I-quoted via qid() — belt and suspenders.
 *   3. Every VALUE travels as a bound parameter with an explicit ::cast derived
 *      from the catalog's udt_name. String concatenation of values is forbidden.
 */

/** format('%I')-equivalent quoting for identifiers. Always use, never interpolate raw. */
export const qid = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

/**
 * Strict grammar for NEW identifiers (tables/columns the DDL lane creates):
 * snake_case, starts with letter/underscore, ≤63 bytes. Deliberately narrower
 * than what Postgres allows — quoted camelCase names are a lifetime of pain.
 */
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function validateIdentifier(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof name !== 'string' || !name.length) return { ok: false, error: 'Name is required' };
  if (!IDENT_RE.test(name)) {
    return {
      ok: false,
      error: `"${name}" — use snake_case: lowercase letters, digits, underscores; must not start with a digit; max 63 chars`,
    };
  }
  return { ok: true, name };
}

/**
 * Cast expression for a bound parameter, derived from the catalog's udt_name.
 * Arrays arrive as udt "_text" etc. → "text"[]. Enums/domains are quoted type names.
 * `$1::"varchar"`, `$2::"user_status"`, `$3::"text"[]` are all valid pg.
 */
export function castExpr(paramRef: string, udtName: string): string {
  if (udtName.startsWith('_')) return `${paramRef}::${qid(udtName.slice(1))}[]`;
  return `${paramRef}::${qid(udtName)}`;
}

/**
 * Pull the FULL pg error out of a pg/drizzle cause chain — headline plus DETAIL and
 * HINT. Those two fields carry the actionable part ("Key (id)=(3) is still referenced
 * from table orders"), and dropping them is precisely how a database tool becomes the
 * mystery-error experience this project exists to avoid.
 */
export function pgErrorMessage(e: unknown): string {
  let cur: unknown = e;
  let best: { message: string; detail?: string; hint?: string; where?: string } | null = null;

  for (let i = 0; i < 5 && cur; i++) {
    const c = cur as { message?: string; detail?: string; hint?: string; where?: string; cause?: unknown };
    if (typeof c.message === 'string' && c.message) {
      // Prefer the deepest frame that actually carries pg fields; otherwise keep the
      // deepest message but hold on to any fields already found.
      if (!best || c.detail || c.hint) best = { message: c.message, detail: c.detail, hint: c.hint, where: c.where };
      else best = { message: c.message, detail: best.detail, hint: best.hint, where: best.where };
    }
    cur = c.cause;
  }

  if (!best) return 'Query failed';
  const parts = [best.message];
  if (best.detail) parts.push(`DETAIL: ${best.detail}`);
  if (best.hint) parts.push(`HINT: ${best.hint}`);
  return parts.join('\n');
}
