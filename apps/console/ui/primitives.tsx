'use client';

import { useEffect, type ReactNode } from 'react';
import { tk } from './tokens';

/* Shared client primitives for the console silos. */

export type WireRow = Record<string, unknown>;

export const PAGE_SIZE = 50;

/** Display form of a wire value: text + whether it's NULL. */
export function cellText(v: unknown): { text: string; isNull: boolean } {
  if (v === null || v === undefined) return { text: '', isNull: true };
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', isNull: false };
  if (typeof v === 'object') {
    try {
      return { text: JSON.stringify(v) ?? String(v), isNull: false };
    } catch {
      return { text: String(v), isNull: false };
    }
  }
  return { text: String(v), isNull: false };
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export const NullMark = () => <span className="text-zinc-700">∅</span>;

/** 1234567 -> "1.2 MB" etc. */
export function prettyBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** fetch + JSON + uniform error normalization for { error } responses. */
export async function fetchJson<T = unknown>(
  input: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(input, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: typeof data?.error === 'string' ? data.error : `HTTP ${res.status}` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Request failed' };
  }
}

/** Right-hand slide-over panel (row drawers, FK pickers, builders). */
export function SlideOver({
  title,
  onClose,
  children,
  footer,
  width = 'w-[440px]',
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className={`fixed inset-y-0 right-0 z-40 flex ${width} max-w-full flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl`}
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2.5">{footer}</div>}
    </div>
  );
}

/** Centered modal (confirmations, small builders). */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-lg',
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`flex w-full ${width} max-h-[85vh] flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return <div className={`m-3 ${tk.err}`}>{error}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="p-6 text-center text-xs text-zinc-600">{children}</div>;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="p-6 text-center text-xs text-zinc-600">{label}</div>;
}

/** Generated-SQL preview block — every DDL flow shows its SQL before running it. */
export function SqlPreview({ sql }: { sql: string }) {
  return (
    <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-200">
      {sql}
    </pre>
  );
}
