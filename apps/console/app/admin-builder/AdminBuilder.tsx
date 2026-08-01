'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { tk } from '@/ui/tokens';
import { fetchJson, LoadingState, ErrorBox, Modal } from '@/ui/primitives';
import type { ClientCatalog, ClientTable } from '../content/types';
import PreviewPane from './PreviewPane';
import FieldRow from './FieldRow';
import { type Draft, type DraftField, type ViewDefinition, type Field, draftToDefinition, fieldKeyOf } from './types';

/**
 * The Admin Builder — the console writing the artifact its own runtime consumes.
 *
 * Editor on the left, live preview on the right, because the question being
 * answered ("what will operators actually see?") is only answerable by looking.
 * The preview is the real runtime against real data, not a mock, so there is no
 * gap between what you approve here and what ships.
 *
 * Saving writes a .view.json into the repo. It is pruned of everything the runtime
 * would infer, so the file records decisions rather than defaults and a git diff
 * shows what you changed.
 */

interface ViewSummary {
  name: string;
  table: string;
  title: string;
  fieldCount: number;
}

export default function AdminBuilder() {
  const [catalog, setCatalog] = useState<ClientCatalog | null>(null);
  const [views, setViews] = useState<ViewSummary[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedJson, setSavedJson] = useState<string>(''); // for the dirty check
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);

  const refreshViews = useCallback(async () => {
    const r = await fetchJson<{ views: ViewSummary[] }>('/api/admin-views');
    if (r.ok) setViews(r.data.views);
    else setError(r.error);
  }, []);

  useEffect(() => {
    fetchJson<ClientCatalog>('/api/catalog').then((r) => (r.ok ? setCatalog(r.data) : setError(r.error)));
    refreshViews();
  }, [refreshViews]);

  /** Build the editor's working state from a definition plus live column facts. */
  const buildDraft = useCallback(
    async (name: string, definition: ViewDefinition, cat: ClientCatalog): Promise<Draft | null> => {
      const table = cat.tables.find((t) => t.name === definition.table);
      if (!table) {
        setError(`View "${name}" points at a table that no longer exists: ${definition.table}`);
        return null;
      }

      // Start from a full proposal so excluded fields are still listed and can be
      // put back — the file only records what is included.
      const proposal = await fetchJson<{ definition: ViewDefinition }>(`/api/admin-views/propose?table=${encodeURIComponent(definition.table)}`);
      const candidates: Field[] = proposal.ok ? (proposal.data.definition.fields ?? []) : [];

      const chosen = new Map((definition.fields ?? []).map((f) => [fieldKeyOf(f), f]));
      const ordered: DraftField[] = [];

      // Included fields first, in the definition's order.
      for (const f of definition.fields ?? []) {
        const col = table.columns.find((c) => c.name === fieldKeyOf(f));
        ordered.push({
          include: true,
          field: f,
          inheritedHelp: col?.comment ?? null,
          meta: col ? { type: col.type, family: col.family, nullable: col.nullable, isPk: col.isPk } : undefined,
        });
      }
      // Then everything available but not used.
      for (const c of candidates) {
        const key = fieldKeyOf(c);
        if (chosen.has(key)) continue;
        const col = table.columns.find((x) => x.name === key);
        ordered.push({
          include: false,
          field: c,
          inheritedHelp: col?.comment ?? null,
          meta: col ? { type: col.type, family: col.family, nullable: col.nullable, isPk: col.isPk } : undefined,
        });
      }

      return {
        name,
        table: definition.table,
        title: definition.title ?? '',
        description: definition.description ?? '',
        display: definition.display ?? '',
        fields: ordered,
        listColumns: definition.list?.columns ?? [],
        pageSize: definition.list?.pageSize ?? 25,
        searchColumns: definition.list?.searchColumns ?? [],
      };
    },
    []
  );

  const openView = useCallback(
    async (name: string) => {
      if (!catalog) return;
      setError(null);
      setNotice(null);
      const r = await fetchJson<{ definition: ViewDefinition }>(`/api/admin-views/${name}`);
      if (!r.ok) return setError(r.error);
      const d = await buildDraft(name, r.data.definition, catalog);
      if (d) {
        setDraft(d);
        setSavedJson(JSON.stringify(draftToDefinition(d)));
      }
    },
    [catalog, buildDraft]
  );

  // Open the first view once everything has loaded.
  useEffect(() => {
    if (catalog && views && views.length && !draft) void openView(views[0].name);
  }, [catalog, views, draft, openView]);

  const startNew = useCallback(
    async (table: string, name: string) => {
      if (!catalog) return;
      setCreating(false);
      setError(null);
      const r = await fetchJson<{ definition: ViewDefinition }>(`/api/admin-views/propose?table=${encodeURIComponent(table)}`);
      if (!r.ok) return setError(r.error);
      const d = await buildDraft(name, r.data.definition, catalog);
      if (d) {
        setDraft(d);
        setSavedJson(''); // never saved, so always dirty
        setNotice(`Draft for ${table} — nothing written yet.`);
      }
    },
    [catalog, buildDraft]
  );

  const definition = useMemo(() => (draft ? draftToDefinition(draft) : null), [draft]);
  const dirty = definition ? JSON.stringify(definition) !== savedJson : false;

  const save = async () => {
    if (!draft || !definition) return;
    setBusy(true);
    setError(null);
    const r = await fetchJson<{ definition: ViewDefinition; warnings: string[] }>(`/api/admin-views/${draft.name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSavedJson(JSON.stringify(definition));
    setNotice(
      `Saved admin/views/${draft.name}.view.json` + (r.data.warnings?.length ? ` — ${r.data.warnings.length} warning(s)` : '')
    );
    setPreviewNonce((n) => n + 1);
    refreshViews();
  };

  const patchField = (index: number, next: DraftField) =>
    setDraft((d) => (d ? { ...d, fields: d.fields.map((f, i) => (i === index ? next : f)) } : d));

  const moveField = (index: number, delta: number) =>
    setDraft((d) => {
      if (!d) return d;
      const to = index + delta;
      if (to < 0 || to >= d.fields.length) return d;
      const fields = [...d.fields];
      [fields[index], fields[to]] = [fields[to], fields[index]];
      return { ...d, fields };
    });

  if (error && !catalog) return <ErrorBox error={error} />;
  if (!catalog || !views) return <LoadingState />;

  const included = draft?.fields.filter((f) => f.include) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className={tk.toolbar}>
        <select
          value={draft?.name ?? ''}
          onChange={(e) => openView(e.target.value)}
          className={`${tk.select} font-mono`}
        >
          {views.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}.view.json
            </option>
          ))}
          {draft && !views.some((v) => v.name === draft.name) && <option value={draft.name}>{draft.name}.view.json (new)</option>}
        </select>
        <button onClick={() => setCreating(true)} className={tk.btn2}>
          + New view
        </button>
        {notice && <span className={`text-[11px] ${tk.accent}`}>{notice}</span>}
        {error && <span className={`text-[11px] text-red-400`}>{error}</span>}
        <button onClick={save} disabled={!draft || !dirty || busy} className={`${tk.btn} ml-auto`}>
          {busy ? 'Saving…' : dirty ? 'Save to file' : 'Saved'}
        </button>
      </div>

      {draft ? (
        <div className="flex min-h-0 flex-1">
          {/* ---------------------------- editor ---------------------------- */}
          <div className="flex w-[46%] min-w-0 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 p-3">
            <div className="mb-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] uppercase tracking-wide text-zinc-500">title</label>
                  <input
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder={draft.table}
                    className={`${tk.input} mt-0.5 w-full`}
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wide text-zinc-500">
                    row label — how this table appears elsewhere
                  </label>
                  <select
                    value={draft.display}
                    onChange={(e) => setDraft({ ...draft, display: e.target.value })}
                    className={`${tk.select} mt-0.5 w-full font-mono`}
                  >
                    <option value="">— none —</option>
                    {(catalog.tables.find((t) => t.name === draft.table)?.columns ?? [])
                      .filter((c) => !c.masked)
                      .map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wide text-zinc-500">description</label>
                <input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder={catalog.tables.find((t) => t.name === draft.table)?.comment ?? 'what this screen is for'}
                  className={`${tk.input} mt-0.5 w-full`}
                />
              </div>
            </div>

            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                fields — {included.length} of {draft.fields.length} on screen
              </span>
              <button onClick={() => setExpanded(null)} className={`ml-auto text-[10px] ${tk.link}`}>
                collapse all
              </button>
            </div>

            <div className="space-y-1">
              {draft.fields.map((f, i) => {
                const key = fieldKeyOf(f.field);
                return (
                  <FieldRow
                    key={key}
                    draft={f}
                    index={i}
                    count={draft.fields.length}
                    tables={catalog.tables as ClientTable[]}
                    expanded={expanded === key}
                    onToggleExpand={() => setExpanded(expanded === key ? null : key)}
                    onChange={(next) => patchField(i, next)}
                    onMove={(delta) => moveField(i, delta)}
                  />
                );
              })}
            </div>

            {/* List behavior */}
            <div className="mt-4 space-y-2 border-t border-zinc-800 pt-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">list screen</span>
              <div>
                <label className={`text-[10px] ${tk.muted}`}>columns (leave empty for the first few)</label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {included
                    .filter((f) => f.field.kind !== 'm2m')
                    .map((f) => {
                      const key = fieldKeyOf(f.field);
                      const on = draft.listColumns.includes(key);
                      return (
                        <button
                          key={key}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              listColumns: on ? draft.listColumns.filter((c) => c !== key) : [...draft.listColumns, key],
                            })
                          }
                          className={on ? tk.badgeAccent : tk.badge}
                        >
                          {key}
                        </button>
                      );
                    })}
                </div>
              </div>
              <div>
                <label className={`text-[10px] ${tk.muted}`}>searchable columns</label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {included
                    .filter((f) => f.meta?.family === 'string')
                    .map((f) => {
                      const key = fieldKeyOf(f.field);
                      const on = draft.searchColumns.includes(key);
                      return (
                        <button
                          key={key}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              searchColumns: on ? draft.searchColumns.filter((c) => c !== key) : [...draft.searchColumns, key],
                            })
                          }
                          className={on ? tk.badgeAccent : tk.badge}
                        >
                          {key}
                        </button>
                      );
                    })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className={`text-[10px] ${tk.muted}`}>rows per page</label>
                <input
                  type="number"
                  value={draft.pageSize}
                  onChange={(e) => setDraft({ ...draft, pageSize: Number(e.target.value) || 25 })}
                  className={`${tk.input} w-20`}
                />
              </div>
            </div>

            {/* The artifact itself — no hiding what gets written. */}
            <details className="mt-4">
              <summary className={`cursor-pointer text-[10px] uppercase tracking-wide ${tk.muted}`}>
                {draft.name}.view.json — what gets written
              </summary>
              <pre className="mt-1.5 overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-emerald-200">
                {JSON.stringify(definition, null, 2)}
              </pre>
            </details>
          </div>

          {/* ---------------------------- preview ---------------------------- */}
          <PreviewPane name={draft.name} dirty={dirty} nonce={previewNonce} exists={views.some((v) => v.name === draft.name)} />
        </div>
      ) : views.length > 0 ? (
        // Views exist and one is being opened. Showing the empty state here would
        // claim there are none — which is simply untrue, and the load can take a
        // few seconds on a cold route.
        <LoadingState />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <p className={`text-xs ${tk.muted}`}>No admin screens yet.</p>
          <button onClick={() => setCreating(true)} className={tk.btn}>
            + Build your first admin screen
          </button>
        </div>
      )}

      {creating && <NewViewModal tables={catalog.tables} existing={views.map((v) => v.name)} onClose={() => setCreating(false)} onCreate={startNew} />}
    </div>
  );
}

/* ------------------------------ new view ------------------------------- */

function NewViewModal({
  tables,
  existing,
  onClose,
  onCreate,
}: {
  tables: ClientTable[];
  existing: string[];
  onClose: () => void;
  onCreate: (table: string, name: string) => void;
}) {
  const [table, setTable] = useState('');
  const [name, setName] = useState('');
  const taken = existing.includes(name.trim());

  return (
    <Modal
      title="New admin screen"
      onClose={onClose}
      footer={
        <>
          <button onClick={() => onCreate(table, name.trim() || table)} disabled={!table || taken} className={tk.btn}>
            Build it
          </button>
          <button onClick={onClose} className={tk.btn2}>
            Cancel
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400">table</label>
          <select
            autoFocus
            value={table}
            onChange={(e) => {
              setTable(e.target.value);
              if (!name) setName(e.target.value);
            }}
            className={`${tk.select} mt-0.5 w-full font-mono`}
          >
            <option value="">— choose a table —</option>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">file name</label>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className={`font-mono text-[11px] ${tk.faint}`}>admin/views/</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${tk.input} flex-1 font-mono`} />
            <span className={`font-mono text-[11px] ${tk.faint}`}>.view.json</span>
          </div>
          {taken && <p className={`mt-1 ${tk.err}`}>A view with that name already exists.</p>}
        </div>
        <p className={`text-[11px] ${tk.muted}`}>
          Every column starts included, foreign keys get a guessed display column, and any many-to-many is detected. Edit
          from there.
        </p>
      </div>
    </Modal>
  );
}
