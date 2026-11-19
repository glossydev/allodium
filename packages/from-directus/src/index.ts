/**
 * @allodium/from-directus — the exit ramp.
 *
 * Directus stores your data in plain Postgres tables, which makes leaving far easier
 * than it looks. What is NOT in the tables — field notes, enum choices, which widget
 * edited what, who may see which rows, the logic hiding in flows — lives in the
 * `directus_*` system tables, and that is what this package recovers.
 *
 * Four read-only steps, each producing data you review before anything runs:
 *
 *   inspect(db)              → the Inventory: collections, fields with their metadata,
 *                              relations, roles/policies/permissions, flows, user and
 *                              file counts, and warnings.
 *   planViews(inventory)     → `.view.json` drafts for the admin + COMMENT ON statements
 *                              carrying notes into the schema.
 *   planGrants(inventory)    → roles + role_permissions SQL with row filters translated
 *                              exactly or left out and listed (fail closed).
 *   planDecommission(inv)    → the one-transaction cutover: users (argon2 hashes verify
 *                              unchanged), roles, files with ids preserved, explicit drops.
 *   fileManifest / checkFiles → prove the uploads directory copy is complete.
 *
 * Nothing here writes to a database or a disk. You run the SQL; you write the files.
 * That is deliberate: a migration is a sequence of decisions, and the package's job is
 * to make every one of them visible, not to take them.
 */

export { inspect, convertDisplayTemplate } from './inspect.js';
export { planViews, type ViewsPlanOptions } from './views.js';
export { planGrants, slugifyRole, type GrantsPlanOptions } from './grants.js';
export { translateFilter, UntranslatableFilter } from './filters.js';
export { planDecommission, type DecommissionOptions } from './decommission.js';
export { fileManifest, checkFiles, type FileCheck } from './files.js';
export type * from './types.js';

/** Directus filter operators `translateFilter` expresses exactly. Everything else is refused, never approximated. */
export const SUPPORTED_FILTER_OPERATORS = [
  '_eq', '_neq', '_in', '_null', '_nnull',
  '_gt', '_gte', '_lt', '_lte',
  '_contains', '_icontains', '_starts_with', '_istarts_with', '_ends_with', '_iends_with',
  '_and',
] as const;
