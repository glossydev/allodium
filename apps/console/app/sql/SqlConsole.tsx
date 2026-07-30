'use client';

import { useCallback, useEffect, useState } from 'react';
import { tk } from '@/ui/tokens';
import { cellText, clip, NullMark, fetchJson } from '@/ui/primitives';

/** Read-only SQL console. The sandbox is structural (see the API route). */

interface SqlResult {
  fields: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
  /** Column names redacted server-side because they resolve to masked columns. */
  maskedColumns?: string[];
  /** True when running as the SELECT-only role rather than the app role. */
  leastPrivilege?: boolean;
}

const HISTORY_KEY = 'allodium-console-sql-history';
const HISTORY_MAX = 20;

const PLACEHOLDER = `select table_name, table_type from information_schema.tables where table_schema = 'public';`;

export default function SqlConsole() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      // Validate the SHAPE too, not just that it parsed — a corrupt entry would
      // otherwise crash the page on render (.replaceAll on a non-string).
      if (Array.isArray(parsed)) setHistory(parsed.filter((h): h is string => typeof h === 'string'));
    } catch {
      /* localStorage unavailable/corrupt — history is a nicety */
    }
  }, []);

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q || running) return;
    setRunning(true);
    setError(null);
    const r = await fetchJson<SqlResult>('/api/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    setRunning(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setResult(r.data);
    setHistory((prev) => {
      const next = [q, ...prev.filter((h) => h !== q)].slice(0, HISTORY_MAX);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [query, running]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Editor */}
      <div className="border-b border-zinc-800 bg-zinc-900 p-3">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
          placeholder={PLACEHOLDER}
          rows={7}
          spellCheck={false}
          className={`${tk.input} w-full resize-y font-mono leading-relaxed`}
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={run} disabled={running || !query.trim()} className={tk.btn}>
            {running ? 'Running…' : 'Run'}
          </button>
          <span className={`text-[11px] ${tk.faint}`}>Ctrl+Enter</span>
          {result && !error && (
            <span className={`ml-auto text-[11px] ${tk.muted}`}>
              {result.rowCount} row{result.rowCount === 1 ? '' : 's'} in {result.ms} ms
              {result.truncated ? ` · showing first ${result.rows.length}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className={`m-3 ${tk.err} whitespace-pre-wrap font-mono`}>{error}</div>
        ) : !result ? (
          history.length > 0 ? (
            <div className="p-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">History</div>
              {history.map((h, i) => (
                <button
                  key={i}
                  onClick={() => setQuery(h)}
                  title={h}
                  className="block w-full truncate px-1 py-0.5 text-left font-mono text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-emerald-300"
                >
                  {clip(h.replaceAll('\n', ' '), 140)}
                </button>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center text-xs text-zinc-600">Results appear here</div>
          )
        ) : result.rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-zinc-600">
            {result.fields.length ? 'No rows' : 'Statement ran (no result set)'}
          </div>
        ) : (
          <table className={tk.table}>
            <thead>
              <tr>
                <th className={`${tk.th} w-10 text-right`}>#</th>
                {result.fields.map((f, i) => (
                  <th key={i} className={`${tk.th} font-mono`}>
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className={tk.tr}>
                  <td className={`${tk.td} w-10 text-right font-mono text-zinc-600`}>{i + 1}</td>
                  {row.map((v, j) => {
                    const d = cellText(v);
                    return (
                      <td key={j} title={d.isNull ? 'NULL' : clip(d.text, 1000)} className={`${tk.td} font-mono`}>
                        {d.isNull ? <NullMark /> : clip(d.text, 300)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={tk.footer}>
        One statement per run, inside a read-only transaction with a 10s timeout — nothing commits.
        {result?.leastPrivilege === false && (
          <span className="ml-1 text-amber-400">
            Running as the app role: set CONSOLE_RO_DATABASE_URL (see dev/seed/004-readonly-role.sql) so privileges,
            not session settings, are the floor.
          </span>
        )}
        {result?.maskedColumns && result.maskedColumns.length > 0 && (
          <span className="ml-1 text-zinc-400">Redacted: {result.maskedColumns.join(', ')}.</span>
        )}
      </div>
    </div>
  );
}
