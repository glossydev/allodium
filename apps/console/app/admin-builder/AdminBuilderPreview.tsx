'use client';

import { useEffect, useMemo, useState } from 'react';
import { tk } from '@/ui/tokens';
import { fetchJson, LoadingState } from '@/ui/primitives';
import type { ClientCatalog, ClientColumn } from '../content/types';

/**
 * Admin Builder — placeholder with the vision made visible.
 *
 * The two-lane thesis: this console BUILDS the site; the admin dashboard RUNS it.
 * This screen is where the console will generate the dashboard: pick a table,
 * choose the fields to expose, emit a view definition the dashboard styles.
 * The mock below is local-only — the definition format is a draft.
 */

interface FieldPick {
  column: string;
  label: string;
  include: boolean;
}

function widgetFor(c: ClientColumn): string {
  if (c.fkTable) return 'relation';
  switch (c.family) {
    case 'boolean':
      return 'toggle';
    case 'enum':
      return 'select';
    case 'json':
      return 'json-editor';
    case 'array':
      return 'tag-list';
    case 'date':
    case 'datetime':
      return 'date-picker';
    case 'number':
      return 'number';
    default:
      return 'text';
  }
}

const titleize = (s: string) => s.replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());

export default function AdminBuilderPreview() {
  const [catalog, setCatalog] = useState<ClientCatalog | null>(null);
  const [table, setTable] = useState('');
  const [fields, setFields] = useState<FieldPick[]>([]);

  useEffect(() => {
    fetchJson<ClientCatalog>('/api/catalog').then((r) => {
      if (r.ok) setCatalog(r.data);
    });
  }, []);

  const current = useMemo(() => catalog?.tables.find((t) => t.name === table) ?? null, [catalog, table]);

  useEffect(() => {
    if (!current) {
      setFields([]);
      return;
    }
    setFields(
      current.columns.map((c) => ({
        column: c.name,
        label: titleize(c.name),
        include: !c.masked && !c.isPk,
      }))
    );
  }, [current]);

  const definition = useMemo(() => {
    if (!current) return null;
    return {
      table: current.name,
      title: titleize(current.name),
      fields: fields
        .filter((f) => f.include)
        .map((f) => {
          const col = current.columns.find((c) => c.name === f.column)!;
          return { column: f.column, label: f.label, widget: widgetFor(col) };
        }),
    };
  }, [current, fields]);

  if (!catalog) return <LoadingState />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div>
          <h1 className={tk.h1}>Admin Builder</h1>
          <p className={`mt-1.5 max-w-xl text-xs leading-relaxed ${tk.muted}`}>
            The console builds the site — the admin dashboard runs it. This is where the console will{' '}
            <span className="text-zinc-300">generate</span> that dashboard: pick a table, choose the fields
            administrative users should see, and emit a view definition the dashboard picks up and styles.
            Marketing gets a blog editor, support gets an orders screen — without anyone writing them by hand.
          </p>
        </div>

        <div className="flex items-end gap-3">
          <div>
            <label className="text-[11px] font-medium text-zinc-400">table</label>
            <select value={table} onChange={(e) => setTable(e.target.value)} className={`${tk.select} mt-0.5 block font-mono`}>
              <option value="">—</option>
              {catalog.tables.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <button disabled className={tk.btn} title="Coming soon">
            Generate admin view (coming soon)
          </button>
        </div>

        {current && (
          <div className="grid grid-cols-2 gap-4">
            {/* Field picker */}
            <div className={`rounded border ${tk.panel} p-3`}>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Fields</div>
              <div className="space-y-1.5">
                {fields.map((f, i) => {
                  const col = current.columns.find((c) => c.name === f.column)!;
                  return (
                    <div key={f.column} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={f.include}
                        disabled={col.masked}
                        onChange={(e) => setFields((prev) => prev.map((x, xi) => (xi === i ? { ...x, include: e.target.checked } : x)))}
                        className={tk.checkbox}
                      />
                      <span className="w-32 truncate font-mono text-xs text-zinc-300" title={f.column}>
                        {f.column}
                      </span>
                      {col.masked ? (
                        <span className="text-[10px] italic text-zinc-600">masked</span>
                      ) : (
                        <input
                          value={f.label}
                          disabled={!f.include}
                          onChange={(e) => setFields((prev) => prev.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)))}
                          className={`${tk.input} min-w-0 flex-1`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Definition preview */}
            <div className={`rounded border ${tk.panel} p-3`}>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                View definition <span className="normal-case text-zinc-600">(draft format)</span>
              </div>
              <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-emerald-200">
                {JSON.stringify(definition, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
