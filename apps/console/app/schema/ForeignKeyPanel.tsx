'use client';

import { useMemo, useState } from 'react';
import { tk } from '@/ui/tokens';
import { SlideOver, SqlPreview } from '@/ui/primitives';
import { executeDdlAction, previewDdl } from './ddl-client';
import type { SchemaTable } from './SchemaBrowser';
import { useEffect } from 'react';

/**
 * The FK builder — the flagship interaction, built to the owner's spec:
 * click +fk on a column → pick a table → pick a column → see the exact SQL →
 * run it. Failures show the verbatim pg error. Nothing is mysterious.
 */

const ON_DELETE: { value: string; label: string; hint: string }[] = [
  { value: 'no action', label: 'no action', hint: 'block the delete if rows still reference it (checked at end of statement)' },
  { value: 'restrict', label: 'restrict', hint: 'block the delete immediately — strictest' },
  { value: 'cascade', label: 'cascade', hint: 'delete referencing rows too — children die with the parent' },
  { value: 'set null', label: 'set null', hint: 'null out the reference — requires the column be nullable' },
];

export default function ForeignKeyPanel({
  table,
  column,
  tables,
  onClose,
  onDone,
}: {
  table: string;
  column: string;
  tables: SchemaTable[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [search, setSearch] = useState('');
  const [refTable, setRefTable] = useState<string | null>(null);
  const [refColumn, setRefColumn] = useState<string | null>(null);
  const [onDelete, setOnDelete] = useState('no action');
  const [sql, setSql] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const sourceCol = tables.find((t) => t.name === table)?.columns.find((c) => c.name === column);
  const target = useMemo(() => tables.find((t) => t.name === refTable) ?? null, [tables, refTable]);
  const tableList = tables.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()));

  /** Columns worth referencing: PK first, then unique-indexed ones. */
  const refColumns = useMemo(() => {
    if (!target) return [];
    const uniqueCols = new Set<string>();
    for (const ix of target.indexes) {
      if (/create unique index/i.test(ix.definition)) {
        const m = /\(([^)]+)\)/.exec(ix.definition);
        if (m && !m[1].includes(',')) uniqueCols.add(m[1].trim().replaceAll('"', ''));
      }
    }
    return target.columns
      .filter((c) => c.isPk || uniqueCols.has(c.name))
      .map((c) => ({ name: c.name, type: c.type, isPk: c.isPk }));
  }, [target]);

  const pickTable = (name: string) => {
    setRefTable(name);
    const t = tables.find((x) => x.name === name);
    setRefColumn(t?.pk ?? null);
    setExecError(null);
  };

  // Live preview whenever the choice is complete. Clear first so Execute is never
  // armed against a statement from a previous selection.
  useEffect(() => {
    if (!refTable || !refColumn) {
      setSql(null);
      return;
    }
    let cancelled = false;
    setSql(null);
    previewDdl('addForeignKey', { table, column, refTable, refColumn, onDelete }).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setSql(r.sql);
        setBuildError(null);
      } else {
        setSql(null);
        setBuildError(r.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [table, column, refTable, refColumn, onDelete]);

  const run = async () => {
    if (!refTable || !refColumn || !sql) return;
    setRunning(true);
    setExecError(null);
    // Pinned to the previewed SQL — the server refuses if a re-build differs.
    const r = await executeDdlAction('addForeignKey', { table, column, refTable, refColumn, onDelete }, sql);
    setRunning(false);
    if (r.ok) onDone();
    else setExecError(r.error);
  };

  return (
    <SlideOver
      title={
        <span className="font-mono">
          fk: {table}.{column} →
        </span>
      }
      onClose={onClose}
      width="w-[480px]"
      footer={
        <>
          <button onClick={run} disabled={!sql || running} className={tk.btn}>
            {running ? 'Running…' : 'Add foreign key'}
          </button>
          <button onClick={onClose} disabled={running} className={`${tk.btn2} ml-auto`}>
            Cancel
          </button>
        </>
      }
    >
      <div className="space-y-4 p-4">
        {sourceCol && (
          <div className={`text-[11px] ${tk.muted}`}>
            source column: <span className="font-mono text-zinc-300">{column}</span>{' '}
            <span className="font-mono">{sourceCol.type}</span>
            {sourceCol.nullable ? ' · nullable' : ' · not null'}
          </div>
        )}

        {/* Step 1: table */}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">1 · referenced table</div>
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tables…"
            className={`${tk.input} mb-1.5 w-full`}
          />
          <div className="max-h-44 overflow-y-auto rounded border border-zinc-800">
            {tableList.map((t) => (
              <button
                key={t.name}
                onClick={() => pickTable(t.name)}
                className={`flex w-full items-center justify-between px-2.5 py-1 text-left font-mono text-xs ${
                  refTable === t.name ? 'bg-emerald-950/40 text-emerald-300' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <span>{t.name}</span>
                <span className="text-[10px] text-zinc-600">pk: {t.pk ?? '—'}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Step 2: column */}
        {target && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">2 · referenced column</div>
            {refColumns.length === 0 ? (
              <div className={tk.warn}>No PK or unique column on {target.name} — FKs must reference one.</div>
            ) : (
              <div className="space-y-1">
                {refColumns.map((c) => (
                  <label key={c.name} className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="radio"
                      name="refcol"
                      checked={refColumn === c.name}
                      onChange={() => setRefColumn(c.name)}
                      className={tk.checkbox}
                    />
                    <span className="font-mono">{c.name}</span>
                    <span className="font-mono text-zinc-500">{c.type}</span>
                    {c.isPk && <span className={tk.pk}>PK</span>}
                  </label>
                ))}
              </div>
            )}
            {sourceCol && refColumn && (
              <TypeCompatNote sourceType={sourceCol.type} targetType={refColumns.find((c) => c.name === refColumn)?.type} />
            )}
          </div>
        )}

        {/* Step 3: on delete */}
        {refColumn && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">3 · when the referenced row is deleted</div>
            <div className="space-y-1">
              {ON_DELETE.map((o) => (
                <label key={o.value} className="flex items-start gap-2 text-xs text-zinc-300">
                  <input
                    type="radio"
                    name="ondelete"
                    checked={onDelete === o.value}
                    onChange={() => setOnDelete(o.value)}
                    className={`mt-0.5 ${tk.checkbox}`}
                  />
                  <span>
                    <span className="font-mono">{o.label}</span>
                    <span className={`ml-1.5 ${tk.muted}`}>— {o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {buildError && <div className={tk.err}>{buildError}</div>}
        {execError && <div className={`${tk.err} whitespace-pre-wrap`}>{execError}</div>}
        {sql && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">this will run</div>
            <SqlPreview sql={sql} />
          </div>
        )}
      </div>
    </SlideOver>
  );
}

/**
 * Honest heads-up when the column types can't FK — pg will reject it; say so first.
 * Postgres compares the underlying type, so text/varchar/char interoperate and the
 * integer family interoperates; warning about those would be crying wolf.
 */
function TypeCompatNote({ sourceType, targetType }: { sourceType: string; targetType?: string }) {
  if (!targetType) return null;
  const family = (t: string): string => {
    const base = t.replace(/\(.*\)/, '').trim();
    if (base === 'serial' || base === 'integer' || base === 'bigint' || base === 'smallint') return 'int';
    if (base === 'text' || base === 'varchar' || base === 'char' || base === 'character varying') return 'text';
    return base;
  };
  if (family(sourceType) === family(targetType)) return null;
  return (
    <div className={`mt-1.5 ${tk.warn}`}>
      Type mismatch: {sourceType} → {targetType}. Postgres will reject this — the error will show below if you run it.
    </div>
  );
}
