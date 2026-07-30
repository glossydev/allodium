'use client';

import { useEffect, useRef, useState } from 'react';
import { tk } from '@/ui/tokens';
import { type WireRow, cellText, clip, NullMark, fetchJson } from '@/ui/primitives';

/**
 * FK hover peek — see what is on the other end of a foreign key without leaving
 * the grid. Hover (or focus) an FK link; after a short delay a card fetches the
 * referenced row and shows the handful of columns that answer "is this the right
 * row?" — chosen server-side by heuristic, no per-table configuration.
 *
 * Cheap by construction:
 *  - one indexed lookup on a PK/unique column, ~6 columns, LIMIT 1;
 *  - a module-level cache keyed table:column:value, so re-hovering the same
 *    value (very common when scanning a column of repeated FKs) is free;
 *  - a hover delay, so sweeping the mouse across a grid fires nothing.
 * Masked columns are refused server-side, so a peek can't become an oracle.
 */

interface PeekColumn {
  name: string;
  type: string;
  family: string;
  isPk: boolean;
}

interface PeekData {
  row: WireRow | null;
  columns: PeekColumn[];
  pk: string | null;
}

type CacheEntry = { state: 'loading'; promise: Promise<void> } | { state: 'done'; data: PeekData } | { state: 'error'; error: string };

/** Survives component unmounts; bounded so a long session can't grow forever. */
const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX = 400;
const HOVER_DELAY_MS = 180;

function cacheKey(table: string, column: string, value: string) {
  return `${table}:${column}:${value}`;
}

/** Drop the oldest entries once over budget (Map preserves insertion order). */
function trimCache() {
  if (CACHE.size <= CACHE_MAX) return;
  const excess = CACHE.size - CACHE_MAX;
  let i = 0;
  for (const k of CACHE.keys()) {
    if (i++ >= excess) break;
    CACHE.delete(k);
  }
}

async function loadPeek(table: string, column: string, value: string): Promise<void> {
  const key = cacheKey(table, column, value);
  const params = new URLSearchParams({ table, column, value });
  const r = await fetchJson<PeekData>(`/api/content/peek?${params.toString()}`);
  CACHE.set(key, r.ok ? { state: 'done', data: r.data } : { state: 'error', error: r.error });
  trimCache();
}

/** Warm the cache without rendering anything — used on row hover. */
export function prefetchPeek(table: string, column: string, value: string) {
  const key = cacheKey(table, column, value);
  if (CACHE.has(key)) return;
  const promise = loadPeek(table, column, value);
  CACHE.set(key, { state: 'loading', promise });
}

/**
 * The FK affordance: the `→ table` link plus its hover card. Clicking still
 * navigates (the peek is additive — it never replaces the jump).
 */
export default function FkPeek({
  refTable,
  refColumn,
  value,
  label,
  onNavigate,
  className = '',
}: {
  refTable: string;
  refColumn: string;
  value: string;
  /** Link text. Defaults to an arrow + table name. */
  label?: React.ReactNode;
  onNavigate: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState<CacheEntry | null>(null);
  const [placeAbove, setPlaceAbove] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      // Flip the card above the anchor when there isn't room below.
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPlaceAbove(window.innerHeight - rect.bottom < 220);
      setOpen(true);

      const key = cacheKey(refTable, refColumn, value);
      let e = CACHE.get(key);
      if (!e) {
        const promise = loadPeek(refTable, refColumn, value);
        e = { state: 'loading', promise };
        CACHE.set(key, e);
      }
      setEntry(e);
      if (e.state === 'loading') {
        await e.promise;
        if (alive.current) setEntry(CACHE.get(key) ?? null);
      }
    }, HOVER_DELAY_MS);
  };

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      ref={anchor}
      className="relative inline-block"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNavigate();
        }}
        title={`→ ${refTable}.${refColumn} = ${value}`}
        className={`${tk.link} ${className}`}
      >
        {label ?? `→ ${refTable}`}
      </button>

      {open && (
        <span
          role="tooltip"
          className={`absolute left-0 z-50 block w-[22rem] cursor-default rounded border border-zinc-700 bg-zinc-900 p-2 text-left shadow-xl ${
            placeAbove ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
          // The card is informational; clicking inside shouldn't open the row drawer.
          onClick={(e) => e.stopPropagation()}
        >
          <span className="mb-1.5 block border-b border-zinc-800 pb-1 font-mono text-[10px] text-zinc-500">
            {refTable}.{refColumn} = {clip(value, 40)}
          </span>
          <PeekBody entry={entry} />
        </span>
      )}
    </span>
  );
}

function PeekBody({ entry }: { entry: CacheEntry | null }) {
  if (!entry || entry.state === 'loading') {
    return <span className="block py-1 text-[11px] text-zinc-500">Loading…</span>;
  }
  if (entry.state === 'error') {
    return <span className="block py-1 text-[11px] text-red-400">{entry.error}</span>;
  }
  const { row, columns } = entry.data;
  if (!row) {
    // A real and interesting state: the FK value points at nothing. Only possible
    // with a NOT VALID / deferred constraint or a plain non-FK column, but when it
    // happens the developer very much wants to know.
    return <span className="block py-1 text-[11px] text-amber-400">No matching row.</span>;
  }
  return (
    <span className="block space-y-0.5">
      {columns.map((c) => {
        const d = cellText(row[c.name]);
        return (
          <span key={c.name} className="flex items-baseline gap-2">
            <span className="w-28 shrink-0 truncate font-mono text-[10px] text-zinc-500" title={`${c.name} ${c.type}`}>
              {c.name}
            </span>
            <span className="min-w-0 flex-1 text-[11px] text-zinc-200">
              {d.isNull ? (
                <NullMark />
              ) : c.family === 'enum' ? (
                <span className={tk.badge}>{d.text}</span>
              ) : c.family === 'boolean' ? (
                <span className={d.text === 'true' ? tk.accent : 'text-zinc-500'}>{d.text}</span>
              ) : (
                <span className={c.family === 'number' || c.isPk ? 'font-mono' : ''}>{clip(d.text, 90)}</span>
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}
