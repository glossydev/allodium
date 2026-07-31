'use client';

import { useMemo, useState } from 'react';
import { tk } from '@/ui/tokens';
import { Modal, SqlPreview, EmptyState } from '@/ui/primitives';
import { useDdlPreview, ExecuteFooter } from './builders';
import type { SchemaTable } from './SchemaBrowser';

/**
 * Enum types — the third thing a schema builder needs and the one most likely to
 * send you to psql: you could USE an enum before this existed, but only if it
 * already happened to exist.
 *
 * Postgres caveats surfaced rather than hidden:
 *  - values can be added and renamed, but NOT removed (there is no DROP VALUE);
 *  - position matters, because ORDER BY on an enum column sorts by definition
 *    order, so new values can be inserted before an existing one;
 *  - a type in use by any column cannot be dropped — so usage is shown up front.
 */
export default function TypesPanel({
  enums,
  tables,
  onChanged,
}: {
  enums: Record<string, string[]>;
  tables: SchemaTable[];
  onChanged: () => void;
}) {
  const [modal, setModal] = useState<
    | { kind: 'create' }
    | { kind: 'addValue'; type: string }
    | { kind: 'renameValue'; type: string; from: string }
    | { kind: 'drop'; type: string }
    | null
  >(null);

  /** Which columns use each enum — drives both the usage list and drop safety. */
  const usage = useMemo(() => {
    const m = new Map<string, { table: string; column: string }[]>();
    for (const t of tables) {
      for (const c of t.columns) {
        if (c.family !== 'enum') continue;
        const key = c.udtName;
        (m.get(key) ?? m.set(key, []).get(key)!).push({ table: t.name, column: c.name });
      }
    }
    return m;
  }, [tables]);

  const names = Object.keys(enums).sort();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={tk.toolbar}>
        <span className={`text-xs ${tk.muted}`}>{names.length} enum types</span>
        <button onClick={() => setModal({ kind: 'create' })} className={`${tk.btn} ml-auto`}>
          + New enum
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {names.length === 0 ? (
          <EmptyState>
            No enum types yet.{' '}
            <span className="text-zinc-500">An enum is a good fit for a small fixed set — status, tier, visibility.</span>
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {names.map((name) => {
              const used = usage.get(name) ?? [];
              return (
                <div key={name} className={`rounded border ${tk.panel} p-3`}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-emerald-300">{name}</span>
                    <span className={tk.badge}>{enums[name].length} values</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <button onClick={() => setModal({ kind: 'addValue', type: name })} className={tk.btn2}>
                        + Value
                      </button>
                      <button
                        onClick={() => setModal({ kind: 'drop', type: name })}
                        disabled={used.length > 0}
                        title={used.length ? `In use by ${used.map((u) => `${u.table}.${u.column}`).join(', ')}` : undefined}
                        className={tk.btnDanger}
                      >
                        Drop
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {enums[name].map((v, i) => (
                      <button
                        key={v}
                        onClick={() => setModal({ kind: 'renameValue', type: name, from: v })}
                        title="Rename this value"
                        className={`${tk.badge} font-mono hover:border-emerald-600 hover:text-emerald-300`}
                      >
                        {i + 1}. {v}
                      </button>
                    ))}
                  </div>

                  <div className={`mt-2 text-[10px] ${tk.faint}`}>
                    {used.length === 0 ? (
                      'Not used by any column.'
                    ) : (
                      <>used by {used.map((u) => `${u.table}.${u.column}`).join(', ')}</>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={tk.footer}>
        Postgres has no DROP VALUE — a value can be added or renamed, never removed. Order defines how an enum column sorts.
      </div>

      {modal?.kind === 'create' && <CreateEnumModal onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
      {modal?.kind === 'addValue' && (
        <AddValueModal
          type={modal.type}
          existing={enums[modal.type]}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); onChanged(); }}
        />
      )}
      {modal?.kind === 'renameValue' && (
        <RenameValueModal
          type={modal.type}
          from={modal.from}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); onChanged(); }}
        />
      )}
      {modal?.kind === 'drop' && (
        <DropEnumModal type={modal.type} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />
      )}
    </div>
  );
}

/* -------------------------------- modals -------------------------------- */

function CreateEnumModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [raw, setRaw] = useState('');
  const values = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  const params = { name: name.trim(), values };
  const { sql, buildError } = useDdlPreview('createEnum', params, !!name.trim() && values.length > 0);

  return (
    <Modal
      title="New enum type"
      onClose={onClose}
      footer={<ExecuteFooter action="createEnum" params={params} previewSql={sql} onDone={onDone} onClose={onClose} label="Create type" />}
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400">type name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="order_status" className={`${tk.input} mt-0.5 w-full font-mono`} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">values — one per line, in sort order</label>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={5}
            placeholder={'draft\npublished\narchived'}
            className={`${tk.input} mt-0.5 w-full resize-y font-mono`}
          />
        </div>
        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
      </div>
    </Modal>
  );
}

function AddValueModal({
  type,
  existing,
  onClose,
  onDone,
}: {
  type: string;
  existing: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState('');
  const [before, setBefore] = useState('');
  const params = { type, value: value.trim(), before: before || undefined };
  const { sql, buildError } = useDdlPreview('addEnumValue', params, !!value.trim());

  return (
    <Modal
      title={<span className="font-mono">add value to {type}</span>}
      onClose={onClose}
      footer={<ExecuteFooter action="addEnumValue" params={params} previewSql={sql} onDone={onDone} onClose={onClose} label="Add value" />}
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400">value</label>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} className={`${tk.input} mt-0.5 w-full font-mono`} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">position</label>
          <select value={before} onChange={(e) => setBefore(e.target.value)} className={`${tk.select} mt-0.5 w-full font-mono`}>
            <option value="">append at the end</option>
            {existing.map((v) => (
              <option key={v} value={v}>
                before {v}
              </option>
            ))}
          </select>
          <p className={`mt-1 text-[10px] ${tk.faint}`}>Position only matters if you ORDER BY this column.</p>
        </div>
        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
      </div>
    </Modal>
  );
}

function RenameValueModal({ type, from, onClose, onDone }: { type: string; from: string; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState(from);
  const params = { type, from, to: to.trim() };
  const { sql, buildError } = useDdlPreview('renameEnumValue', params, !!to.trim() && to.trim() !== from);

  return (
    <Modal
      title={<span className="font-mono">rename {type}.{from}</span>}
      onClose={onClose}
      footer={<ExecuteFooter action="renameEnumValue" params={params} previewSql={sql} onDone={onDone} onClose={onClose} label="Rename value" />}
    >
      <div className="space-y-3">
        <input autoFocus value={to} onChange={(e) => setTo(e.target.value)} className={`${tk.input} w-full font-mono`} />
        <p className={`text-[10px] ${tk.faint}`}>
          Existing rows follow the rename automatically — the label changes, the stored value is the same enum member.
        </p>
        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
      </div>
    </Modal>
  );
}

function DropEnumModal({ type, onClose, onDone }: { type: string; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const params = { name: type };
  const { sql, buildError } = useDdlPreview('dropEnum', params, true);

  return (
    <Modal
      title={<span className="font-mono">drop type {type}</span>}
      onClose={onClose}
      footer={<ExecuteFooter action="dropEnum" params={params} previewSql={typed === type ? sql : null} onDone={onDone} onClose={onClose} label="Drop type" />}
    >
      <div className="space-y-3">
        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
        <div>
          <label className="text-[11px] font-medium text-zinc-400">
            type <span className="font-mono text-red-400">{type}</span> to confirm
          </label>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className={`${tk.input} mt-0.5 w-full font-mono`} />
        </div>
      </div>
    </Modal>
  );
}
