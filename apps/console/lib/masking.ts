import 'server-only';

/**
 * Secret-column masking for the console — catalog-driven flavor of the doctrine in
 * @allodium/admin: masked columns are never selected, never editable, never
 * filterable, never sortable, and never on the wire (including the SQL silo, which
 * redacts them by result-field identity).
 *
 * Because the console discovers tables at runtime (no per-table config), masking is
 * pattern-based with overrides in both directions. The pattern errs toward masking.
 *
 * Overrides are RUNTIME, not compile-time: a false positive on someone else's schema
 * must be fixable without editing TypeScript and restarting a dev tool. Set
 *   CONSOLE_MASK_EXTRA="table.col,table.col"     — always mask these
 *   CONSOLE_MASK_EXEMPT="table.col,table.col"    — never mask these
 * Bare "col" (no dot) applies to that column name in every table.
 */

/**
 * Substring (not end-anchored) so `password_reset_token_hash`, `secret_key_id`, and
 * `api_key_last_used` all match. End-anchoring missed whole families of credential
 * columns, and masking is the only protection the generic path has.
 */
const MASK_PATTERN =
  /(password|passwd|secret|token|_hash|hashed_|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|totp|mfa|otp|salt|credential|session[_-]?id|refresh)/i;

/**
 * Names that trip the pattern but are structural, not secret. Kept deliberately
 * short — an entry here is a decision that a column is safe to display.
 */
const BUILTIN_EXEMPT = new Set(['token_type', 'hash_algorithm', 'mfa_enabled', 'password_updated_at', 'secret_count']);

function parseSpec(raw: string | undefined): { qualified: Set<string>; bare: Set<string> } {
  const qualified = new Set<string>();
  const bare = new Set<string>();
  for (const entry of (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (entry.includes('.')) qualified.add(entry);
    else bare.add(entry);
  }
  return { qualified, bare };
}

/**
 * Env is read at call time (the app's thunk convention) so a change takes effect on
 * the next request in dev without a restart.
 */
export function isMaskedColumn(table: string, column: string): boolean {
  const t = table.toLowerCase();
  const c = column.toLowerCase();
  const key = `${t}.${c}`;

  const exempt = parseSpec(process.env.CONSOLE_MASK_EXEMPT);
  if (exempt.qualified.has(key) || exempt.bare.has(c)) return false;

  const extra = parseSpec(process.env.CONSOLE_MASK_EXTRA);
  if (extra.qualified.has(key) || extra.bare.has(c)) return true;

  if (BUILTIN_EXEMPT.has(c)) return false;
  return MASK_PATTERN.test(c);
}

/**
 * True when a masked column blocks inserts entirely (NOT NULL, no default): the
 * generic Content path cannot supply a value it is forbidden to write. Callers
 * surface this as an explanation instead of an opaque pg NOT NULL violation.
 */
export function maskedInsertBlockers(
  columns: { name: string; masked: boolean; nullable: boolean; default: string | null }[]
): string[] {
  return columns.filter((c) => c.masked && !c.nullable && c.default === null).map((c) => c.name);
}
