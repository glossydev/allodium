'use client';

import { useCallback, useEffect, useState } from 'react';
import { tk } from '@/ui/tokens';
import { Modal, SqlPreview } from '@/ui/primitives';
import { previewDdl, executeDdlAction, typeOptions, type DdlColumnSpec } from './ddl-client';
import type { SchemaTable } from './SchemaBrowser';

/**
 * Builder modals. Shared shape: edit inputs → live SQL preview (debounced round
 * trip to the builder API) → Execute → verbatim pg error inline on failure.
 * The preview IS the trust mechanism — never hide what will run.
 */

function useDdlPreview(action: string, params: Record<string, unknown>, ready: boolean) {
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

function ExecuteFooter({
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

interface ColRow extends DdlColumnSpec {
  preset?: 'serial' | 'uuid' | '';
}

const emptyCol = (): ColRow => ({ name: '', type: 'text', nullable: true, default: '', pk: false, preset: '' });

export function CreateTableModal({
  enums,
  onClose,
  onDone,
}: {
  enums: Record<string, string[]>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [cols, setCols] = useState<ColRow[]>([
    { name: 'id', type: 'serial', nullable: false, default: '', pk: true, preset: 'serial' },
    emptyCol(),
  ]);

  const setCol = (i: number, patch: Partial<ColRow>) =>
    setCols((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const applyPreset = (i: number, preset: ColRow['preset']) => {
    if (preset === 'serial') setCol(i, { preset, type: 'serial', nullable: false, default: '', pk: true });
    else if (preset === 'uuid') setCol(i, { preset, type: 'uuid', nullable: false, default: 'gen_random_uuid()', pk: true });
    // Clearing the preset must also drop the type it forced — otherwise the select
    // loses its `serial` option and displays `text` while the SQL still said serial.
    else setCol(i, { preset, type: cols[i]?.type === 'serial' ? 'integer' : cols[i]?.type });
  };

  const specCols = cols
    .filter((c) => c.name.trim())
    .map(({ preset: _p, ...c }) => ({ ...c, default: c.default?.trim() ? c.default.trim() : undefined }));
  const ready = name.trim().length > 0 && specCols.length > 0;
  const params = { name: name.trim(), columns: specCols };
  const { sql, buildError } = useDdlPreview('createTable', params, ready);

  return (
    <Modal
      title="New table"
      onClose={onClose}
      width="max-w-3xl"
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
          <div className="grid grid-cols-[1fr_1fr_90px_1fr_36px_36px_24px] gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            <span>name</span>
            <span>type</span>
            <span>preset</span>
            <span>default</span>
            <span>null</span>
            <span>pk</span>
            <span />
          </div>
          {cols.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_90px_1fr_36px_36px_24px] items-center gap-1.5">
              <input value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} placeholder="column" className={`${tk.input} font-mono`} />
              <select
                value={c.type}
                onChange={(e) => setCol(i, { type: e.target.value, preset: '' })}
                className={tk.select}
                disabled={c.preset === 'serial'}
              >
                {c.preset === 'serial' && <option value="serial">serial</option>}
                {typeOptions(enums).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select value={c.preset ?? ''} onChange={(e) => applyPreset(i, e.target.value as ColRow['preset'])} className={tk.select}>
                <option value="">—</option>
                <option value="serial">serial pk</option>
                <option value="uuid">uuid pk</option>
              </select>
              <input
                value={c.type === 'serial' ? '' : (c.default ?? '')}
                onChange={(e) => setCol(i, { default: e.target.value })}
                // serial installs its own nextval default; a second one is a pg error.
                disabled={c.type === 'serial'}
                placeholder={c.type === 'serial' ? 'auto' : "now() / 'str' / 0"}
                className={`${tk.input} font-mono`}
              />
              <input type="checkbox" checked={c.nullable} onChange={(e) => setCol(i, { nullable: e.target.checked })} className={tk.checkbox} />
              <input type="checkbox" checked={!!c.pk} onChange={(e) => setCol(i, { pk: e.target.checked })} className={tk.checkbox} />
              <button onClick={() => setCols((prev) => prev.filter((_, idx) => idx !== i))} className="text-zinc-600 hover:text-red-400">
                ✕
              </button>
            </div>
          ))}
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
