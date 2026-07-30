'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { tk } from '@/ui/tokens';
import {
  PAGE_SIZE,
  type WireRow,
  cellText,
  clip,
  NullMark,
  fetchJson,
  ErrorBox,
  EmptyState,
  LoadingState,
} from '@/ui/primitives';
import {
  type ClientCatalog,
  type ClientTable,
  type UiFilter,
  type FilterOp,
  FILTER_OPS,
  filterToParam,
  paramToFilter,
} from './types';
import RowDrawer, { type DrawerState } from './RowDrawer';

/**
 * The Content silo — generic table browser + CRUD over the live catalog.
 * All state that defines the view (table, sort, page, filters) lives in the URL,
 * so any grid a developer is looking at is a shareable link.
 */

interface RowsResponse {
  rows: WireRow[];
  total: number;
  page: number;
  pageSize: number;
}

export default function ContentBrowser() {
  const router = useRouter();
  const params = useSearchParams();

  const [catalog, setCatalog] = useState<ClientCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // View state — initialized from the URL, mirrored back on every change.
  const table = params.get('table');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const sort = params.get('sort');
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const filters = useMemo(
    () => params.getAll('f').map(paramToFilter).filter((f): f is UiFilter => f !== null),
    [params]
  );

  // Pending-filter builder state (not yet applied).
  const [pfCol, setPfCol] = useState('');
  const [pfOp, setPfOp] = useState<FilterOp>('eq');
  const [pfVal, setPfVal] = useState('');

  // Rows are stored WITH the table they came from. Without that pairing, switching
  // tables renders the previous table's rows under the new table's columns, and a
  // click in that window opens the drawer bound to the new table holding an old row —
  // so Save/Delete would hit a different physical row that happens to share a pk.
  const [result, setResult] = useState<{ table: string; rows: WireRow[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  const currentTable: ClientTable | null = useMemo(
    () => catalog?.tables.find((t) => t.name === table) ?? null,
    [catalog, table]
  );
  const visibleCols = useMemo(() => currentTable?.columns.filter((c) => !c.masked) ?? [], [currentTable]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<ClientCatalog>('/api/catalog').then((r) => {
      if (cancelled) return;
      if (r.ok) setCatalog(r.data);
      else setCatalogError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Replace the URL with a new view state (drives the fetch effect). */
  const setView = useCallback(
    (v: { table?: string | null; page?: number; sort?: string | null; dir?: 'asc' | 'desc'; filters?: UiFilter[] }) => {
      const p = new URLSearchParams();
      const nextTable = v.table !== undefined ? v.table : table;
      if (nextTable) p.set('table', nextTable);
      const nextPage = v.page ?? 1;
      if (nextPage > 1) p.set('page', String(nextPage));
      const nextSort = v.sort !== undefined ? v.sort : sort;
      if (nextSort) {
        p.set('sort', nextSort);
        p.set('dir', v.dir ?? dir);
      }
      for (const f of v.filters ?? filters) p.append('f', filterToParam(f));
      router.replace(`/content?${p.toString()}`);
    },
    [router, table, sort, dir, filters]
  );

  const selectTable = useCallback(
    (name: string, filterInit?: UiFilter[]) => {
      setDrawer(null);
      setGridError(null);
      setPfCol('');
      setPfVal('');
      setView({ table: name, page: 1, sort: null, filters: filterInit ?? [] });
    },
    [setView]
  );

  /** FK jump — used by grid cells and the drawer. */
  const navigateFk = useCallback(
    (refTable: string, refColumn: string, value: string) => {
      selectTable(refTable, [{ col: refColumn, op: 'eq', val: value }]);
    },
    [selectTable]
  );

  // Row fetch — every view-state change and refresh tick.
  useEffect(() => {
    if (!table) return;
    const forTable = table;
    let cancelled = false;
    setLoading(true);
    const p = new URLSearchParams({ table, page: String(page), pageSize: String(PAGE_SIZE) });
    if (sort) {
      p.set('sort', sort);
      p.set('dir', dir);
    }
    for (const f of filters) p.append('f', filterToParam(f));
    fetchJson<RowsResponse>(`/api/content/rows?${p.toString()}`).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setResult({ table: forTable, rows: r.data.rows, total: r.data.total });
        setGridError(null);
        // A deep link (or deleting the last row of the last page) can land past the
        // end. Clamp back instead of showing an empty grid with nonsense counts.
        const lastPage = Math.max(1, Math.ceil(r.data.total / PAGE_SIZE));
        if (r.data.rows.length === 0 && r.data.total > 0 && page > lastPage) {
          setView({ page: lastPage });
        }
      } else {
        setGridError(r.error);
      }
    });
    return () => {
      cancelled = true;
    };
    // setView is intentionally omitted: it changes identity with every view change
    // and including it would re-fire this fetch on its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, page, sort, dir, filters, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const toggleSort = (col: string) => {
    if (sort === col) setView({ dir: dir === 'asc' ? 'desc' : 'asc', page: 1 });
    else setView({ sort: col, dir: 'asc', page: 1 });
  };

  const addFilter = () => {
    if (!pfCol) return;
    const needsValue = FILTER_OPS.find((o) => o.value === pfOp)?.needsValue;
    setView({ filters: [...filters, { col: pfCol, op: pfOp, val: needsValue ? pfVal : '' }], page: 1 });
    setPfVal('');
  };

  const removeFilter = (idx: number) => {
    setView({ filters: filters.filter((_, i) => i !== idx), page: 1 });
  };

  if (catalogError) return <ErrorBox error={catalogError} />;
  if (!catalog) return <LoadingState />;

  const tableList = catalog.tables.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()));
  // Only trust rows that belong to the table currently selected.
  const fresh = result && result.table === table ? result : null;
  const rows = fresh?.rows ?? [];
  const total = fresh?.total ?? 0;
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = (page - 1) * PAGE_SIZE + rows.length;
  const pendingNeedsValue = FILTER_OPS.find((o) => o.value === pfOp)?.needsValue ?? true;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* --------------------------- Table sidebar --------------------------- */}
      <aside className={`flex w-[230px] shrink-0 flex-col border-r ${tk.panel}`}>
        <div className="border-b border-zinc-800 p-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tables…"
            className={`${tk.input} w-full`}
          />
        </div>
        <nav className="flex-1 overflow-y-auto py-1">
          {tableList.length === 0 ? (
            <EmptyState>No tables</EmptyState>
          ) : (
            tableList.map((t) => (
              <button
                key={t.name}
                onClick={() => selectTable(t.name)}
                title={t.name}
                className={`block w-full truncate px-3 py-1 text-left font-mono text-xs ${
                  table === t.name ? 'bg-zinc-900 font-medium text-emerald-400' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                {t.name}
              </button>
            ))
          )}
        </nav>
      </aside>

      {/* ----------------------------- Main area ----------------------------- */}
      <main className="flex min-w-0 flex-1 flex-col">
        {!currentTable ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">Select a table</div>
        ) : (
          <>
            {/* Toolbar: multi-filter builder + chips */}
            <div className={tk.toolbar}>
              <span className={`mr-1.5 truncate font-mono text-xs ${tk.muted}`}>{currentTable.name}</span>
              <select value={pfCol} onChange={(e) => setPfCol(e.target.value)} className={tk.select}>
                <option value="">— column —</option>
                {visibleCols.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select value={pfOp} onChange={(e) => setPfOp(e.target.value as FilterOp)} className={tk.select}>
                {FILTER_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {pendingNeedsValue && (
                <input
                  type="text"
                  value={pfVal}
                  onChange={(e) => setPfVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addFilter();
                  }}
                  placeholder="value"
                  className={`${tk.input} w-40 font-mono`}
                />
              )}
              <button onClick={addFilter} disabled={!pfCol} className={tk.btn2}>
                + Filter
              </button>
              <button onClick={() => setDrawer({ mode: 'new' })} className={`${tk.btn} ml-auto`}>
                + New row
              </button>
            </div>

            {/* Active filter chips */}
            {filters.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5">
                {filters.map((f, i) => (
                  <span key={i} className={`${tk.badge} flex items-center gap-1 font-mono`}>
                    {f.col} {FILTER_OPS.find((o) => o.value === f.op)?.label}
                    {FILTER_OPS.find((o) => o.value === f.op)?.needsValue ? ` ${clip(f.val, 30)}` : ''}
                    <button
                      onClick={() => removeFilter(i)}
                      aria-label="Remove filter"
                      className="ml-0.5 text-zinc-500 hover:text-zinc-200"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button onClick={() => setView({ filters: [], page: 1 })} className={`text-[11px] ${tk.muted} hover:text-zinc-200`}>
                  clear all
                </button>
              </div>
            )}

            {/* Grid */}
            <div className="min-h-0 flex-1 overflow-auto">
              {gridError ? (
                <ErrorBox error={gridError} />
              ) : loading && rows.length === 0 ? (
                <LoadingState />
              ) : rows.length === 0 ? (
                <EmptyState>No rows</EmptyState>
              ) : (
                <table className={tk.table}>
                  <thead>
                    <tr>
                      {visibleCols.map((c) => (
                        <th key={c.name} onClick={() => toggleSort(c.name)} title={c.type} className={tk.thSortable}>
                          {c.name}
                          {c.isPk && <span className={`ml-1 ${tk.pk}`}>pk</span>}
                          {sort === c.name && <span className={`ml-0.5 ${tk.accent}`}>{dir === 'asc' ? '▲' : '▼'}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr
                        key={currentTable.pk ? `${String(row[currentTable.pk])}-${i}` : i}
                        onClick={() => setDrawer({ mode: 'view', row })}
                        className={tk.trClickable}
                      >
                        {visibleCols.map((c) => {
                          const d = cellText(row[c.name]);
                          return (
                            <td key={c.name} title={d.isNull ? 'NULL' : clip(d.text, 1000)} className={tk.td}>
                              {d.isNull ? (
                                <NullMark />
                              ) : c.family === 'enum' ? (
                                <span className={tk.badge}>{d.text}</span>
                              ) : (
                                <span className={c.family === 'number' || c.isPk ? 'font-mono' : ''}>{clip(d.text, 300)}</span>
                              )}
                              {c.fkTable && c.fkColumn && !d.isNull && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigateFk(c.fkTable!, c.fkColumn!, d.text);
                                  }}
                                  title={`→ ${c.fkTable}`}
                                  className={`ml-1.5 ${tk.link}`}
                                >
                                  →
                                </button>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination footer */}
            <div className={`flex items-center justify-between ${tk.footer}`}>
              <span>
                {rangeStart}–{rangeEnd} of {total}
                {loading ? ' · loading…' : ''}
              </span>
              <div className="flex items-center gap-1">
                <button disabled={page <= 1 || loading} onClick={() => setView({ page: page - 1 })} className={tk.btn2}>
                  Prev
                </button>
                <button disabled={rangeEnd >= total || loading} onClick={() => setView({ page: page + 1 })} className={tk.btn2}>
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Drawer */}
      {currentTable && drawer && (
        <RowDrawer
          table={currentTable}
          catalog={catalog}
          state={drawer}
          onClose={() => setDrawer(null)}
          onSetState={setDrawer}
          onSaved={(row) => {
            setDrawer({ mode: 'view', row });
            refresh();
          }}
          onDeleted={() => {
            setDrawer(null);
            refresh();
          }}
          onNavigateFk={navigateFk}
        />
      )}
    </div>
  );
}
