/**
 * @allodium/from-directus — the exit ramp.
 *
 * Directus stores your data in plain Postgres tables, which makes leaving far easier than
 * its license suggests. This package (being extracted live from a real migration) will ship:
 *
 * 1. `pull` — wraps drizzle-kit against a Directus database: filters `directus_*` system
 *    tables, then recovers what lives OUTSIDE the tables — enum choices, relation metadata,
 *    field notes — from `directus_fields`/`directus_relations` and folds it into the
 *    generated Drizzle schema. (Audit tip baked in: also inventory `/flows` — production
 *    instances hide load-bearing logic there.)
 * 2. `adopt-users` — migration for `directus_users` → your users table: argon2 hashes
 *    verify unchanged (zero password resets), provider/external_identifier mapping for
 *    SSO users, role rows → a documented authorization matrix.
 * 3. `adopt-files` — `directus_files` → @allodium/storage with ids preserved, so every
 *    file FK column and historical URL keeps working.
 * 4. `compat` — a thin readItems()/createItem()-shaped adapter over your Drizzle layer:
 *    port a Directus app route-by-route without rewriting call shapes on day one, then
 *    tighten to typed queries at leisure.
 */

export const FROM_DIRECTUS_PACKAGE_STATUS = 'scaffolding' as const;

/** Directus query-operator subset the compat shim commits to translating. */
export const SUPPORTED_FILTER_OPERATORS = [
  '_eq', '_neq', '_in', '_nin', '_null', '_nnull',
  '_gt', '_gte', '_lt', '_lte', '_between',
  '_and', '_or',
] as const;

export function version(): string {
  return '0.0.1';
}
