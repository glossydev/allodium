'use client';

import { FILTER_OPS, VALUELESS_OPS, isSafeHref, normalizeFilter, type FilterOp, type Predicate, type ViewLink } from '@allodium/admin/view';
import { tk } from '@/ui/tokens';

/**
 * The editor for a view's `links` — "View on site", "Preview" — each a URL
 * template over the row plus a condition. Nothing here is code: a template is
 * data, round-trips through the file, and a row value can never supply a
 * scheme because the template must start with "/" or http(s):// before any
 * substitution happens.
 */

const PLACEHOLDER = '/blog/{slug}';

export default function LinksEditor({ links, fieldKeys, onChange }: { links: ViewLink[]; fieldKeys: string[]; onChange: (next: ViewLink[]) => void }) {
  const patch = (i: number, next: Partial<ViewLink>) => onChange(links.map((l, j) => (j === i ? { ...l, ...next } : l)));
  const remove = (i: number) => onChange(links.filter((_, j) => j !== i));
  const add = () => onChange([...links, { label: 'View on site', href: '' }]);

  return (
    <div className="mt-4 space-y-2 border-t border-zinc-800 pt-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">links</span>
        <button onClick={add} className={`ml-auto ${tk.btn2} py-0 text-[10px]`}>
          + link
        </button>
      </div>
      <p className={`text-[10px] ${tk.muted}`}>
        Links out of the admin — to the published page, a preview, anything the row has an address for. Shown on list rows and the record screen.
      </p>
      {links.map((l, i) => {
        const unsafe = !!l.href && !isSafeHref(l.href);
        const when = normalizeFilter(l.when);
        const inList = !l.in || l.in.includes('list');
        const inForm = !l.in || l.in.includes('form');
        const setIn = (list: boolean, form: boolean) => patch(i, { in: list && form ? undefined : [...(list ? ['list' as const] : []), ...(form ? ['form' as const] : [])] });
        const setWhen = (next: Predicate[]) => patch(i, { when: next.length ? next : undefined });
        return (
          <div key={i} className="space-y-1.5 rounded border border-zinc-800 bg-zinc-950/40 p-2">
            <div className="grid grid-cols-[1fr_2fr_auto] gap-1.5">
              <input
                value={l.label}
                onChange={(e) => patch(i, { label: e.target.value })}
                placeholder="label"
                aria-label="Link label"
                className={`${tk.input} w-full`}
              />
              <input
                value={l.href}
                onChange={(e) => patch(i, { href: e.target.value })}
                placeholder={PLACEHOLDER}
                aria-label="Link address template"
                className={`${tk.input} w-full font-mono ${unsafe ? 'border-red-800' : ''}`}
              />
              <button onClick={() => remove(i)} title="Remove this link" className={`${tk.btnDanger} py-0`}>
                ✕
              </button>
            </div>
            {unsafe && <p className="text-[10px] text-red-400">The address must start with / or http(s):// — a row value can never supply the scheme.</p>}
            <div className="flex flex-wrap items-center gap-1">
              <span className={`text-[10px] ${tk.faint}`}>insert</span>
              {fieldKeys.map((k) => (
                <button
                  key={k}
                  onClick={() => patch(i, { href: `${l.href}{${k}}` })}
                  title={`Append {${k}} to the address — substituted and URL-encoded per row`}
                  className={`${tk.badge} font-mono hover:text-zinc-100`}
                >
                  {`{${k}}`}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[10px]">
              <label className={`flex items-center gap-1 ${tk.muted}`}>
                <input type="checkbox" className={tk.checkbox} checked={l.target === '_blank'} onChange={(e) => patch(i, { target: e.target.checked ? '_blank' : undefined })} />
                new tab
              </label>
              <label className={`flex items-center gap-1 ${tk.muted}`}>
                <input type="checkbox" className={tk.checkbox} checked={inList} onChange={(e) => setIn(e.target.checked, inForm)} />
                on list rows
              </label>
              <label className={`flex items-center gap-1 ${tk.muted}`}>
                <input type="checkbox" className={tk.checkbox} checked={inForm} onChange={(e) => setIn(inList, e.target.checked)} />
                on the record
              </label>
              {!inList && !inForm && <span className="text-amber-400">shown nowhere</span>}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] ${tk.faint}`}>only when</span>
                <button
                  onClick={() => setWhen([...when, { column: fieldKeys[0] ?? '', op: 'eq', value: '' }])}
                  className={`${tk.badge} hover:text-zinc-100`}
                >
                  + condition
                </button>
                {when.length === 0 && <span className={`text-[10px] ${tk.faint}`}>every row</span>}
              </div>
              {when.map((p, j) => {
                const valueless = VALUELESS_OPS.includes(p.op as FilterOp);
                const setP = (next: Partial<Predicate>) => setWhen(when.map((q, k) => (k === j ? { ...q, ...next } : q)));
                return (
                  <div key={j} className="flex items-center gap-1">
                    <select value={p.column} onChange={(e) => setP({ column: e.target.value })} aria-label="Condition column" className={`${tk.select} py-0 font-mono text-[10px]`}>
                      {!fieldKeys.includes(p.column) && <option value={p.column}>{p.column}</option>}
                      {fieldKeys.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                    <select value={p.op ?? 'eq'} onChange={(e) => setP({ op: e.target.value as FilterOp, ...(VALUELESS_OPS.includes(e.target.value as FilterOp) ? { value: undefined } : {}) })} aria-label="Condition operator" className={`${tk.select} py-0 font-mono text-[10px]`}>
                      {FILTER_OPS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                    {!valueless && (
                      <input
                        value={Array.isArray(p.value) ? p.value.join(',') : String(p.value ?? '')}
                        onChange={(e) => {
                          const raw = e.target.value;
                          // Literal true/false/null and numbers are typed; everything else is text —
                          // the same rule the URL codec does not apply, because here the author
                          // means a value, not a string that happens to look like one.
                          const value = p.op === 'in' ? raw.split(',').map((s) => s.trim()) : raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
                          setP({ value });
                        }}
                        placeholder={p.op === 'in' ? 'a, b, c' : 'value'}
                        aria-label="Condition value"
                        className={`${tk.input} w-32 py-0 font-mono text-[10px]`}
                      />
                    )}
                    <button onClick={() => setWhen(when.filter((_, k) => k !== j))} title="Remove this condition" className={`${tk.badge} hover:text-red-300`}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
