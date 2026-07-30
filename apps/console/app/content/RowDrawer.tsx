'use client';

import { useEffect, useMemo, useState } from 'react';
import { tk } from '@/ui/tokens';
import { type WireRow, cellText, clip, NullMark, fetchJson, SlideOver, Modal, LoadingState } from '@/ui/primitives';
import { type ClientCatalog, type ClientColumn, type ClientTable, labelColumn } from './types';

/** Drawer over a row: view / edit / create, with FK relation picking. */

export type DrawerState = { mode: 'view'; row: WireRow } | { mode: 'edit'; row: WireRow } | { mode: 'new' };

export default function RowDrawer({
  table,
  catalog,
  state,
  onClose,
  onSetState,
  onSaved,
  onDeleted,
  onNavigateFk,
}: {
  table: ClientTable;
  catalog: ClientCatalog;
  state: DrawerState;
  onClose: () => void;
  onSetState: (s: DrawerState) => void;
  onSaved: (row: WireRow) => void;
  onDeleted: () => void;
  onNavigateFk: (refTable: string, refColumn: string, value: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setError(null), [state]);

  const del = async (row: WireRow) => {
    if (!table.pk) return;
    const id = row[table.pk];
    if (!window.confirm(`Delete ${table.name} row ${String(id)}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    const res = await fetchJson('/api/content/row', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: table.name, id }),
    });
    setBusy(false);
    if (res.ok) onDeleted();
    else setError(res.error);
  };

  const title =
    state.mode === 'new' ? `New ${table.name} row` : state.mode === 'edit' ? `Edit ${table.name} row` : `${table.name} row`;

  return (
    <SlideOver title={<span className="font-mono">{title}</span>} onClose={onClose}>
      {state.mode === 'view' ? (
        <>
          <div>
            {table.columns.map((c) => {
              const v = state.row[c.name];
              const d = cellText(v);
              const pretty = !c.masked && !d.isNull && typeof v === 'object' ? JSON.stringify(v, null, 2) : d.text;
              return (
                <div key={c.name} className="border-b border-zinc-800/60 px-4 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                    {c.name}
                    <span className="ml-1.5 normal-case tracking-normal text-zinc-600">{c.type}</span>
                    {c.isPk && <span className={`ml-1.5 ${tk.pk}`}>pk</span>}
                    {c.fkTable && <span className="ml-1.5 font-mono normal-case tracking-normal text-zinc-600">→ {c.fkTable}</span>}
                  </div>
                  <div className="mt-0.5 text-xs">
                    {c.masked ? (
                      <span className="italic text-zinc-600">masked</span>
                    ) : d.isNull ? (
                      <NullMark />
                    ) : (
                      <span className="whitespace-pre-wrap break-all font-mono text-zinc-200">{clip(pretty, 5000)}</span>
                    )}
                    {c.fkTable && c.fkColumn && !c.masked && !d.isNull && (
                      <button
                        onClick={() => onNavigateFk(c.fkTable!, c.fkColumn!, d.text)}
                        className={`ml-2 whitespace-nowrap ${tk.link}`}
                      >
                        → {c.fkTable}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {error && <div className={`m-3 ${tk.err}`}>{error}</div>}
          <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2.5">
            {table.pk && (
              <>
                <button onClick={() => onSetState({ mode: 'edit', row: state.row })} className={tk.btn}>
                  Edit
                </button>
                <button onClick={() => del(state.row)} disabled={busy} className={tk.btnDanger}>
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
              </>
            )}
            <button onClick={onClose} className={`${tk.btn2} ml-auto`}>
              Close
            </button>
          </div>
        </>
      ) : (
        <RowForm
          key={state.mode === 'new' ? 'new' : `edit-${table.pk ? String(state.row[table.pk]) : 'row'}`}
          table={table}
          catalog={catalog}
          mode={state.mode}
          row={state.mode === 'edit' ? state.row : null}
          onCancel={() => (state.mode === 'edit' ? onSetState({ mode: 'view', row: state.row }) : onClose())}
          onSaved={onSaved}
        />
      )}
    </SlideOver>
  );
}

/* ============================== Row form =============================== */

interface FieldState {
  text: string;
  isNull: boolean;
  dirty: boolean;
}

function initialField(c: ClientColumn, row: WireRow | null): FieldState {
  if (!row) return { text: '', isNull: false, dirty: false };
  const v = row[c.name];
  if (v === null || v === undefined) return { text: '', isNull: true, dirty: false };
  if (c.family === 'boolean') return { text: v === true ? 'true' : 'false', isNull: false, dirty: false };
  if (c.family === 'array' && Array.isArray(v)) return { text: v.map(String).join('\n'), isNull: false, dirty: false };
  if (typeof v === 'object') return { text: JSON.stringify(v, null, 2), isNull: false, dirty: false };
  return { text: String(v), isNull: false, dirty: false };
}

/** Wire value for a dirty field — the server casts strings via ::udt. */
function wireValue(c: ClientColumn, f: FieldState): unknown {
  if (f.isNull) return null;
  if (c.family === 'array') {
    return f.text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return f.text;
}

function RowForm({
  table,
  catalog,
  mode,
  row,
  onCancel,
  onSaved,
}: {
  table: ClientTable;
  catalog: ClientCatalog;
  mode: 'edit' | 'new';
  row: WireRow | null;
  onCancel: () => void;
  onSaved: (row: WireRow) => void;
}) {
  // PK: read-only on edit; on create it's an input only when it has no default.
  const editable = useMemo(
    () => table.columns.filter((c) => !c.masked && (!c.isPk || (mode === 'new' && !c.default))),
    [table, mode]
  );
  // On create, defaulted non-PK columns collapse under a toggle — the common case
  // is letting the DB default win.
  const [showDefaulted, setShowDefaulted] = useState(false);
  const primary = mode === 'new' ? editable.filter((c) => !c.default) : editable;
  const defaulted = mode === 'new' ? editable.filter((c) => !!c.default) : [];

  const [fields, setFields] = useState<Record<string, FieldState>>(() => {
    const f: Record<string, FieldState> = {};
    for (const c of editable) f[c.name] = initialField(c, mode === 'edit' ? row : null);
    return f;
  });
  const [pickerFor, setPickerFor] = useState<ClientColumn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setField = (name: string, patch: Partial<FieldState>) => {
    setFields((prev) => ({ ...prev, [name]: { ...prev[name], ...patch, dirty: true } }));
  };

  const submit = async () => {
    const dirtyCols = editable.filter((c) => fields[c.name]?.dirty);
    if (!dirtyCols.length) {
      setError(mode === 'edit' ? 'No changes to save' : 'No values entered');
      return;
    }
    const values: Record<string, unknown> = {};
    for (const c of dirtyCols) values[c.name] = wireValue(c, fields[c.name]);

    setSaving(true);
    setError(null);
    const res = await fetchJson<{ row?: WireRow }>('/api/content/row', {
      method: mode === 'edit' ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        mode === 'edit' ? { table: table.name, id: table.pk && row ? row[table.pk] : undefined, values } : { table: table.name, values }
      ),
    });
    setSaving(false);
    if (!res.ok) setError(res.error);
    else if (res.data.row) onSaved(res.data.row);
    else setError('Malformed response');
  };

  const renderInput = (c: ClientColumn) => {
    const f = fields[c.name];
    if (!f) return null;

    if (c.fkTable && c.fkColumn) {
      return (
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs ${f.isNull ? 'text-zinc-600 italic' : 'text-zinc-200'}`}>
            {f.isNull ? 'NULL' : f.text || '—'}
          </span>
          <button type="button" onClick={() => setPickerFor(c)} className={tk.btn2}>
            Pick…
          </button>
          {c.nullable && (
            <button type="button" onClick={() => setField(c.name, { isNull: true, text: '' })} className={tk.btn2}>
              ∅
            </button>
          )}
        </div>
      );
    }

    switch (c.family) {
      case 'boolean':
        return (
          <select
            disabled={f.isNull}
            value={f.text}
            onChange={(e) => setField(c.name, { text: e.target.value })}
            className={`${tk.select} mt-0.5 w-full`}
          >
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        );
      case 'enum':
        return (
          <select
            disabled={f.isNull}
            value={f.text}
            onChange={(e) => setField(c.name, { text: e.target.value })}
            className={`${tk.select} mt-0.5 w-full`}
          >
            <option value="">—</option>
            {(c.enumValues ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        );
      case 'json':
        return (
          <textarea
            disabled={f.isNull}
            rows={3}
            value={f.text}
            onChange={(e) => setField(c.name, { text: e.target.value })}
            placeholder="JSON"
            className={`${tk.input} mt-0.5 w-full resize-y font-mono`}
          />
        );
      case 'array':
        return (
          <textarea
            disabled={f.isNull}
            rows={3}
            value={f.text}
            onChange={(e) => setField(c.name, { text: e.target.value })}
            placeholder="one item per line"
            className={`${tk.input} mt-0.5 w-full resize-y font-mono`}
          />
        );
      default:
        return (
          <input
            type="text"
            disabled={f.isNull}
            value={f.text}
            onChange={(e) => setField(c.name, { text: e.target.value })}
            placeholder={c.family === 'date' ? 'YYYY-MM-DD' : c.family === 'datetime' ? 'YYYY-MM-DDTHH:MM:SSZ' : ''}
            className={`${tk.input} mt-0.5 w-full font-mono`}
          />
        );
    }
  };

  const renderField = (c: ClientColumn) => {
    const f = fields[c.name];
    if (!f) return null;
    return (
      <div key={c.name}>
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-medium text-zinc-400">
            {c.name}
            <span className="ml-1 font-normal text-zinc-600">
              {c.type}
              {c.nullable ? ' · nullable' : ''}
              {c.default ? ` · default ${clip(c.default, 24)}` : ''}
            </span>
          </label>
          {c.nullable && (
            <label className="flex items-center gap-1 text-[10px] text-zinc-500">
              <input
                type="checkbox"
                checked={f.isNull}
                onChange={(e) => setField(c.name, { isNull: e.target.checked })}
                className={tk.checkbox}
              />
              null
            </label>
          )}
        </div>
        {renderInput(c)}
      </div>
    );
  };

  return (
    <>
      <div className="space-y-3 p-4">
        {mode === 'edit' && table.pk && row && (
          <div>
            <div className="text-[11px] font-medium text-zinc-400">
              {table.pk} <span className="font-normal text-zinc-600">(primary key, read-only)</span>
            </div>
            <div className="mt-0.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-400">
              {String(row[table.pk])}
            </div>
          </div>
        )}
        {primary.map(renderField)}
        {defaulted.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowDefaulted((s) => !s)} className={`text-[11px] ${tk.link}`}>
              {showDefaulted ? '▾' : '▸'} {defaulted.length} defaulted column{defaulted.length === 1 ? '' : 's'}
            </button>
            {showDefaulted && <div className="mt-2 space-y-3">{defaulted.map(renderField)}</div>}
          </div>
        )}
      </div>
      {error && <div className={`mx-4 mb-2 ${tk.err} whitespace-pre-wrap`}>{error}</div>}
      <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2.5">
        <button onClick={submit} disabled={saving} className={tk.btn}>
          {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create row'}
        </button>
        <button onClick={onCancel} disabled={saving} className={tk.btn2}>
          Cancel
        </button>
      </div>

      {pickerFor && pickerFor.fkTable && (
        <RelationPicker
          column={pickerFor}
          catalog={catalog}
          onPick={(v) => {
            setField(pickerFor.name, { text: v, isNull: false });
            setPickerFor(null);
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </>
  );
}

/* =========================== Relation picker =========================== */

function RelationPicker({
  column,
  catalog,
  onPick,
  onClose,
}: {
  column: ClientColumn;
  catalog: ClientCatalog;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const target = catalog.tables.find((t) => t.name === column.fkTable);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<WireRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const label = target ? labelColumn(target) : null;
  const showCols = useMemo(() => {
    if (!target) return [];
    const visible = target.columns.filter((c) => !c.masked);
    const pk = visible.filter((c) => c.isPk);
    const rest = visible.filter((c) => !c.isPk).slice(0, 3);
    return [...pk, ...rest];
  }, [target]);

  useEffect(() => {
    if (!target || !column.fkColumn) return;
    let cancelled = false;
    setLoading(true);
    const p = new URLSearchParams({ table: target.name, page: '1', pageSize: '20' });
    // Search against the label-ish column; fall back to the referenced column.
    if (q.trim()) p.append('f', `${label ?? column.fkColumn}:contains:${q.trim()}`);
    const t = setTimeout(() => {
      fetchJson<{ rows: WireRow[]; total: number }>(`/api/content/rows?${p.toString()}`).then((r) => {
        if (cancelled) return;
        setLoading(false);
        if (r.ok) {
          setRows(r.data.rows);
          setTotal(r.data.total);
          setError(null);
        } else setError(r.error);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, target, column.fkColumn, label]);

  if (!target || !column.fkColumn) return null;

  return (
    <Modal title={<span className="font-mono">{`pick ${column.fkTable}.${column.fkColumn} for ${column.name}`}</span>} onClose={onClose} width="max-w-2xl">
      <input
        autoFocus
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={label ? `Search ${label}…` : 'Search…'}
        className={`${tk.input} mb-3 w-full`}
      />
      {error ? (
        <div className={tk.err}>{error}</div>
      ) : loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <div className="p-4 text-center text-xs text-zinc-600">No matches</div>
      ) : (
        <div className="overflow-x-auto">
          <table className={tk.table}>
            <thead>
              <tr>
                {showCols.map((c) => (
                  <th key={c.name} className={tk.th}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const refVal = cellText(row[column.fkColumn!]);
                return (
                  <tr key={i} onClick={() => !refVal.isNull && onPick(refVal.text)} className={tk.trClickable}>
                    {showCols.map((c) => {
                      const d = cellText(row[c.name]);
                      return (
                        <td key={c.name} className={tk.td}>
                          {d.isNull ? <NullMark /> : <span className={c.isPk ? 'font-mono' : ''}>{clip(d.text, 80)}</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={`mt-2 text-[11px] ${tk.muted}`}>
            {rows.length} of {total} — click a row to pick
          </div>
        </div>
      )}
    </Modal>
  );
}
