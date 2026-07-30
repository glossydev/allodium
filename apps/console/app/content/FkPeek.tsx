'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tk } from '@/ui/tokens';
import { type WireRow, cellText, clip, NullMark, fetchJson } from '@/ui/primitives';

/**
 * FK hover peek — see what is on the other end of a foreign key without leaving
 * the grid. Hover (or focus) an FK link; after a short delay a card fetches the
 * referenced row and shows the handful of columns that answer "is this the right
 * row?" — chosen server-side by heuristic, no per-table configuration.
 *
 * RENDERED IN A PORTAL, deliberately. The grid's `td` carries `truncate`
 * (overflow:hidden) to keep cells one line, which silently clipped an
 * absolutely-positioned card to nothing — the feature looked broken while the API
 * was returning correct data. Fixed positioning off the anchor's rect, portalled to
 * document.body, escapes every overflow and stacking context in the table.
 *
 * There is also NO `title` attribute on the trigger: the native tooltip rendered on
 * top of the card and duplicated the header line.
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

type CacheEntry =
  | { state: 'loading'; promise: Promise<void> }
  | { state: 'done'; data: PeekData }
  | { state: 'error'; error: string };

/** Survives component unmounts; bounded so a long session can't grow forever. */
const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX = 400;
const HOVER_DELAY_MS = 160;
/** Grace period so moving the pointer from the link onto the card doesn't close it. */
const CLOSE_DELAY_MS = 120;
const CARD_W = 340;
const CARD_MAX_H = 260;

const cacheKey = (table: string, column: string, value: string) => `${table}:${column}:${value}`;

/** Drop the oldest entries once over budget (Map preserves insertion order). */
function trimCache() {
  if (CACHE.size <= CACHE_MAX) return;
  let excess = CACHE.size - CACHE_MAX;
  for (const k of CACHE.keys()) {
    if (excess-- <= 0) break;
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
  CACHE.set(key, { state: 'loading', promise: loadPeek(table, column, value) });
}

interface Placement {
  left: number;
  top: number;
}

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
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [entry, setEntry] = useState<CacheEntry | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const open = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(async () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;

      // Fixed coordinates, clamped into the viewport on both axes.
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - CARD_W - 8));
      const below = window.innerHeight - rect.bottom;
      const top = below < CARD_MAX_H && rect.top > below ? Math.max(8, rect.top - CARD_MAX_H - 6) : rect.bottom + 6;
      setPlacement({ left, top });

      const key = cacheKey(refTable, refColumn, value);
      let e = CACHE.get(key);
      if (!e) {
        e = { state: 'loading', promise: loadPeek(refTable, refColumn, value) };
        CACHE.set(key, e);
      }
      setEntry(e);
      if (e.state === 'loading') {
        await e.promise;
        if (alive.current) setEntry(CACHE.get(key) ?? null);
      }
    }, HOVER_DELAY_MS);
  }, [refTable, refColumn, value]);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (alive.current) setPlacement(null);
    }, CLOSE_DELAY_MS);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  return (
    <>
      <button
        ref={anchor}
        onClick={(e) => {
          e.stopPropagation();
          onNavigate();
        }}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onFocus={open}
        onBlur={scheduleClose}
        aria-label={`Peek ${refTable}.${refColumn} = ${value}`}
        className={`${tk.link} ${className}`}
      >
        {label ?? `→ ${refTable}`}
      </button>

      {placement &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', left: placement.left, top: placement.top, width: CARD_W, maxHeight: CARD_MAX_H }}
            className="z-[100] overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-2 text-left shadow-2xl"
          >
            <div className="mb-1.5 flex items-baseline gap-2 border-b border-zinc-800 pb-1">
              <span className="font-mono text-[10px] text-emerald-400">{refTable}</span>
              <span className="font-mono text-[10px] text-zinc-500">
                {refColumn} = {clip(value, 30)}
              </span>
            </div>
            <PeekBody entry={entry} />
          </div>,
          document.body
        )}
    </>
  );
}

function PeekBody({ entry }: { entry: CacheEntry | null }) {
  if (!entry || entry.state === 'loading') {
    return <div className="py-1 text-[11px] text-zinc-500">Loading…</div>;
  }
  if (entry.state === 'error') {
    return <div className="py-1 text-[11px] text-red-400">{entry.error}</div>;
  }
  const { row, columns } = entry.data;
  if (!row) {
    // A real and interesting state: the FK value points at nothing. Only possible
    // with a NOT VALID / deferred constraint or a plain non-FK column, but when it
    // happens the developer very much wants to know.
    return <div className="py-1 text-[11px] text-amber-400">No matching row.</div>;
  }
  return (
    <div className="space-y-1">
      {columns.map((c) => {
        const d = cellText(row[c.name]);
        return (
          <div key={c.name} className="flex items-baseline gap-2">
            <span className="w-24 shrink-0 truncate font-mono text-[10px] text-zinc-500" title={`${c.name} · ${c.type}`}>
              {c.name}
            </span>
            <span className="min-w-0 flex-1 break-words text-[11px] text-zinc-100">
              {d.isNull ? (
                <NullMark />
              ) : c.family === 'enum' ? (
                <span className={tk.badge}>{d.text}</span>
              ) : c.family === 'boolean' ? (
                <span className={d.text === 'true' ? tk.accent : 'text-zinc-500'}>{d.text}</span>
              ) : (
                <span className={c.family === 'number' || c.isPk ? 'font-mono' : ''}>{clip(d.text, 120)}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
