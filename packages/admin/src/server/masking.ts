/**
 * Secret-column masking for the catalog-driven runtime.
 *
 * The registry lane (`createTableRegistry`) takes an explicit `maskedColumns` map,
 * because a Drizzle schema is a TypeScript file the developer already maintains. The
 * view resolver has no such file: it discovers tables from the live catalog at request
 * time, so it must decide what is secret from the column NAME alone.
 *
 * The decision (owner, 2026-08-05) is to err toward masking. A false positive is a
 * support ticket — a column is hidden until someone exempts it. A false negative is a
 * credential on the wire, and there is no symmetric recovery from that. So the pattern
 * is deliberately greedy and the escape hatch is per-column and auditable.
 *
 * There is deliberately NO global "disable masking" switch. `exempt` names the specific
 * columns a deployment has decided are safe, which leaves a record of the decision; a
 * blanket off-switch would be set once in a hurry and never revisited.
 *
 * Masked columns are never SELECTed, never returned by a write, never editable, never
 * filterable, and never sortable. Ordering by a secret is the same oracle a filter is:
 * both let a caller binary-search a value they cannot read.
 */

/**
 * Substring, NOT end-anchored — `password_reset_token_hash`, `secret_key_id` and
 * `api_key_last_used` all have to match. End-anchoring was tried first and missed whole
 * families of credential columns.
 */
export const MASK_PATTERN =
  /(password|passwd|secret|token|_hash|hashed_|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|totp|mfa|otp|salt|credential|session[_-]?id|refresh)/i;

/**
 * Names that trip the pattern but are structural rather than secret. Kept deliberately
 * short: an entry here is a standing decision that a column is safe to display, and it
 * applies to every schema this package ever runs against.
 */
const BUILTIN_EXEMPT = new Set([
  'token_type',
  'hash_algorithm',
  'mfa_enabled',
  'password_updated_at',
  'secret_count',
]);

/** `string[]`, or a thunk returning one — the package reads no env; the app binds it. */
export type MaskSpec = string[] | (() => string[] | string | undefined);

export interface MaskOptions {
  /** Always mask these. `"table.column"` or a bare `"column"` (any table). */
  extra?: MaskSpec;
  /** Never mask these. Same forms. Takes precedence over everything, including `extra`. */
  exempt?: MaskSpec;
  /** Replace the built-in name pattern. Rarely correct; usually `extra` is what you want. */
  pattern?: RegExp;
}

export interface MaskPolicy {
  isMasked(table: string, column: string): boolean;
}

function parseSpec(spec: MaskSpec | undefined): { qualified: Set<string>; bare: Set<string> } {
  const raw = typeof spec === 'function' ? spec() : spec;
  const entries = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);

  const qualified = new Set<string>();
  const bare = new Set<string>();
  for (const e of entries) (e.includes('.') ? qualified : bare).add(e);
  return { qualified, bare };
}

/**
 * Specs are resolved on every call rather than at construction, so a thunk reading an
 * env var takes effect on the next request instead of at the next restart — the same
 * call-time semantics the rest of the toolkit uses for env-driven config.
 */
export function createMaskPolicy(opts: MaskOptions = {}): MaskPolicy {
  const pattern = opts.pattern ?? MASK_PATTERN;

  return {
    isMasked(table: string, column: string): boolean {
      const c = column.toLowerCase();
      const key = `${table.toLowerCase()}.${c}`;

      const exempt = parseSpec(opts.exempt);
      if (exempt.qualified.has(key) || exempt.bare.has(c)) return false;

      const extra = parseSpec(opts.extra);
      if (extra.qualified.has(key) || extra.bare.has(c)) return true;

      if (BUILTIN_EXEMPT.has(c)) return false;
      return pattern.test(c);
    },
  };
}

/**
 * Masked columns that block an insert outright: NOT NULL with no default, so the
 * generic path cannot supply a value it is forbidden to write. Callers surface this as
 * an explanation rather than letting it surface as an opaque pg NOT NULL violation.
 */
export function maskedInsertBlockers(
  columns: { name: string; nullable: boolean; hasDefault: boolean }[],
  table: string,
  policy: MaskPolicy
): string[] {
  return columns
    .filter((c) => policy.isMasked(table, c.name) && !c.nullable && !c.hasDefault)
    .map((c) => c.name);
}
