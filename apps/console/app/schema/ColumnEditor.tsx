'use client';

import { useEffect, useState } from 'react';
import { tk } from '@/ui/tokens';
import { SlideOver, SqlPreview, fetchJson } from '@/ui/primitives';
import { previewDdl, executeDdlAction, typeOptions } from './ddl-client';
import type { SchemaTable } from './SchemaBrowser';
import type { ClientColumn } from '../content/types';

/**
 * Column editor — the ALTER half of the schema silo.
 *
 * Four independent operations on one column (rename, type, nullability, default),
 * each with its own preview and its own Apply, rather than one "save" that emits a
 * batch. Reason: each maps to a distinct ALTER statement with distinct failure
 * modes, and a combined save would leave you guessing which part failed when
 * Postgres rejected one of them.
 */

type Op = 'rename' | 'type' | 'nullable' | 'default';

export default function ColumnEditor({
  table,
  column,
  onClose,
  onDone,
  onRenamed,
  enums,
}: {
  table: SchemaTable;
  column: ClientColumn;
  onClose: () => void;
  onDone: () => void;
  /** A rename changes the column's identity — tell the parent so it can follow it. */
  onRenamed: (newName: string) => void;
  enums: Record<string, string[]>;
}) {
  const [newName, setNewName] = useState(column.name);
  const [newType, setNewType] = useState(column.type);
  const [notNull, setNotNull] = useState(!column.nullable);
  const [defaultValue, setDefaultValue] = useState(column.default ?? '');
  const [comment, setComment] = useState(column.comment ?? '');
  const [nulls, setNulls] = useState<number | null>(null);

  // Reset when the editor is pointed at a different column.
  useEffect(() => {
    setNewName(column.name);
    setNewType(column.type);
    setNotNull(!column.nullable);
    setDefaultValue(column.default ?? '');
    setComment(column.comment ?? '');
  }, [column.name, column.type, column.nullable, column.default, column.comment]);

  // Pre-check for SET NOT NULL, so the warning arrives before the failure does.
  useEffect(() => {
    if (!column.nullable) {
      setNulls(null);
      return;
    }
    let cancelled = false;
    fetchJson<{ nulls: number }>(`/api/schema/nulls?table=${encodeURIComponent(table.name)}&column=${encodeURIComponent(column.name)}`).then(
      (r) => {
        if (!cancelled && r.ok) setNulls(r.data.nulls);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [table.name, column.name, column.nullable]);

  return (
    <SlideOver
      title={
        <span className="font-mono">
          {table.name}.{column.name}
        </span>
      }
      onClose={onClose}
      width="w-[520px]"
      footer={
        <button onClick={onClose} className={`${tk.btn2} ml-auto`}>
          Done
        </button>
      }
    >
      <div className="space-y-5 p-4">
        <div className={`text-[11px] ${tk.muted}`}>
          <span className="font-mono text-zinc-300">{column.type}</span>
          {column.nullable ? ' · nullable' : ' · not null'}
          {column.default ? ` · default ${column.default}` : ''}
          {column.isPk ? ' · primary key' : ''}
          {column.fkTable ? ` · → ${column.fkTable}.${column.fkColumn}` : ''}
        </div>

        <Operation
          label="Rename"
          action="renameColumn"
          params={{ table: table.name, column: column.name, newName: newName.trim() }}
          ready={!!newName.trim() && newName.trim() !== column.name}
          onDone={() => {
            const renamed = newName.trim();
            onDone();
            onRenamed(renamed);
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} className={`${tk.input} w-full font-mono`} />
        </Operation>

        <Operation
          label="Change type"
          action="alterColumnType"
          params={{ table: table.name, column: column.name, newType }}
          ready={newType !== column.type}
          onDone={onDone}
          note="Existing rows are converted with an explicit cast — the preview shows exactly which."
        >
          <select value={newType} onChange={(e) => setNewType(e.target.value)} className={`${tk.select} w-full`}>
            {/* The current type may be something the builder does not offer (e.g. char(3));
                keep it selectable so the control never silently changes meaning. */}
            {!typeOptions(enums).some((o) => o.value === column.type) && <option value={column.type}>{column.type} (current)</option>}
            {typeOptions(enums)
              .filter((o) => o.value !== 'serial')
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </select>
        </Operation>

        <Operation
          label={notNull ? 'Require a value (NOT NULL)' : 'Allow NULL'}
          action="setNotNull"
          params={{ table: table.name, column: column.name, notNull }}
          ready={notNull === column.nullable}
          onDone={onDone}
          warning={
            notNull && column.nullable && nulls !== null && nulls > 0
              ? `${nulls} row${nulls === 1 ? '' : 's'} currently hold NULL — Postgres will refuse this until they have values.`
              : undefined
          }
        >
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={notNull} onChange={(e) => setNotNull(e.target.checked)} className={tk.checkbox} />
            NOT NULL
            {nulls !== null && <span className={tk.faint}>({nulls} null now)</span>}
          </label>
        </Operation>

        {/* Placed above Default because it is the field people will actually reach
            for: it is where an admin screen's help text comes from. */}
        <Operation
          label="Description"
          action="setColumnComment"
          params={{ table: table.name, column: column.name, comment: comment.trim() || null }}
          ready={comment.trim() !== (column.comment ?? '')}
          onDone={onDone}
          note="Stored as a Postgres COMMENT — it lives with the column, shows up in psql, and becomes the default help text on any admin screen showing this field."
        >
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="What is this column for, in a sentence?"
            className={`${tk.input} w-full resize-y`}
          />
        </Operation>

        <Operation
          label="Default"
          action="setDefault"
          params={{ table: table.name, column: column.name, value: defaultValue.trim() || null }}
          ready={(defaultValue.trim() || '') !== (column.default ?? '')}
          onDone={onDone}
          note="Empty drops the default. Existing rows are not rewritten."
        >
          <input
            value={defaultValue}
            onChange={(e) => setDefaultValue(e.target.value)}
            placeholder="now() / 'str' / 0 / true — empty to drop"
            className={`${tk.input} w-full font-mono`}
          />
        </Operation>
      </div>
    </SlideOver>
  );
}

/** One ALTER: inputs, live preview, its own Apply, its own error. */
function Operation({
  label,
  action,
  params,
  ready,
  onDone,
  note,
  warning,
  children,
}: {
  label: string;
  action: string;
  params: Record<string, unknown>;
  ready: boolean;
  onDone: () => void;
  note?: string;
  warning?: string;
  children: React.ReactNode;
}) {
  const [sql, setSql] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const paramKey = JSON.stringify(params);
  useEffect(() => {
    if (!ready) {
      setSql(null);
      setBuildError(null);
      return;
    }
    let cancelled = false;
    setSql(null);
    const t = setTimeout(() => {
      previewDdl(action, params).then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setSql(r.sql);
          setBuildError(null);
        } else {
          setSql(null);
          setBuildError(r.error);
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, paramKey, ready]);

  const run = async () => {
    if (!sql) return;
    setRunning(true);
    setExecError(null);
    const r = await executeDdlAction(action, params, sql);
    setRunning(false);
    if (r.ok) onDone();
    else setExecError(r.error);
  };

  return (
    // data-op is a stable hook for driving each ALTER independently in browser tests.
    <div data-op={action} className="space-y-1.5 border-t border-zinc-800 pt-3 first:border-t-0 first:pt-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{label}</div>
      {children}
      {note && <p className={`text-[10px] ${tk.faint}`}>{note}</p>}
      {warning && <div className={tk.warn}>{warning}</div>}
      {buildError && <div className={tk.err}>{buildError}</div>}
      {execError && <div className={`${tk.err} whitespace-pre-wrap`}>{execError}</div>}
      {sql && <SqlPreview sql={sql} />}
      <button onClick={run} disabled={!sql || running} className={tk.btn}>
        {running ? 'Running…' : 'Apply'}
      </button>
    </div>
  );
}
