import 'server-only';
import { createDb, singleton, type AllodiumDb } from '@allodium/db';

/**
 * The console's pool — @allodium/db's HMR-safe singleton, catalog-driven so no
 * Drizzle schema module is passed: the console must see EVERY table, including
 * ones it created ten seconds ago. Typed query building belongs to the consuming
 * app's lane, not the console's.
 */
export function getDb(): AllodiumDb<Record<string, never>> {
  return singleton('console-db', () =>
    createDb(
      {},
      {
        connectionString: process.env.DATABASE_URL,
        max: 5,
      }
    )
  );
}

/**
 * Separate pool for the SQL silo, connected as a role with only SELECT privileges
 * (see dev/seed/004-readonly-role.sql). Privileges cannot be overridden from inside
 * a session, unlike `set transaction read only` — which a multi-statement query was
 * able to lift before lib/sql-guard.ts existed.
 *
 * Falls back to the main pool when unconfigured so the console still runs out of the
 * box; callers surface that downgrade in the UI rather than hiding it.
 */
export function getReadOnlyDb(): { db: AllodiumDb<Record<string, never>>; leastPrivilege: boolean } {
  const url = process.env.CONSOLE_RO_DATABASE_URL;
  if (!url) return { db: getDb(), leastPrivilege: false };
  return {
    db: singleton('console-db-ro', () => createDb({}, { connectionString: url, max: 3 })),
    leastPrivilege: true,
  };
}
