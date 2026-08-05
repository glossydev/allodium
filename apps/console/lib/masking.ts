import 'server-only';
import { createMaskPolicy } from '@allodium/admin/server';

/**
 * Secret-column masking for the console — masked columns are never selected, never
 * editable, never filterable, never sortable, and never on the wire (including the SQL
 * silo, which redacts them by result-field identity).
 *
 * The pattern, the built-in exemptions and the override parsing all live in
 * `@allodium/admin/server` now. This file is the console's BINDING of that policy: it
 * supplies the env-var overrides and nothing else.
 *
 * That split is deliberate. The rule was written out here and, once the view resolver
 * needed it too, in the package — two declarations of one truth with no import between
 * them. That is the same shape as the second local copy of `humanize`: the build stays
 * green while the halves drift, and whichever one a reader checks, they can be wrong.
 * `packages/admin/test/masking.mjs` is the guard for the rule itself.
 *
 * Overrides stay RUNTIME, not compile-time: a false positive on someone else's schema
 * must be fixable without editing TypeScript and restarting a dev tool. Set
 *   CONSOLE_MASK_EXTRA="table.col,table.col"     — always mask these
 *   CONSOLE_MASK_EXEMPT="table.col,table.col"    — never mask these
 * Bare "col" (no dot) applies to that column name in every table.
 */

/**
 * Thunks, not values: env is read at call time (the toolkit's convention for env-driven
 * config) so a change takes effect on the next request in dev without a restart.
 */
export const maskPolicy = createMaskPolicy({
  extra: () => process.env.CONSOLE_MASK_EXTRA,
  exempt: () => process.env.CONSOLE_MASK_EXEMPT,
});

export function isMaskedColumn(table: string, column: string): boolean {
  return maskPolicy.isMasked(table, column);
}

/**
 * True when a masked column blocks inserts entirely (NOT NULL, no default): the
 * generic Content path cannot supply a value it is forbidden to write. Callers
 * surface this as an explanation instead of an opaque pg NOT NULL violation.
 *
 * Kept here rather than imported: it reads the console catalog's own column shape,
 * where `masked` is already resolved and `default` is the raw expression text. It
 * re-declares no rule — it only reads the flag.
 */
export function maskedInsertBlockers(
  columns: { name: string; masked: boolean; nullable: boolean; default: string | null }[]
): string[] {
  return columns.filter((c) => c.masked && !c.nullable && c.default === null).map((c) => c.name);
}
