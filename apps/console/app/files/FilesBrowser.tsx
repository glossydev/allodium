'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { tk } from '@/ui/tokens';
import { PAGE_SIZE, fetchJson, prettyBytes, NullMark, ErrorBox, EmptyState, LoadingState, SlideOver, Modal } from '@/ui/primitives';

/**
 * Files silo — metadata + bytes with first-class reference awareness.
 * Files are standalone rows uploadable FIRST, referenced later; disk truth
 * and metadata are shown side by side because they can disagree.
 */

interface FileRef {
  table: string;
  column: string;
  count: number;
}

interface FileRow {
  id: string;
  disk_name: string;
  filename: string;
  mime_type: string | null;
  filesize_bytes: number | null;
  title: string | null;
  uploaded_at: string;
  referencedBy: FileRef[];
  onDisk: boolean;
}

const SORTS = [
  { value: 'uploaded_at', label: 'newest' },
  { value: 'filename', label: 'filename' },
  { value: 'filesize_bytes', label: 'size' },
];

const extOf = (f: FileRow) => {
  const dot = f.disk_name.lastIndexOf('.');
  return dot > 0 ? f.disk_name.slice(dot + 1).toLowerCase() : '?';
};

const isImage = (f: FileRow) => !!f.mime_type?.startsWith('image/') && f.onDisk;

export default function FilesBrowser() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState('uploaded_at');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [drawerFile, setDrawerFile] = useState<FileRow | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, dir: sort === 'filename' ? 'asc' : 'desc' });
    if (debouncedQ) p.set('q', debouncedQ);
    fetchJson<{ rows: FileRow[]; total: number }>(`/api/files/list?${p.toString()}`).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setRows(r.data.rows);
        setTotal(r.data.total);
        setError(null);
        setDrawerFile((prev) => (prev ? (r.data.rows.find((f) => f.id === prev.id) ?? prev) : prev));
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [page, sort, debouncedQ, tick]);

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = (page - 1) * PAGE_SIZE + rows.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={tk.toolbar}>
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search filename or title…" className={`${tk.input} w-56`} />
        <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className={tk.select}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button onClick={() => setShowUpload(true)} className={`${tk.btn} ml-auto`}>
          + Upload
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox error={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState>
            No files.{' '}
            <span className="text-zinc-500">
              Upload creates the file row immediately — reference it from content whenever you're ready (no two-pass imports).
            </span>
          </EmptyState>
        ) : (
          <table className={tk.table}>
            <thead>
              <tr>
                {['', 'filename', 'title', 'type', 'size', 'uploaded', 'refs', 'disk'].map((h, i) => (
                  <th key={i} className={tk.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} onClick={() => setDrawerFile(f)} className={tk.trClickable}>
                  <td className="w-12 px-2 py-1">
                    {isImage(f) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/files/${f.id}/raw`} alt="" className="h-8 w-8 rounded object-cover" />
                    ) : (
                      <span className={`${tk.badge} font-mono uppercase`}>{extOf(f)}</span>
                    )}
                  </td>
                  <td className={`${tk.td} font-mono`}>{f.filename}</td>
                  <td className={tk.td}>{f.title ?? <NullMark />}</td>
                  <td className={tk.td}>{f.mime_type ? <span className={tk.badge}>{f.mime_type}</span> : <NullMark />}</td>
                  <td className={`${tk.td} font-mono tabular-nums`}>{prettyBytes(f.filesize_bytes)}</td>
                  <td className={`${tk.td} font-mono text-zinc-400`}>{f.uploaded_at}</td>
                  <td className={tk.td}>
                    {f.referencedBy.length > 0 ? (
                      <span className={tk.badgeAccent}>{f.referencedBy.reduce((n, r) => n + r.count, 0)}</span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className={tk.td}>
                    {f.onDisk ? <span className={tk.accent}>●</span> : <span className="text-amber-400">missing</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={`flex items-center justify-between ${tk.footer}`}>
        <span>
          {rangeStart}–{rangeEnd} of {total}
          {loading ? ' · loading…' : ''}
        </span>
        <div className="flex items-center gap-1">
          <button disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className={tk.btn2}>
            Prev
          </button>
          <button disabled={rangeEnd >= total || loading} onClick={() => setPage((p) => p + 1)} className={tk.btn2}>
            Next
          </button>
        </div>
      </div>

      {drawerFile && <FileDrawer file={drawerFile} onClose={() => setDrawerFile(null)} onChanged={refresh} />}
      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => {
            setShowUpload(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------- File drawer ------------------------------- */

function FileDrawer({ file, onClose, onChanged }: { file: FileRow; onClose: () => void; onChanged: () => void }) {
  const [title, setTitle] = useState(file.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTitle(file.title ?? ''), [file]);

  const saveTitle = async () => {
    setBusy(true);
    setError(null);
    const r = await fetchJson('/api/content/row', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'files', id: file.id, values: { title: title || null } }),
    });
    setBusy(false);
    if (r.ok) onChanged();
    else setError(r.error);
  };

  const del = async () => {
    if (!window.confirm(`Delete ${file.filename}? Metadata row and bytes are both removed.`)) return;
    setBusy(true);
    setError(null);
    const r = await fetchJson('/api/files/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: file.id }),
    });
    setBusy(false);
    if (r.ok) {
      onClose();
      onChanged();
    } else setError(r.error);
  };

  const referenced = file.referencedBy.length > 0;

  return (
    <SlideOver
      title={<span className="font-mono">{file.filename}</span>}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={del}
            disabled={busy || referenced}
            title={referenced ? `Referenced by ${file.referencedBy.map((r) => r.table).join(', ')} — unlink first` : undefined}
            className={tk.btnDanger}
          >
            Delete
          </button>
          <button onClick={onClose} className={`${tk.btn2} ml-auto`}>
            Close
          </button>
        </>
      }
    >
      <div className="space-y-4 p-4">
        {/* Preview */}
        {isImage(file) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/files/${file.id}/raw`} alt={file.title ?? file.filename} className="max-h-56 w-full rounded border border-zinc-800 object-contain" />
        ) : file.onDisk ? (
          <a href={`/api/files/${file.id}/raw`} target="_blank" rel="noreferrer" className={`inline-block text-xs ${tk.link}`}>
            open raw ({file.mime_type ?? 'unknown type'}) ↗
          </a>
        ) : null}

        {!file.onDisk && (
          <div className={tk.warn}>
            Metadata exists but no bytes at UPLOADS_DIR — upload the file again, or delete the row. The console shows this
            disagreement instead of hiding it.
          </div>
        )}

        {/* Metadata */}
        <div className="space-y-2">
          <div>
            <label className="text-[11px] font-medium text-zinc-400">title</label>
            <div className="mt-0.5 flex gap-2">
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${tk.input} flex-1`} />
              <button onClick={saveTitle} disabled={busy || title === (file.title ?? '')} className={tk.btn}>
                Save
              </button>
            </div>
          </div>
          <div className={`space-y-0.5 text-[11px] ${tk.muted}`}>
            <div>
              disk: <span className="font-mono text-zinc-300">{file.disk_name}</span>
              <button onClick={() => navigator.clipboard?.writeText(file.disk_name).catch(() => {})} className={`ml-1.5 ${tk.link}`}>
                copy
              </button>
            </div>
            <div>
              id: <span className="font-mono text-zinc-300">{file.id}</span>
              <button onClick={() => navigator.clipboard?.writeText(file.id).catch(() => {})} className={`ml-1.5 ${tk.link}`}>
                copy
              </button>
            </div>
            <div>
              {file.mime_type ?? '—'} · {prettyBytes(file.filesize_bytes)} · uploaded {file.uploaded_at}
            </div>
          </div>
        </div>

        {/* References */}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Referenced by</div>
          {file.referencedBy.length === 0 ? (
            <div className={`text-[11px] ${tk.muted}`}>
              Nothing yet — pick this file from any FK column in <Link href="/content" className={tk.link}>Content</Link>.
            </div>
          ) : (
            <ul className="space-y-1">
              {file.referencedBy.map((r, i) => (
                <li key={i} className="text-[11px]">
                  <Link href={`/content?table=${r.table}&f=${r.column}:eq:${file.id}`} className={`font-mono ${tk.link}`}>
                    {r.table}.{r.column}
                  </Link>{' '}
                  <span className={tk.faint}>
                    {r.count} row{r.count === 1 ? '' : 's'} →
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <div className={`${tk.err} whitespace-pre-wrap`}>{error}</div>}
      </div>
    </SlideOver>
  );
}

/* ------------------------------- Upload modal ------------------------------- */

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('file', file);
    if (title.trim()) form.set('title', title.trim());
    const r = await fetchJson('/api/files/upload', { method: 'POST', body: form });
    setBusy(false);
    if (r.ok) onUploaded();
    else setError(r.error);
  };

  return (
    <Modal
      title="Upload file"
      onClose={onClose}
      footer={
        <>
          <button onClick={upload} disabled={!file || busy} className={tk.btn}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
          <button onClick={onClose} disabled={busy} className={tk.btn2}>
            Cancel
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-xs text-zinc-400 file:mr-3 file:rounded file:border-0 file:bg-emerald-600 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-emerald-500"
        />
        <div>
          <label className="text-[11px] font-medium text-zinc-400">title (optional)</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${tk.input} mt-0.5 w-full`} />
        </div>
        <p className={`text-[10px] ${tk.faint}`}>
          The file row exists as soon as the upload lands — link it from content afterward. 25 MB cap.
        </p>
        {error && <div className={tk.err}>{error}</div>}
      </div>
    </Modal>
  );
}
