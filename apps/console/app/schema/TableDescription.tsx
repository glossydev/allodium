'use client';

import { useEffect, useState } from 'react';
import { tk } from '@/ui/tokens';
import { executeDdlAction, previewDdl } from './ddl-client';
import type { SchemaTable } from './SchemaBrowser';

/**
 * Table description — COMMENT ON TABLE, edited inline.
 *
 * Deliberately quiet: a single line that reads as text until you click it, because
 * this is documentation rather than an operation. It becomes the default
 * description on any admin screen built from this table.
 */
export default function TableDescription({ table, onDone }: { table: SchemaTable; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(table.comment ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(table.comment ?? '');
    setEditing(false);
    setError(null);
  }, [table.name, table.comment]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const params = { table: table.name, comment: text.trim() || null };
    const preview = await previewDdl('setTableComment', params);
    if (!preview.ok) {
      setSaving(false);
      setError(preview.error);
      return;
    }
    const r = await executeDdlAction('setTableComment', params, preview.sql);
    setSaving(false);
    if (r.ok) {
      setEditing(false);
      onDone();
    } else setError(r.error);
  };

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        title="Edit description (COMMENT ON TABLE)"
        className={`block w-full border-b border-zinc-800 px-4 py-2 text-left text-[11px] leading-snug ${
          table.comment ? 'text-zinc-400 hover:text-zinc-200' : `${tk.faint} italic hover:text-zinc-400`
        }`}
      >
        {table.comment || 'Add a description…'}
      </button>
    );
  }

  return (
    <div className="space-y-1.5 border-b border-zinc-800 px-4 py-2">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="What does this table hold?"
        className={`${tk.input} w-full resize-y`}
      />
      {error && <div className={`${tk.err} whitespace-pre-wrap`}>{error}</div>}
      <div className="flex items-center gap-1.5">
        <button onClick={save} disabled={saving || text.trim() === (table.comment ?? '')} className={tk.btn}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => {
            setText(table.comment ?? '');
            setEditing(false);
            setError(null);
          }}
          className={tk.btn2}
        >
          Cancel
        </button>
        <span className={`ml-auto text-[10px] ${tk.faint}`}>COMMENT ON TABLE</span>
      </div>
    </div>
  );
}
