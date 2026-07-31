'use client';

import { useEffect, useState } from 'react';
import { AdminList, AdminForm } from '@allodium/admin/react';
import { tk } from '@/ui/tokens';
import { fetchJson, LoadingState, EmptyState, ErrorBox } from '@/ui/primitives';

/**
 * Admin Builder — for now, a live PREVIEW of the runtime rather than an authoring
 * UI. Proving the contract first is deliberate: the format that the builder will
 * write is only trustworthy once something real renders and saves from it.
 *
 * What renders below is the actual @allodium/admin/react components — the same
 * ones a deployed dashboard imports — pointed at the same resolver a dashboard
 * mounts. The console is running the run lane so you can see it.
 *
 * They arrive with NO styling of their own. The stylesheet in this file is
 * deliberately minimal and lives here, in the consumer, exactly as it would in a
 * real deployment: every rule targets a data-allodium attribute.
 */

interface ViewFile {
  name: string;
  table: string;
  title: string;
  fieldCount: number;
}

export default function AdminBuilderPreview() {
  const [views, setViews] = useState<ViewFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: unknown } | 'new' | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    fetchJson<{ views: ViewFile[] }>('/api/admin-views').then((r) => {
      if (r.ok) {
        setViews(r.data.views);
        setSelected((prev) => prev ?? r.data.views[0]?.name ?? null);
      } else setError(r.error);
    });
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!views) return <LoadingState />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <style>{PREVIEW_CSS}</style>

      <div className={tk.toolbar}>
        <span className={`text-xs ${tk.muted}`}>view</span>
        <select
          value={selected ?? ''}
          onChange={(e) => {
            setSelected(e.target.value);
            setEditing(null);
          }}
          className={`${tk.select} font-mono`}
        >
          {views.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}.view.json → {v.table}
            </option>
          ))}
        </select>
        {editing !== null && (
          <button onClick={() => setEditing(null)} className={tk.btn2}>
            ← Back to list
          </button>
        )}
        <span className={`ml-auto text-[11px] ${tk.faint}`}>
          live preview · unstyled components + the CSS in this file
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {views.length === 0 ? (
          <EmptyState>
            No view definitions yet — add one at <span className="font-mono">admin/views/*.view.json</span>.
          </EmptyState>
        ) : selected ? (
          <div className="allodium-preview p-6">
            {editing === null ? (
              <AdminList
                key={`${selected}-list-${nonce}`}
                config={{ baseUrl: '/api/admin', view: selected }}
                onSelect={(id) => setEditing({ id })}
                onNew={() => setEditing('new')}
              />
            ) : (
              <AdminForm
                key={`${selected}-form-${editing === 'new' ? 'new' : String(editing.id)}`}
                config={{ baseUrl: '/api/admin', view: selected }}
                id={editing === 'new' ? null : (editing.id as string | number)}
                onSaved={() => {
                  setNonce((n) => n + 1);
                  setEditing(null);
                }}
                onDeleted={() => {
                  setNonce((n) => n + 1);
                  setEditing(null);
                }}
              />
            )}
          </div>
        ) : null}
      </div>

      <div className={tk.footer}>
        These are @allodium/admin/react components — the same ones a dashboard imports. Every rule below targets a
        data-allodium attribute; the components ship no styles at all.
      </div>
    </div>
  );
}

/**
 * The entire styling contract, demonstrated. This is what a developer writes to
 * make the generated admin look like their product — plain CSS, no theme API.
 */
const PREVIEW_CSS = `
.allodium-preview { color: #d4d4d8; max-width: 60rem; }
.allodium-preview h1 { font-size: 1.05rem; font-weight: 600; color: #fafafa; }
.allodium-preview [data-allodium="description"] { font-size: .75rem; color: #a1a1aa; margin-top: .15rem; }

.allodium-preview [data-allodium="list-header"],
.allodium-preview [data-allodium="form-header"] { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem; flex-wrap: wrap; }
.allodium-preview [data-allodium="search"] { margin-left: auto; }

.allodium-preview input, .allodium-preview textarea, .allodium-preview select {
  background: #09090b; border: 1px solid #3f3f46; border-radius: .25rem;
  color: #e4e4e7; padding: .25rem .5rem; font-size: .75rem; font-family: inherit;
}
.allodium-preview input:focus, .allodium-preview textarea:focus, .allodium-preview select:focus {
  outline: none; border-color: #059669;
}
.allodium-preview input[type="checkbox"], .allodium-preview input[type="radio"] { accent-color: #10b981; }
.allodium-preview textarea { width: 100%; min-height: 5rem; font-family: ui-monospace, monospace; }

.allodium-preview button {
  background: #18181b; border: 1px solid #3f3f46; border-radius: .25rem;
  color: #d4d4d8; padding: .25rem .625rem; font-size: .75rem; cursor: pointer;
}
.allodium-preview button:hover:not(:disabled) { border-color: #52525b; color: #fafafa; }
.allodium-preview button:disabled { opacity: .4; cursor: default; }
.allodium-preview [data-allodium="save"] { background: #059669; border-color: #059669; color: #fff; font-weight: 500; }
.allodium-preview [data-allodium="delete"] { border-color: #7f1d1d; color: #fca5a5; }

.allodium-preview [data-allodium="table"] { width: 100%; border-collapse: collapse; font-size: .75rem; }
.allodium-preview th { text-align: left; border-bottom: 1px solid #27272a; padding: .35rem .5rem; font-weight: 500; color: #a1a1aa; }
.allodium-preview th button { background: none; border: none; padding: 0; color: inherit; font: inherit; }
.allodium-preview td { border-bottom: 1px solid #1c1c1f; padding: .35rem .5rem; }
.allodium-preview [data-allodium="row"]:hover { background: rgba(6,78,59,.25); cursor: pointer; }
.allodium-preview [data-allodium="null"]::before { content: "\\2205"; color: #52525b; }
.allodium-preview [data-allodium="empty"] { text-align: center; color: #71717a; padding: 1.5rem; }

.allodium-preview [data-allodium="field"] { margin-bottom: .9rem; display: flex; flex-direction: column; gap: .2rem; }
.allodium-preview [data-allodium="label"] { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: #a1a1aa; }
.allodium-preview [data-allodium="required-mark"] { color: #10b981; }
.allodium-preview [data-allodium="help"] { font-size: .7rem; color: #71717a; }
.allodium-preview [data-allodium="field-error"] { font-size: .7rem; color: #f87171; }
.allodium-preview [data-invalid] input, .allodium-preview [data-invalid] select { border-color: #b91c1c; }

/* Relation and many-to-many pickers lay out inline; nothing about that is in the component. */
.allodium-preview [data-allodium="radiogroup"],
.allodium-preview [data-allodium="checkboxes"] { display: flex; flex-wrap: wrap; gap: .75rem; padding: .2rem 0; }
.allodium-preview [data-allodium="radio"],
.allodium-preview [data-allodium="checkbox-option"] { display: flex; align-items: center; gap: .3rem; font-size: .75rem; }

.allodium-preview [data-allodium="form-actions"] { display: flex; gap: .5rem; margin-top: 1.25rem; border-top: 1px solid #27272a; padding-top: .75rem; }
.allodium-preview [data-allodium="pagination"] { display: flex; align-items: center; gap: .5rem; margin-top: .75rem; font-size: .7rem; color: #a1a1aa; }
.allodium-preview [data-allodium="error"] { color: #f87171; font-size: .75rem; }
.allodium-preview [data-allodium="loading"] { color: #71717a; font-size: .75rem; }

/* Field-specific tuning, to show that per-column targeting works. */
.allodium-preview [data-field="body"] textarea { min-height: 8rem; }
.allodium-preview [data-field="views"] input { max-width: 8rem; }
.allodium-preview [data-widget="text"] input, .allodium-preview [data-widget="datetime"] input { max-width: 28rem; }
`;
