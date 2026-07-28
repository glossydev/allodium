/**
 * @allodium/db — the data-layer seam.
 *
 * Conventions this package enforces (each one is a scar from a headless-CMS migration):
 * 1. ONE pool per process, created explicitly — never implicit per-request connections.
 * 2. Multi-write sequences run in transactions. (Directus's REST API offered none; the
 *    orphaned-records cleanup that caused is why this helper exists.)
 * 3. Query modules return TYPED nested objects with stable shapes — never the
 *    "sometimes an id, sometimes an object" relation ambiguity that forces defensive
 *    unwrapping at every call site.
 * 4. Money is decimal-in-Postgres, dollars-as-number at the boundary, 2-dp rounded.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

export interface CreateDbOptions extends PoolConfig {
  /** Log slow queries above this many ms (0 disables). Default 0. */
  slowQueryMs?: number;
}

export interface AllodiumDb<TSchema extends Record<string, unknown> = Record<string, never>> {
  pool: Pool;
  db: NodePgDatabase<TSchema>;
  /** Graceful shutdown — call from your process signal handlers. */
  close(): Promise<void>;
}

/**
 * Create the process-wide pool + Drizzle instance.
 * In Next.js dev (HMR re-evaluates modules), pass a `globalThis` cache slot via
 * `singleton()` instead of calling this directly.
 */
export function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  opts: CreateDbOptions = {}
): AllodiumDb<TSchema> {
  const { slowQueryMs: _slow, ...poolConfig } = opts;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    ...poolConfig,
  });
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}

/**
 * HMR-safe singleton for Next.js: survives module re-evaluation in dev without leaking
 * pools, while remaining a plain call in production.
 */
export function singleton<T>(key: string, create: () => T): T {
  const store = globalThis as unknown as { __allodium?: Record<string, unknown> };
  store.__allodium ??= {};
  store.__allodium[key] ??= create();
  return store.__allodium[key] as T;
}

/** Round to 2 decimal places — the money convention at the JS boundary. */
export function money(v: unknown): number {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/**
 * Serialize Postgres NUMERIC (string at the driver boundary) to dollars-as-number.
 * Use in query-module mappers so route code never sees "45.00" strings.
 */
export function numeric(v: string | number | null | undefined): number {
  return money(v);
}

export {
  toWireRow,
  toWireRows,
  pgTimestamptzToIso,
  pgNaiveToIso,
  normalizePgTimestamp,
} from './wire.js';
export { isUniqueViolation } from './errors.js';
