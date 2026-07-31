'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { tk } from '@/ui/tokens';
import { Modal, SqlPreview } from '@/ui/primitives';
import { previewDdl, executeDdlAction, typeOptions, fkTargets, ON_DELETE_OPTIONS, type DdlColumnSpec } from './ddl-client';
import type { SchemaTable } from './SchemaBrowser';

/**
 * Builder modals. Shared shape: edit inputs → live SQL preview (debounced round
 * trip to the builder API) → Execute → verbatim pg error inline on failure.
 * The preview IS the trust mechanism — never hide what will run.
 */

export function useDdlPreview(action: string, params: Record<string, unknown>, ready: boolean) {
  const [sql, setSql] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const paramKey = JSON.stringify(params);

  useEffect(() => {
    if (!ready) {
      setSql(null);
      setBuildError(null);
      setPending(false);
      return;
    }
    // Clear the previous SQL the instant inputs change. Leaving it on screen during
    // the debounce is what let Execute fire against a statement the user never saw.
    setSql(null);
    setPending(true);
    let cancelled = false;
    const t = setTimeout(() => {
      previewDdl(action, params).then((r) => {
        if (cancelled) return;
        setPending(false);
        if (r.ok) {
          setSql(r.sql);
          setBuildError(null);
        } else {
          setSql(null);
          setBuildError(r.error);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // paramKey is the value-identity of params; params itself is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, paramKey, ready]);

  return { sql, buildError, pending };
}

export function ExecuteFooter({
  action,
  params,
  previewSql,
  onDone,
  onClose,
  label = 'Execute',
}: {
  action: string;
  params: Record<string, unknown>;
  /** The exact SQL currently on screen. Null disables Execute — nothing to confirm. */
  previewSql: string | null;
  onDone: () => void;
  onClose: () => void;
  label?: string;
}) {
  const [running, setRunning] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!previewSql) return;
    setRunning(true);
    setExecError(null);
    // Pin execution to the previewed string; the server refuses a mismatch.
    const r = await executeDdlAction(action, params, previewSql);
    setRunning(false);
    if (r.ok) onDone();
    else setExecError(r.error);
  }, [action, params, previewSql, onDone]);

  return (
    <div className="flex w-full flex-col gap-2">
      {execError && <div className={`${tk.err} whitespace-pre-wrap`}>{execError}</div>}
      <div className="flex items-center gap-2">
        <button onClick={run} disabled={!previewSql || running} className={tk.btn}>
          {running ? 'Running…' : label}
        </button>
        <button onClick={onClose} disabled={running} className={tk.btn2}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ Create table ------------------------------ */

type ColRow = DdlColumnSpec;

const emptyCol = (): ColRow => ({ name: '', type: 'text', nullable: true, default: '', pk: false });

/** Encode a reference as one select value so the row stays a single control. */
const refValue = (r: ColRow['references']) => (r ? `${r.table}.${r.column}` : '');

export function CreateTableModal({
  enums,
  tables,
  onClose,
  onDone,
}: {
  enums: Record<string, string[]>;
  tables: SchemaTable[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [cols, setCols] = useState<ColRow[]>([
    { name: 'id', type: 'serial', nullable: false, default: '', pk: true },
    emptyCol(),
  ]);

  const targets = useMemo(() => fkTargets(tables), [tables]);

  const setCol = (i: number, patch: Partial<ColRow>) =>
    setCols((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  /** Choosing a reference also matches the column's type to its target. */
  const setRef = (i: number, value: string) => {
    if (!value) {
      setCol(i, { references: undefined });
      return;
    }
    const [table, column] = value.split('.');
    const target = targets.find((t) => t.table === table)?.columns.find((c) => c.name === column);
    // serial columns reference as integer; otherwise mirror the target's type so pg
    // doesn't reject the constraint for an incompatible type.
    const type = target ? (target.type === 'serial' ? 'integer' : target.type) : undefined;
    setCol(i, { references: { table, column, onDelete: 'no action' }, ...(type ? { type } : {}) });
  };

  const specCols = cols
    .filter((c) => c.name.trim())
    .map((c) => ({ ...c, default: c.default?.trim() ? c.default.trim() : undefined }));
  const ready = name.trim().length > 0 && specCols.length > 0;
  const params = { name: name.trim(), columns: specCols };
  const { sql, buildError } = useDdlPreview('createTable', params, ready);

  const GRID = 'grid grid-cols-[1.1fr_1fr_1.3fr_110px_1fr_34px_34px_24px] items-center gap-1.5';

  return (
    <Modal
      title="New table"
      onClose={onClose}
      width="max-w-5xl"
      footer={<ExecuteFooter action="createTable" params={params} previewSql={sql} onDone={onDone} onClose={onClose} label="Create table" />}
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400">table name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="snake_case"
            className={`${tk.input} mt-0.5 w-full font-mono`}
          />
        </div>

        <div className="space-y-1.5">
          <div className={`${GRID} text-[10px] uppercase tracking-wide text-zinc-500`}>
            <span>name</span>
            <span>type</span>
            <span>references</span>
            <span>on delete</span>
            <span>default</span>
            <span>null</span>
            <span>pk</span>
            <span />
          </div>
          {cols.map((c, i) => {
            const isSerial = c.type === 'serial';
            return (
              <div key={i} className={GRID}>
                <input
                  value={c.name}
                  onChange={(e) => setCol(i, { name: e.target.value })}
                  placeholder="column"
                  className={`${tk.input} font-mono`}
                />
                <select value={c.type} onChange={(e) => setCol(i, { type: e.target.value })} className={tk.select}>
                  {typeOptions(enums).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                {/* Foreign keys are declarable HERE, while creating the table — the
                    first place anyone looks. Only PK/unique columns are offered,
                    since those are the only legal targets. */}
                <select value={refValue(c.references)} onChange={(e) => setRef(i, e.target.value)} className={`${tk.select} font-mono`}>
                  <option value="">—</option>
                  {targets.map((t) => (
                    <optgroup key={t.table} label={t.table}>
                      {t.columns.map((tc) => (
                        <option key={tc.name} value={`${t.table}.${tc.name}`}>
                          {t.table}.{tc.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <select
                  value={c.references?.onDelete ?? 'no action'}
                  onChange={(e) => c.references && setCol(i, { references: { ...c.references, onDelete: e.target.value } })}
                  disabled={!c.references}
                  className={tk.select}
                >
                  {ON_DELETE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <input
                  value={isSerial ? '' : (c.default ?? '')}
                  onChange={(e) => setCol(i, { default: e.target.value })}
                  // serial installs its own nextval default; a second one is a pg error.
                  disabled={isSerial}
                  placeholder={isSerial ? 'auto' : "now() / 'str' / 0"}
                  className={`${tk.input} font-mono`}
                />
                <input
                  type="checkbox"
                  checked={c.nullable}
                  disabled={isSerial}
                  onChange={(e) => setCol(i, { nullable: e.target.checked })}
                  className={tk.checkbox}
                />
                <input type="checkbox" checked={!!c.pk} onChange={(e) => setCol(i, { pk: e.target.checked })} className={tk.checkbox} />
                <button
                  onClick={() => setCols((prev) => prev.filter((_, idx) => idx !== i))}
                  title="Remove column"
                  className="text-zinc-600 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button onClick={() => setCols((prev) => [...prev, emptyCol()])} className={tk.btn2}>
            + column
          </button>
        </div>

        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
      </div>
    </Modal>
  );
}

/* ------------------------------- Add column ------------------------------- */

export function AddColumnModal({
  table,
  enums,
  onClose,
  onDone,
}: {
  table: string;
  enums: Record<string, string[]>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [col, setColState] = useState<ColRow>(emptyCol());
  const setCol = (patch: Partial<ColRow>) => setColState((prev) => ({ ...prev, ...patch }));

  const ready = col.name.trim().length > 0;
  const params = {
    table,
    column: { name: col.name.trim(), type: col.type, nullable: col.nullable, default: col.default?.trim() || undefined },
  };
  const { sql, buildError } = useDdlPreview('addColumn', params, ready);

  return (
    <Modal
      title={<span className="font-mono">add column to {table}</span>}
      onClose={onClose}
      footer={<ExecuteFooter action="addColumn" params={params} previewSql={sql} onDone={onDone} onClose={onClose} label="Add column" />}
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400">name</label>
          <input autoFocus value={col.name} onChange={(e) => setCol({ name: e.target.value })} className={`${tk.input} mt-0.5 w-full font-mono`} />
        </div>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="text-[11px] font-medium text-zinc-400">type</label>
            <select value={col.type} onChange={(e) => setCol({ type: e.target.value })} className={`${tk.select} mt-0.5 w-full`}>
              {typeOptions(enums).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1.5 pb-1 text-xs text-zinc-400">
            <input type="checkbox" checked={col.nullable} onChange={(e) => setCol({ nullable: e.target.checked })} className={tk.checkbox} />
            nullable
          </label>
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">default (optional)</label>
          <input
            value={col.default ?? ''}
            onChange={(e) => setCol({ default: e.target.value })}
            placeholder="now() / 'str' / 0 / true"
            className={`${tk.input} mt-0.5 w-full font-mono`}
          />
          <p className={`mt-1 text-[10px] ${tk.faint}`}>
            Adding a NOT NULL column to a non-empty table requires a default.
          </p>
        </div>
        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
      </div>
    </Modal>
  );
}

/* ------------------------------- Join table ------------------------------- */

export function JoinTableModal({
  tables,
  onClose,
  onDone,
}: {
  tables: SchemaTable[];
  onClose: () => void;
  onDone: () => void;
}) {
  const eligible = tables.filter((t) => t.pk);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [name, setName] = useState('');

  const suggested = a && b ? `${a}_${b}` : '';
  const ready = !!a && !!b && a !== b;
  const params = { tableA: a, tableB: b, name: name.trim() || undefined };
  const { sql, buildError } = useDdlPreview('createJoinTable', params, ready);

  return (
    <Modal
      title="New join table (many-to-many)"
      onClose={onClose}
      width="max-w-2xl"
      footer={<ExecuteFooter action="createJoinTable" params={params} previewSql={sql} onDone={onDone} onClose={onClose} label="Create join table" />}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-[11px] font-medium text-zinc-400">table A</label>
            <select value={a} onChange={(e) => setA(e.target.value)} className={`${tk.select} mt-0.5 w-full font-mono`}>
              <option value="">—</option>
              {eligible.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.pk})
                </option>
              ))}
            </select>
          </div>
          <span className={`pt-4 ${tk.muted}`}>⇄</span>
          <div className="flex-1">
            <label className="text-[11px] font-medium text-zinc-400">table B</label>
            <select value={b} onChange={(e) => setB(e.target.value)} className={`${tk.select} mt-0.5 w-full font-mono`}>
              <option value="">—</option>
              {eligible.filter((t) => t.name !== a).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.pk})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">join table name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={suggested || 'pick both tables first'}
            className={`${tk.input} mt-0.5 w-full font-mono`}
          />
        </div>
        <p className={`text-[11px] ${tk.muted}`}>
          Creates a composite-PK table with cascading FKs to both sides — rows in it ARE the relationship.
        </p>
        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
      </div>
    </Modal>
  );
}

/* ------------------------------ Confirm (drop) ------------------------------ */

export function ConfirmDdlModal({
  title,
  action,
  params,
  typedConfirmation,
  onClose,
  onDone,
}: {
  title: string;
  action: string;
  params: Record<string, unknown>;
  /** When set, the user must type this exact string to arm the button. */
  typedConfirmation?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState('');
  const { sql, buildError } = useDdlPreview(action, params, true);
  const armed = !typedConfirmation || typed === typedConfirmation;

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <ExecuteFooter action={action} params={params} previewSql={armed ? sql : null} onDone={onDone} onClose={onClose} label="Run it" />
      }
    >
      <div className="space-y-3">
        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
        {typedConfirmation && (
          <div>
            <label className="text-[11px] font-medium text-zinc-400">
              type <span className="font-mono text-red-400">{typedConfirmation}</span> to confirm — this cannot be undone
            </label>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className={`${tk.input} mt-0.5 w-full font-mono`} />
          </div>
        )}
      </div>
    </Modal>
  );
}
