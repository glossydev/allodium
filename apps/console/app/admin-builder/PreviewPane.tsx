'use client';

import { useState } from 'react';
import { AdminList, AdminForm } from '@allodium/admin/react';
import { tk } from '@/ui/tokens';
import { PREVIEW_CSS } from './preview-css';

/**
 * The live preview — the actual @allodium/admin/react components, the actual
 * resolver, real rows. Not a mock of the dashboard; it IS the dashboard, running
 * inside the build lane.
 *
 * It renders from the file ON DISK, so unsaved edits deliberately do not appear.
 * Previewing the draft would be more immediate but would let you approve a screen
 * that isn't what ships; the banner says which state you're looking at instead.
 */
export default function PreviewPane({
  name,
  dirty,
  nonce,
  exists,
}: {
  name: string;
  dirty: boolean;
  nonce: number;
  /** False for a draft that has never been written — there is no file to render yet. */
  exists: boolean;
}) {
  const [editing, setEditing] = useState<{ id: unknown } | 'new' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const config = { baseUrl: '/api/admin', view: name };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <style>{PREVIEW_CSS}</style>

      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <span className={`text-[10px] uppercase tracking-wide ${tk.muted}`}>live preview</span>
        {dirty ? (
          <span className="text-[11px] text-amber-400">showing the saved file — save to see your edits</span>
        ) : (
          <span className={`text-[11px] ${tk.faint}`}>matches the file on disk</span>
        )}
        {editing !== null && (
          <button onClick={() => setEditing(null)} className={`${tk.btn2} ml-auto`}>
            ← list
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!exists ? (
          // Rendering requires a file. Say that plainly instead of letting the
          // runtime 404 against a view that was never written.
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className={`max-w-xs text-xs leading-relaxed ${tk.muted}`}>
              Nothing on disk yet. Choose your fields, then <span className="text-emerald-400">Save to file</span> — the
              preview renders whatever <span className="font-mono">{name}.view.json</span> contains.
            </p>
          </div>
        ) : (
        <div className="allodium-preview p-5">
          {editing === null ? (
            <AdminList
              key={`${name}-list-${nonce}-${refresh}`}
              config={config}
              onSelect={(id) => setEditing({ id })}
              onNew={() => setEditing('new')}
            />
          ) : (
            <AdminForm
              key={`${name}-form-${nonce}-${editing === 'new' ? 'new' : String(editing.id)}`}
              config={config}
              id={editing === 'new' ? null : (editing.id as string | number)}
              onSaved={() => {
                setRefresh((n) => n + 1);
                setEditing(null);
              }}
              onDeleted={() => {
                setRefresh((n) => n + 1);
                setEditing(null);
              }}
            />
          )}
        </div>
        )}
      </div>

      <div className={tk.footer}>
        Real components, real data. The CSS below is the consumer&apos;s — every rule targets a data-allodium attribute.
      </div>
    </div>
  );
}
