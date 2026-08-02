'use client';

import { useRef } from 'react';
import { tk } from '@/ui/tokens';
import type { ClientTable } from '../content/types';
import { type DraftField, type ColumnField, type RelationField, type ManyToManyField, fieldKeyOf, fieldKind, WIDGETS } from './types';

/**
 * One field in the builder.
 *
 * Collapsed it is a checkbox, a name and a widget — enough to scan twenty fields.
 * Expanded it shows the things a person actually decides: label, help text, and
 * for a relation, WHICH COLUMN OF THE OTHER TABLE TO SHOW. That last one is the
 * only decision the console genuinely cannot make for you, so it gets a control
 * of its own rather than hiding among the rest.
 *
 * Reordering works two ways on purpose. Dragging is what anyone reaches for when
 * moving a field across twenty others; the arrows stay because drag-and-drop is
 * pointer-only and unusable from a keyboard.
 */
export default function FieldRow({
  draft,
  index,
  count,
  tables,
  expanded,
  dragging,
  dropEdge,
  onToggleExpand,
  onChange,
  onMove,
  onDragStart,
  onDragOverRow,
  onDrop,
  onDragEnd,
}: {
  draft: DraftField;
  index: number;
  count: number;
  tables: ClientTable[];
  expanded: boolean;
  /** This row is the one being dragged — dimmed so the gap it leaves is legible. */
  dragging: boolean;
  /** Where the insertion line goes if the drop lands here, or null for no line. */
  dropEdge: 'top' | 'bottom' | null;
  onToggleExpand: () => void;
  onChange: (next: DraftField) => void;
  onMove: (delta: number) => void;
  onDragStart: () => void;
  onDragOverRow: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const f = draft.field;
  const key = fieldKeyOf(f);
  const kind = fieldKind(f);

  // A drag only counts if it started on the grip — dragging a label or a help-text
  // input should select text, not reorder the form.
  //
  // A ref, not state: the browser decides whether a drag may begin the instant the
  // pointer passes its threshold, which can be before React has re-rendered with a
  // new `draggable`. So the row stays permanently draggable and dragstart cancels
  // itself when the grip wasn't the origin — a decision that is always current.
  const grip = useRef(false);

  const patchField = (patch: Record<string, unknown>) => onChange({ ...draft, field: { ...f, ...patch } as typeof f });

  const relation = kind === 'relation' ? (f as RelationField) : null;
  const m2m = kind === 'm2m' ? (f as ManyToManyField) : null;
  const targetTable = relation ? tables.find((t) => t.name === relation.relation.table) : m2m ? tables.find((t) => t.name === m2m.farTable) : null;

  return (
    <div
      data-field-row={key}
      draggable
      onDragStart={(e) => {
        const armed = grip.current;
        grip.current = false;
        if (!armed) return e.preventDefault(); // not from the grip — let it be a selection
        // Firefox refuses to start a drag without payload on the dataTransfer.
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', key);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault(); // the default is "refuse the drop"
        e.dataTransfer.dropEffect = 'move';
        onDragOverRow();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={() => {
        grip.current = false;
        onDragEnd();
      }}
      // Pressing the grip and releasing without dragging must not leave it armed.
      onMouseUp={() => {
        grip.current = false;
      }}
      className={`rounded border ${draft.include ? 'border-zinc-700 bg-zinc-900' : 'border-zinc-800/60 bg-zinc-950'} ${
        dragging ? 'opacity-40' : ''
      } ${dropEdge === 'top' ? 'border-t-2 border-t-emerald-500' : ''} ${
        dropEdge === 'bottom' ? 'border-b-2 border-b-emerald-500' : ''
      }`}
    >
      {/* Collapsed row */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span
          data-drag-handle={key}
          onMouseDown={() => {
            grip.current = true;
          }}
          title="Drag to reorder"
          aria-hidden="true"
          className="cursor-grab select-none px-0.5 text-[11px] leading-none text-zinc-600 hover:text-zinc-300 active:cursor-grabbing"
        >
          ⋮⋮
        </span>
        <input
          type="checkbox"
          checked={draft.include}
          onChange={(e) => onChange({ ...draft, include: e.target.checked })}
          title={draft.include ? 'On the screen' : 'Not on the screen'}
          className={tk.checkbox}
        />
        <button onClick={onToggleExpand} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={`truncate font-mono text-xs ${draft.include ? 'text-zinc-200' : 'text-zinc-600'}`}>{key}</span>
          {kind === 'relation' && <span className={tk.badgeAccent}>→ {relation!.relation.table}</span>}
          {kind === 'm2m' && <span className={tk.badgeAccent}>⇄ {m2m!.farTable}</span>}
          {draft.meta && kind === 'column' && <span className={`font-mono text-[10px] ${tk.faint}`}>{draft.meta.type}</span>}
          {f.label && <span className="truncate text-[11px] text-zinc-500">“{f.label}”</span>}
        </button>

        <select
          value={(f as ColumnField).widget ?? ''}
          onChange={(e) => patchField({ widget: e.target.value || undefined })}
          disabled={!draft.include}
          className={`${tk.select} w-28`}
        >
          <option value="">auto</option>
          {WIDGETS[kind].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>

        {/* The keyboard path to the same reorder the grip does with a pointer. */}
        <div className="flex flex-col">
          <button
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move ${key} up`}
            className="px-1 text-[9px] leading-none text-zinc-600 hover:text-zinc-200 disabled:opacity-30"
          >
            ▲
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            aria-label={`Move ${key} down`}
            className="px-1 text-[9px] leading-none text-zinc-600 hover:text-zinc-200 disabled:opacity-30"
          >
            ▼
          </button>
        </div>
        <button onClick={onToggleExpand} className={`text-[10px] ${tk.link}`}>
          {expanded ? '−' : '⋯'}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="space-y-2 border-t border-zinc-800 px-2.5 py-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] uppercase tracking-wide text-zinc-500">label</label>
              <input
                value={f.label ?? ''}
                onChange={(e) => patchField({ label: e.target.value || undefined })}
                placeholder={key.replace(/_id$/, '').replaceAll('_', ' ')}
                className={`${tk.input} mt-0.5 w-full`}
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide text-zinc-500">shown in</label>
              <select
                value={(f.in ?? ['list', 'form']).join(',')}
                onChange={(e) => patchField({ in: e.target.value.split(',') })}
                className={`${tk.select} mt-0.5 w-full`}
              >
                <option value="list,form">list and form</option>
                <option value="form">form only</option>
                <option value="list">list only</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-zinc-500">help text</label>
            <input
              value={f.help ?? ''}
              onChange={(e) => patchField({ help: e.target.value || undefined })}
              placeholder={draft.inheritedHelp ?? 'shown under the input'}
              className={`${tk.input} mt-0.5 w-full`}
            />
            {draft.inheritedHelp && !f.help && (
              // The comment already reaches the screen; copying it into the file would
              // create a second copy to keep in sync.
              <p className={`mt-0.5 text-[10px] ${tk.faint}`}>Inherited from the column description — leave empty to keep it in sync.</p>
            )}
          </div>

          {/* THE decision the console can't make for you. */}
          {(relation || m2m) && targetTable && (
            <div className="rounded border border-emerald-900/60 bg-emerald-950/20 p-2">
              <label className="text-[10px] uppercase tracking-wide text-emerald-400">show which column of {targetTable.name}?</label>
              <select
                value={(relation ? relation.relation.display : m2m!.display) ?? ''}
                onChange={(e) => {
                  const v = e.target.value || undefined;
                  if (relation) patchField({ relation: { ...relation.relation, display: v } });
                  else patchField({ display: v });
                }}
                className={`${tk.select} mt-0.5 w-full font-mono`}
              >
                <option value="">{`the raw ${relation ? relation.relation.value ?? 'id' : m2m!.farValue ?? 'id'} (not friendly)`}</option>
                {targetTable.columns
                  .filter((c) => !c.masked)
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <p className={`mt-1 text-[10px] ${tk.faint}`}>
                The database stores an id; this is what a person sees. A template like{' '}
                <span className="font-mono">{'{first_name} {last_name}'}</span> works too — type it into the file.
              </p>
            </div>
          )}

          {m2m && (
            <div className={`text-[10px] ${tk.faint}`}>
              via <span className="font-mono text-zinc-400">{m2m.through}</span> ({m2m.near} → {m2m.far})
            </div>
          )}

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              <input type="checkbox" checked={!!f.readOnly} onChange={(e) => patchField({ readOnly: e.target.checked || undefined })} className={tk.checkbox} />
              read-only
            </label>
            {draft.meta && (
              <span className={`text-[10px] ${tk.faint}`}>
                {draft.meta.nullable ? 'nullable' : 'NOT NULL → required'}
                {draft.meta.isPk ? ' · primary key' : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
