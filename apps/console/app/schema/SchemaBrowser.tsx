'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { tk } from '@/ui/tokens';
import { prettyBytes, NullMark, ErrorBox, EmptyState, LoadingState, fetchJson } from '@/ui/primitives';
import type { ClientCatalog, ClientTable } from '../content/types';
import { CreateTableModal, JoinTableModal, AddColumnModal, ConfirmDdlModal } from './builders';
import ForeignKeyPanel from './ForeignKeyPanel';
import ColumnEditor from './ColumnEditor';
import IndexBuilder from './IndexBuilder';
import TypesPanel from './TypesPanel';
import type { ClientColumn } from '../content/types';

/**
 * Schema silo — live truth from the catalog, plus the v1 builder.
 * Left: all tables (rows/size/columns — the scan view). Right: selected table
 * detail with per-column and per-table build actions.
 */

export interface SchemaTable extends ClientTable {
  rowCount: number;
}

interface SchemaResponse extends Omit<ClientCatalog, 'tables'> {
  tables: SchemaTable[];
}

export type Refetch = () => void;

export default function SchemaBrowser() {
  const [data, setData] = useState<SchemaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [search, setSearch] = useState('');
  const [selName, setSelName] = useState<string | null>(null);
  const [view, setView] = useState<'tables' | 'types'>('tables');

  // Which builder flow is open.
  const [modal, setModal] = useState<
    | { kind: 'createTable' }
    | { kind: 'joinTable' }
    | { kind: 'addColumn'; table: string }
    | { kind: 'fk'; table: string; column: string | null }
    | { kind: 'editColumn'; table: string; columnName: string }
    | { kind: 'index'; table: string }
    | { kind: 'confirm'; title: string; action: string; params: Record<string, unknown>; danger?: string }
    | null
  >(null);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson<SchemaResponse>('/api/schema').then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const sel = useMemo(() => data?.tables.find((t) => t.name === selName) ?? null, [data, selName]);
  const tableList = useMemo(
    () => (data?.tables ?? []).filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase())),
    [data, search]
  );

  const fkFor = (col: string) => sel?.foreignKeysOut.find((f) => f.column === col) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className={tk.toolbar}>
        {/* Tables and types are both schema, but they're edited differently enough
            to deserve their own surface rather than a modal buried in the grid. */}
        <div className="flex overflow-hidden rounded border border-zinc-700">
          {(['tables', 'types'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2.5 py-1 text-xs ${view === v ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-900'}`}
            >
              {v === 'tables' ? 'Tables' : 'Types'}
            </button>
          ))}
        </div>
        {view === 'tables' && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tables…"
            className={`${tk.input} w-44`}
          />
        )}
        <span className={`text-xs ${tk.muted}`}>
          {data && view === 'tables' ? `${data.tables.length} tables` : ''}
          {loading ? (data ? ' · refreshing…' : ' loading…') : ''}
        </span>
        <button onClick={refetch} disabled={loading} className={`${tk.btn2} ml-auto`}>
          Refresh
        </button>
        {view === 'tables' && (
          <>
            <button onClick={() => setModal({ kind: 'joinTable' })} className={tk.btn2}>
              + Join table
            </button>
            <button onClick={() => setModal({ kind: 'createTable' })} className={tk.btn}>
              + New table
            </button>
          </>
        )}
      </div>

      {view === 'types' && data && <TypesPanel enums={data.enums} tables={data.tables} onChanged={refetch} />}

      <div className={`flex min-h-0 flex-1 ${view === 'types' ? 'hidden' : ''}`}>
        {/* Overview grid */}
        <div className="min-w-0 flex-1 overflow-auto">
          {error ? (
            <ErrorBox error={error} />
          ) : !data ? (
            <LoadingState />
          ) : tableList.length === 0 ? (
            <EmptyState>No tables</EmptyState>
          ) : (
            <table className={tk.table}>
              <thead>
                <tr>
                  {['table', 'rows', 'size', 'columns', 'fks'].map((h) => (
                    <th key={h} className={tk.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableList.map((t) => (
                  <tr
                    key={t.name}
                    onClick={() => setSelName(t.name)}
                    className={`${tk.trClickable} ${selName === t.name ? 'bg-emerald-950/30' : ''}`}
                  >
                    <td className={`${tk.td} font-mono`}>{t.name}</td>
                    <td className={`${tk.td} font-mono tabular-nums`}>{t.rowCount}</td>
                    <td className={`${tk.td} tabular-nums`}>{t.sizePretty}</td>
                    <td className={`${tk.td} tabular-nums`}>{t.columns.length}</td>
                    <td className={`${tk.td} tabular-nums`}>
                      {t.foreignKeysOut.length > 0 && <span title="outgoing">{t.foreignKeysOut.length}→</span>}
                      {t.referencedBy.length > 0 && (
                        <span title="incoming" className="ml-1">
                          ←{t.referencedBy.length}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail pane */}
        {sel && (
          <div className={`flex w-[480px] shrink-0 flex-col border-l ${tk.panel}`}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <h2 className="flex items-center gap-2 truncate text-sm font-semibold text-zinc-100">
                <span className="font-mono">{sel.name}</span>
                <span className={tk.badge}>
                  {sel.rowCount} rows · {sel.sizePretty}
                </span>
              </h2>
              <button
                onClick={() => setSelName(null)}
                aria-label="Close"
                className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* Table actions */}
              <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 px-4 py-2">
                <Link href={`/content?table=${sel.name}`} className={`${tk.btn2} no-underline`}>
                  Browse rows
                </Link>
                <button onClick={() => setModal({ kind: 'addColumn', table: sel.name })} className={tk.btn2}>
                  + Column
                </button>
                {/* A table-level entry point: the per-column +fk was a 15px link
                    nobody found, and it only existed once a column already did. */}
                <button onClick={() => setModal({ kind: 'fk', table: sel.name, column: null })} className={tk.btn2}>
                  + Foreign key
                </button>
                <button onClick={() => setModal({ kind: 'index', table: sel.name })} className={tk.btn2}>
                  + Index
                </button>
                <button
                  onClick={() =>
                    setModal({
                      kind: 'confirm',
                      title: `Drop table ${sel.name}`,
                      action: 'dropTable',
                      params: { table: sel.name },
                      danger: sel.name,
                    })
                  }
                  className={`${tk.btnDanger} ml-auto`}
                >
                  Drop table
                </button>
              </div>

              {/* Columns */}
              <div className="px-4 pb-3 pt-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Columns</div>
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <tr>
                      {['name', 'type', 'null', 'default', '', '', ''].map((h, i) => (
                        <th key={i} className="whitespace-nowrap border-b border-zinc-800 px-1.5 py-1 text-left font-medium text-zinc-500">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sel.columns.map((c) => {
                      const fk = fkFor(c.name);
                      return (
                        <tr key={c.name} className="border-b border-zinc-800/60 align-top">
                          <td className="px-1.5 py-1 font-mono">
                            <button
                              onClick={() => setModal({ kind: 'editColumn', table: sel.name, columnName: c.name })}
                              title={`Edit ${c.name} — rename, type, nullability, default`}
                              className="text-left text-zinc-200 hover:text-emerald-300 hover:underline"
                            >
                              {c.name}
                            </button>
                            {c.masked && <span className="ml-1 italic text-zinc-600">masked</span>}
                          </td>
                          <td className="px-1.5 py-1 font-mono text-zinc-400">{c.type}</td>
                          <td className="px-1.5 py-1">{c.nullable ? 'Y' : 'N'}</td>
                          <td className="max-w-[7rem] truncate px-1.5 py-1 font-mono text-zinc-500" title={c.default ?? 'NULL'}>
                            {c.default === null ? <NullMark /> : c.default}
                          </td>
                          <td className="whitespace-nowrap px-1.5 py-1">
                            {c.isPk && <span className={tk.pk}>PK</span>}
                            {fk && (
                              <button
                                onClick={() => setSelName(fk.refTable)}
                                title={`→ ${fk.refTable}.${fk.refColumn}`}
                                className={`ml-1 font-mono text-[10px] ${tk.link}`}
                              >
                                → {fk.refTable}
                              </button>
                            )}
                          </td>
                          {/* Two separate cells with a gap: a 15px "+fk" link sat
                              directly beside the destructive drop, which is a bad
                              place to miss by one pixel. */}
                          <td className="whitespace-nowrap px-1.5 py-1 text-right">
                            {!fk && !c.isPk && (
                              <button
                                onClick={() => setModal({ kind: 'fk', table: sel.name, column: c.name })}
                                title={`Make ${c.name} a foreign key`}
                                className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-600 hover:text-emerald-300"
                              >
                                + fk
                              </button>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-1 pl-3 pr-1.5 text-right">
                            <button
                              onClick={() =>
                                setModal({
                                  kind: 'confirm',
                                  title: `Drop column ${sel.name}.${c.name}`,
                                  action: 'dropColumn',
                                  params: { table: sel.name, column: c.name },
                                  // Dropping a column destroys data irreversibly, same
                                  // as dropping a table — so it earns the same typed
                                  // confirmation rather than a single click.
                                  danger: c.name,
                                })
                              }
                              title={`Drop column ${c.name}`}
                              className="text-[11px] text-zinc-600 hover:text-red-400"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Referenced by */}
              <div className="px-4 pb-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Referenced by</div>
                {sel.referencedBy.length === 0 ? (
                  <div className="text-[11px] text-zinc-600">none</div>
                ) : (
                  <ul className="space-y-0.5">
                    {sel.referencedBy.map((r, i) => (
                      <li key={i} className="font-mono text-[11px]">
                        <button onClick={() => setSelName(r.table)} className={tk.link}>
                          {r.table}
                        </button>
                        <span className="text-zinc-500">.{r.column}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Indexes */}
              <div className="px-4 pb-4">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Indexes</div>
                {sel.indexes.length === 0 ? (
                  <div className="text-[11px] text-zinc-600">none</div>
                ) : (
                  <ul className="space-y-1.5">
                    {sel.indexes.map((ix) => {
                      // A constraint-backed index (PK/unique) must be dropped via its
                      // constraint, not DROP INDEX — so don't offer a button that fails.
                      const isConstraint = ix.name === `${sel.name}_pkey` || /_key$/.test(ix.name);
                      return (
                        <li key={ix.name} className="group flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[11px] font-medium text-zinc-300">{ix.name}</div>
                            <div className="break-all font-mono text-[10px] text-zinc-500">{ix.definition}</div>
                          </div>
                          {!isConstraint && (
                            <button
                              onClick={() =>
                                setModal({
                                  kind: 'confirm',
                                  title: `Drop index ${ix.name}`,
                                  action: 'dropIndex',
                                  params: { name: ix.name },
                                })
                              }
                              title={`Drop index ${ix.name}`}
                              className="shrink-0 text-[10px] text-zinc-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                            >
                              drop
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={tk.footer}>DDL runs against the live database — the console shows exactly what it executes.</div>

      {/* Builder flows */}
      {modal?.kind === 'createTable' && data && (
        <CreateTableModal enums={data.enums} tables={data.tables} onClose={() => setModal(null)} onDone={() => { setModal(null); refetch(); }} />
      )}
      {modal?.kind === 'joinTable' && data && (
        <JoinTableModal tables={data.tables} onClose={() => setModal(null)} onDone={() => { setModal(null); refetch(); }} />
      )}
      {modal?.kind === 'addColumn' && data && (
        <AddColumnModal table={modal.table} enums={data.enums} onClose={() => setModal(null)} onDone={() => { setModal(null); refetch(); }} />
      )}
      {modal?.kind === 'fk' && data && (
        <ForeignKeyPanel
          table={modal.table}
          column={modal.column}
          tables={data.tables}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            refetch();
          }}
        />
      )}
      {/* The column is looked up LIVE from the refetched catalog rather than passed
          as a snapshot, so applying one ALTER leaves the other controls showing
          current truth. A rename changes the identity, so the editor reports the new
          name back and the modal follows it. */}
      {modal?.kind === 'editColumn' && data && sel && (() => {
        const live = sel.columns.find((c) => c.name === modal.columnName);
        if (!live) return null;
        return (
          <ColumnEditor
            table={sel}
            column={live}
            enums={data.enums}
            onClose={() => setModal(null)}
            onDone={refetch}
            onRenamed={(newName) => setModal({ kind: 'editColumn', table: sel.name, columnName: newName })}
          />
        );
      })()}
      {modal?.kind === 'index' && sel && (
        <IndexBuilder
          table={sel}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            refetch();
          }}
        />
      )}
      {modal?.kind === 'confirm' && (
        <ConfirmDdlModal
          title={modal.title}
          action={modal.action}
          params={modal.params}
          typedConfirmation={modal.danger}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setSelName(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}
