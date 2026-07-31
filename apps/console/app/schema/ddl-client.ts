'use client';

import { fetchJson } from '@/ui/primitives';

/** Client for the two-step DDL API: preview always, execute on confirm. */

export interface DdlColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  pk?: boolean;
  references?: { table: string; column: string; onDelete?: string };
}

export const ON_DELETE_OPTIONS = [
  { value: 'no action', label: 'no action' },
  { value: 'restrict', label: 'restrict' },
  { value: 'cascade', label: 'cascade' },
  { value: 'set null', label: 'set null' },
];

/**
 * Every column an FK may legally point at: primary keys and single-column unique
 * indexes, grouped by table. Postgres requires the target be uniquely constrained,
 * so offering anything else would just produce a rejected statement.
 */
export function fkTargets(tables: { name: string; pk: string | null; columns: { name: string; type: string; isPk: boolean }[]; indexes: { name: string; definition: string }[] }[]) {
  return tables
    .map((t) => {
      const unique = new Set<string>();
      for (const ix of t.indexes) {
        if (!/create unique index/i.test(ix.definition)) continue;
        const m = /\(([^)]+)\)/.exec(ix.definition);
        if (m && !m[1].includes(',')) unique.add(m[1].trim().replaceAll('"', ''));
      }
      const cols = t.columns.filter((c) => c.isPk || unique.has(c.name));
      return { table: t.name, columns: cols.map((c) => ({ name: c.name, type: c.type, isPk: c.isPk })) };
    })
    .filter((t) => t.columns.length > 0);
}

export async function previewDdl(
  action: string,
  params: Record<string, unknown>
): Promise<{ ok: true; sql: string } | { ok: false; error: string }> {
  const r = await fetchJson<{ sql: string }>('/api/schema/ddl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params, execute: false }),
  });
  return r.ok ? { ok: true, sql: r.data.sql } : r;
}

/**
 * Execute, pinned to the SQL the user actually saw. confirmSql makes the server
 * refuse if a re-build no longer matches, so a debounce race or a concurrent schema
 * change can never run something other than what was previewed.
 */
export async function executeDdlAction(
  action: string,
  params: Record<string, unknown>,
  confirmSql: string
): Promise<{ ok: true; sql: string } | { ok: false; error: string; sql?: string; previewStale?: boolean }> {
  const r = await fetchJson<{ sql: string; ok?: boolean; error?: string; previewStale?: boolean }>('/api/schema/ddl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params, execute: true, confirmSql }),
  });
  if (!r.ok) return r;
  if (r.data.error) return { ok: false, error: r.data.error, sql: r.data.sql, previewStale: r.data.previewStale };
  return { ok: true, sql: r.data.sql };
}

/**
 * The type options the builder offers (server enforces the same allowlist).
 *
 * serial and uuid are first-class TYPES rather than a separate "preset" control:
 * a per-row preset dropdown was one more thing to understand on every column, and
 * the only thing it really encoded was "this is an auto-generated key" — which is
 * a property of the type.
 */
export function typeOptions(enums: Record<string, string[]>): { value: string; label: string }[] {
  return [
    { value: 'serial', label: 'serial (auto-increment)' },
    { value: 'uuid', label: 'uuid' },
    { value: 'text', label: 'text' },
    { value: 'varchar(255)', label: 'varchar(255)' },
    { value: 'integer', label: 'integer' },
    { value: 'bigint', label: 'bigint' },
    { value: 'boolean', label: 'boolean' },
    { value: 'numeric(10, 2)', label: 'numeric(10, 2)' },
    { value: 'timestamptz', label: 'timestamptz' },
    { value: 'date', label: 'date' },
    { value: 'jsonb', label: 'jsonb' },
    { value: 'text[]', label: 'text[] (array)' },
    ...Object.keys(enums).map((e) => ({ value: e, label: `${e} (enum)` })),
  ];
}
