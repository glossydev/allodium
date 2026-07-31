'use client';

import { useState } from 'react';
import { tk } from '@/ui/tokens';
import { Modal, SqlPreview } from '@/ui/primitives';
import { useDdlPreview, ExecuteFooter } from './builders';
import type { SchemaTable } from './SchemaBrowser';

/**
 * Index builder. Column ORDER matters for a composite index (a b-tree on (a, b)
 * helps queries filtering on a, or a+b, but not b alone), so columns are picked
 * as an ordered list rather than a set of checkboxes.
 */
export default function IndexBuilder({
  table,
  onClose,
  onDone,
}: {
  table: SchemaTable;
  onClose: () => void;
  onDone: () => void;
}) {
  const [columns, setColumns] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState('');

  const available = table.columns.filter((c) => !c.masked && !columns.includes(c.name));
  const suggested = columns.length ? `${table.name}_${columns.join('_')}_${unique ? 'key' : 'idx'}` : '';
  const params = { table: table.name, columns, unique, name: name.trim() || undefined };
  const { sql, buildError } = useDdlPreview('createIndex', params, columns.length > 0);

  return (
    <Modal
      title={<span className="font-mono">index on {table.name}</span>}
      onClose={onClose}
      width="max-w-2xl"
      footer={<ExecuteFooter action="createIndex" params={params} previewSql={sql} onDone={onDone} onClose={onClose} label="Create index" />}
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            columns — order matters for composite indexes
          </div>
          {columns.length > 0 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {columns.map((c, i) => (
                <span key={c} className={`${tk.badgeAccent} flex items-center gap-1 font-mono`}>
                  {i + 1}. {c}
                  <button onClick={() => setColumns((prev) => prev.filter((x) => x !== c))} className="text-zinc-400 hover:text-red-300">
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <select
            value=""
            onChange={(e) => e.target.value && setColumns((prev) => [...prev, e.target.value])}
            className={`${tk.select} w-full font-mono`}
          >
            <option value="">{columns.length ? '+ add another column' : '— pick a column —'}</option>
            {available.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} · {c.type}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} className={tk.checkbox} />
          unique
          <span className={tk.faint}>— also makes these columns a legal foreign-key target</span>
        </label>

        <div>
          <label className="text-[11px] font-medium text-zinc-400">name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={suggested || 'pick columns first'}
            className={`${tk.input} mt-0.5 w-full font-mono`}
          />
        </div>

        {buildError && <div className={tk.err}>{buildError}</div>}
        {sql && <SqlPreview sql={sql} />}
      </div>
    </Modal>
  );
}
