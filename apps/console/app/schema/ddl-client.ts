'use client';

import { fetchJson } from '@/ui/primitives';

/** Client for the two-step DDL API: preview always, execute on confirm. */

export interface DdlColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  pk?: boolean;
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

/** The type options the builder offers (server enforces the same allowlist). */
export function typeOptions(enums: Record<string, string[]>): { value: string; label: string }[] {
  return [
    { value: 'text', label: 'text' },
    { value: 'varchar(255)', label: 'varchar(255)' },
    { value: 'integer', label: 'integer' },
    { value: 'bigint', label: 'bigint' },
    { value: 'boolean', label: 'boolean' },
    { value: 'numeric(10, 2)', label: 'numeric(10, 2)' },
    { value: 'timestamptz', label: 'timestamptz' },
    { value: 'date', label: 'date' },
    { value: 'uuid', label: 'uuid' },
    { value: 'jsonb', label: 'jsonb' },
    { value: 'text[]', label: 'text[] (array)' },
    ...Object.keys(enums).map((e) => ({ value: e, label: `${e} (enum)` })),
  ];
}
