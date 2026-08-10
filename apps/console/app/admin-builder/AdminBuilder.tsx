'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { humanize } from '@allodium/admin/view';
import { tk } from '@/ui/tokens';
import { fetchJson, LoadingState, ErrorBox, Modal } from '@/ui/primitives';
import type { ClientCatalog, ClientTable } from '../content/types';
import PreviewPane from './PreviewPane';
import FieldRow from './FieldRow';
import { type Draft, type DraftField, type ViewDefinition, type Field, draftToDefinition, fieldKeyOf, fieldKind } from './types';

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
  const [schemaRef, setSchemaRef] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedJson, setSavedJson] = useState<string>(''); // for the dirty check
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * `sticky` survives the view-open that follows it. Deleting hands off to the
   * open-next-view effect, which would otherwise wipe the "Deleted …" line before
   * anyone read it — and in dev that effect runs twice, so any one-shot flag loses.
   */
  const [notice, setNotice] = useState<{ text: string; sticky?: boolean } | null>(null);
  const [creating, setCreating] = useState<{ table?: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const refreshViews = useCallback(async () => {
    const r = await fetchJson<{ views: ViewSummary[]; schemaRef: string }>('/api/admin-views');
    if (r.ok) {
      setViews(r.data.views);
      setSchemaRef(r.data.schemaRef);
    } else setError(r.error);
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

      // No `fields` key does NOT mean "no fields" — the runtime reads it as every
      // visible column (resolver: `def.fields ?? impliedFields(meta)`). Showing
      // them all unchecked would have the editor claim an empty screen while the
      // preview beside it renders a full one.
      const implicitFields = definition.fields === undefined;

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
          include: implicitFields,
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
        related: definition.related ?? [],
        implicitFields,
        source: definition,
      };
    },
    []
  );

  const openView = useCallback(
    async (name: string) => {
      if (!catalog) return;
      setError(null);
      setNotice((n) => (n?.sticky ? n : null));
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
      setCreating(null);
      setError(null);
      const r = await fetchJson<{ definition: ViewDefinition }>(`/api/admin-views/propose?table=${encodeURIComponent(table)}`);
      if (!r.ok) return setError(r.error);
      const d = await buildDraft(name, r.data.definition, catalog);
      if (d) {
        setDraft(d);
        setSavedJson(''); // never saved, so always dirty
        setNotice({ text: `Draft for ${table} — nothing written yet.` });
      }
    },
    [catalog, buildDraft]
  );

  const definition = useMemo(() => (draft ? draftToDefinition(draft) : null), [draft]);

  /**
   * Foreign keys pointing AT this table, read out of the catalog the console
   * already holds — every other table's outbound keys, filtered to the ones that
   * land here. No new request, and no list for anyone to maintain: add a table
   * with a key to this one and it shows up as a candidate by itself.
   *
   * Declared with the other hooks, ABOVE the loading and error returns below —
   * a hook after a conditional return changes the hook order between renders.
   */
  const inboundKeys = useMemo(() => {
    if (!draft || !catalog) return [];
    return catalog.tables.flatMap((t) =>
      (t.foreignKeysOut ?? [])
        .filter((fk) => fk.refTable === draft.table)
        // A composite primary key is not a reason to hide the panel: the rows
        // list fine, they just cannot be opened. For a join table that is often
        // the point — a user's roles WITH who granted them and when, which the
        // m2m checkbox group cannot show.
        .map((fk) => ({
          table: t.name,
          column: fk.column,
          refColumn: fk.refColumn,
          listOnly: (t.pkColumns?.length ?? 1) !== 1,
        }))
    );
  }, [catalog, draft?.table]);
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
    // The file now carries an explicit list, whatever it had before.
    setDraft((d) => (d ? { ...d, implicitFields: false } : d));
    setNotice({
      text: `Saved admin/views/${draft.name}.view.json` + (r.data.warnings?.length ? ` — ${r.data.warnings.length} warning(s)` : ''),
    });
    setPreviewNonce((n) => n + 1);
    // Awaited: until the list comes back, a newly created view isn't in `views`
    // yet and everything keyed off it — Delete, the picker entry — reads as if
    // the file that was just written does not exist.
    await refreshViews();
  };

  /**
   * Deleting a view deletes a FILE from the repo. That is recoverable through git
   * and nothing else, so it is confirmed by name and never offered for a draft
   * that was never written.
   */
  const destroy = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const r = await fetchJson(`/api/admin-views/${draft.name}`, { method: 'DELETE' });
    setBusy(false);
    setDeleting(false);
    if (!r.ok) return setError(r.error);
    setNotice({ text: `Deleted admin/views/${draft.name}.view.json`, sticky: true });
    // Drop the draft and let the open-first-view effect pick whatever remains.
    // The refreshed list no longer contains this name, so it cannot reopen it.
    setDraft(null);
    setSavedJson('');
    await refreshViews();
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

  /** Lift out and re-insert — a swap would be wrong for any drop beyond a neighbour. */
  const reorderField = (from: number, to: number) =>
    setDraft((d) => {
      if (!d || from === to) return d;
      const fields = [...d.fields];
      const [moved] = fields.splice(from, 1);
      fields.splice(to, 0, moved);
      return { ...d, fields };
    });

  if (error && !catalog) return <ErrorBox error={error} />;
  if (!catalog || !views) return <LoadingState />;

  const included = draft?.fields.filter((f) => f.include) ?? [];

  // Does a file back this draft? Read from savedJson, which is set the moment a
  // save succeeds — not from `views`, which is refetched afterwards and so reports
  // "never written" for a beat about a file that demonstrably exists.
  const onDisk = savedJson !== '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className={tk.toolbar}>
        <select
          value={draft?.name ?? ''}
          // Clear explicitly: choosing a different view is the point at which a
          // sticky "Deleted …" line stops being news.
          onChange={(e) => {
            setNotice(null);
            openView(e.target.value);
          }}
          className={`${tk.select} font-mono`}
        >
          {views.map((v) => (
            <option key={v.name} value={v.name}>
              {/* The heading operators will see, when it isn't just the file name
                  again — a file called cs-orders is worth labelling "Customer
                  Orders" in the picker. */}
              {v.name}.view.json{v.title && v.title !== humanize(v.name) ? ` — ${v.title}` : ''}
            </option>
          ))}
          {draft && !views.some((v) => v.name === draft.name) && <option value={draft.name}>{draft.name}.view.json (new)</option>}
        </select>
        <button onClick={() => setCreating({})} className={tk.btn2}>
          + New view
        </button>
        {notice && <span className={`text-[11px] ${tk.accent}`}>{notice.text}</span>}
        {error && <span className={`text-[11px] text-red-400`}>{error}</span>}
        <button onClick={save} disabled={!draft || !dirty || busy} className={`${tk.btn} ml-auto`}>
          {busy ? 'Saving…' : dirty ? 'Save to file' : 'Saved'}
        </button>
        <button
          onClick={() => setDeleting(true)}
          // Nothing to delete for a draft with no file behind it.
          disabled={!draft || busy || !onDisk}
          title={draft && !onDisk ? 'This draft has never been written to disk' : 'Delete this view file'}
          className={tk.btnDanger}
        >
          Delete
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

            {draft.implicitFields && (
              // Worth saying out loud: this file currently tracks the table, and
              // saving trades that for an explicit list. Neither is wrong, but it
              // should be a choice rather than a surprise after the next migration.
              <p className={`mb-1.5 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[10px] leading-relaxed ${tk.muted}`}>
                This file lists no fields, so the screen currently shows{' '}
                <span className="text-zinc-300">every column — including any added later</span>. Saving writes the list
                out, and new columns stop appearing on their own.
              </p>
            )}

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
                    dragging={drag?.from === i}
                    // The line sits on the edge the row will actually land against,
                    // so the drop reads the same way it behaves.
                    dropEdge={drag && drag.over === i && drag.from !== i ? (drag.from < i ? 'bottom' : 'top') : null}
                    onToggleExpand={() => setExpanded(expanded === key ? null : key)}
                    onChange={(next) => patchField(i, next)}
                    onMove={(delta) => moveField(i, delta)}
                    onDragStart={() => setDrag({ from: i, over: i })}
                    onDragOverRow={() => setDrag((s) => (s && s.over !== i ? { ...s, over: i } : s))}
                    onDrop={() => {
                      if (drag) reorderField(drag.from, i);
                      setDrag(null);
                    }}
                    onDragEnd={() => setDrag(null)}
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
                    // Every field with a column is eligible, not just the text
                    // ones. The runtime casts to ::text before matching, so a
                    // number, a date or an enum all search fine — and a relation
                    // searches the NAME it displays rather than the foreign key,
                    // which is the whole point of showing a name there. Only
                    // many-to-many is excluded: it has no column to match on.
                    .filter((f) => fieldKind(f.field) !== 'm2m')
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

            {/* Related lists. The candidates are DISCOVERED — every foreign key in
                the catalog pointing at this table — because nothing on this table
                mentions them and there is nothing for a person to remember. */}
            <div className="mt-4 space-y-2 border-t border-zinc-800 pt-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">related lists</span>
              {inboundKeys.length === 0 ? (
                <p className={`text-[10px] ${tk.muted}`}>Nothing references {draft.table} directly, so there are no related rows to show.</p>
              ) : (
                <>
                  <p className={`text-[10px] ${tk.muted}`}>
                    Rows of another table that belong to this one, shown as a panel on the record screen.
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {inboundKeys.map((k) => {
                      const on = draft.related.some((r) => r.table === k.table && r.foreignKey === k.column);
                      // A panel works either way — with no view of its own it
                      // renders the default screen for that table — but saying
                      // which you will get beats finding out on the record page.
                      // Every view that covers this table, not just one named
                      // after it: a table can have several screens, and which one
                      // a panel uses is a decision worth offering.
                      const covering = (views ?? []).filter((v) => v.table === k.table);
                      const curated = covering.find((v) => v.name === k.table) ?? covering[0];
                      const entry = draft.related.find((r) => r.table === k.table && r.foreignKey === k.column);
                      return (
                        <span key={`${k.table}.${k.column}`} className="inline-flex items-center gap-1">
                          <button
                            onClick={() =>
                              setDraft({
                                ...draft,
                                related: on
                                  ? draft.related.filter((r) => !(r.table === k.table && r.foreignKey === k.column))
                                  : [...draft.related, { table: k.table, foreignKey: k.column }],
                              })
                            }
                            title={
                              `${k.table}.${k.column} → ${draft.table}.${k.refColumn}\n` +
                              (curated
                                ? `Renders with ${curated.name}.view.json.`
                                : `No view for ${k.table} yet — the panel will show a default screen with every column. Build one to choose the columns.`) +
                              (k.listOnly
                                ? `\n${k.table} has a composite primary key, so its rows list but cannot be opened or edited.`
                                : '')
                            }
                            className={on ? tk.badgeAccent : tk.badge}
                          >
                            {k.table} <span className="opacity-60">via {k.column}</span>
                            {k.listOnly && <span className="ml-1 opacity-60">· list only</span>}
                            {!curated && <span className="ml-1 opacity-60">· default screen</span>}
                          </button>
                          {!curated && (
                            <button
                              onClick={() => setCreating({ table: k.table })}
                              title={`Build a view for ${k.table}`}
                              className={`${tk.badge} px-1.5`}
                            >
                              + build
                            </button>
                          )}
                          {/* More than one screen exists for this table, so which
                              one the panel renders is a choice, not a lookup. */}
                          {on && covering.length > 1 && (
                            <select
                              aria-label={`View used for the ${k.table} panel`}
                              title={`Which ${k.table} screen this panel renders`}
                              value={entry?.view ?? curated?.name ?? k.table}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  related: draft.related.map((r) =>
                                    r.table === k.table && r.foreignKey === k.column ? { ...r, view: e.target.value } : r
                                  ),
                                })
                              }
                              className={`${tk.input} py-0 text-[10px]`}
                            >
                              {covering.map((v) => (
                                <option key={v.name} value={v.name}>
                                  {v.name}
                                  {v.name === k.table ? ' (default)' : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* The artifact itself — no hiding what gets written. */}
            <details className="mt-4">
              <summary className={`cursor-pointer text-[10px] uppercase tracking-wide ${tk.muted}`}>
                {draft.name}.view.json — what gets written
              </summary>
              <pre className="mt-1.5 overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-emerald-200">
                {/* The $schema line is stamped on save, so show it — this panel
                    claims to be the file, and a preview missing its first line
                    would be a small lie in the one place that promises none. */}
                {JSON.stringify(schemaRef ? { $schema: schemaRef, ...definition } : definition, null, 2)}
              </pre>
              <p className={`mt-1 text-[10px] ${tk.faint}`}>
                The <span className="font-mono">$schema</span> line is written for you — hand-edit this file in an editor and
                you get completion and inline docs for every option.
              </p>
            </details>
          </div>

          {/* ---------------------------- preview ---------------------------- */}
          <PreviewPane name={draft.name} dirty={dirty} nonce={previewNonce} exists={onDisk} />
        </div>
      ) : views.length > 0 ? (
        // Views exist and one is being opened. Showing the empty state here would
        // claim there are none — which is simply untrue, and the load can take a
        // few seconds on a cold route.
        <LoadingState />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <p className={`text-xs ${tk.muted}`}>No admin screens yet.</p>
          <button onClick={() => setCreating({})} className={tk.btn}>
            + Build your first admin screen
          </button>
        </div>
      )}

      {creating && (
        <NewViewModal
          tables={catalog.tables}
          existing={views.map((v) => v.name)}
          initialTable={creating.table}
          onClose={() => setCreating(null)}
          onCreate={startNew}
        />
      )}

      {deleting && draft && (
        <Modal
          title="Delete this view?"
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button onClick={destroy} disabled={busy} className={tk.btnDanger}>
                {busy ? 'Deleting…' : `Delete ${draft.name}.view.json`}
              </button>
              <button onClick={() => setDeleting(false)} className={tk.btn2}>
                Cancel
              </button>
            </>
          }
        >
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-zinc-300">
              This removes <span className="font-mono text-zinc-100">admin/views/{draft.name}.view.json</span> from the repo.
              The <span className="font-mono">{draft.table}</span> table and its rows are untouched — only the screen goes away.
            </p>
            <p className={`text-[11px] ${tk.muted}`}>
              It is a tracked file, so <span className="font-mono">git checkout</span> brings it back if this was a mistake.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------ new view ------------------------------- */

function NewViewModal({
  tables,
  existing,
  initialTable,
  onClose,
  onCreate,
}: {
  tables: ClientTable[];
  existing: string[];
  /** Preselected when opened from a related list that has no view yet. */
  initialTable?: string;
  onClose: () => void;
  onCreate: (table: string, name: string) => void;
}) {
  // Defaulting the NAME to the table is what keeps a panel's preferred view and
  // the file on disk in step — the mismatch that made a panel resolve a screen
  // about some other table.
  const [table, setTable] = useState(initialTable ?? '');
  const [name, setName] = useState(initialTable ?? '');
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
