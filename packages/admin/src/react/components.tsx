'use client';

import { useState } from 'react';
import type { ResolvedField, ResolvedRelated } from '../server/resolver.js';
import type { FilterOp } from '../view.js';
import { useAdminForm, useAdminList, type AdminClientConfig, type UseAdminListResult } from './hooks.js';

/**
 * Layer 3 — unstyled components.
 *
 * These render correct structure and semantics and NOTHING else: no colours, no
 * spacing, no layout, not one class of our own. Every element carries `data-*`
 * hooks so a stylesheet can target it precisely:
 *
 *   [data-allodium="form"]              the form element
 *   [data-allodium="field"]             one field wrapper
 *   [data-field="title"]                that wrapper, by column
 *   [data-widget="select"]              that wrapper, by input kind
 *   [data-required] [data-invalid]      state, as attributes
 *
 * That is the whole styling contract. CSS reaches everything; no theme prop, no
 * class-name soup, nothing to learn beyond the attribute names.
 *
 * Accessibility is not optional here — labels are tied to inputs with matching
 * ids, help text is wired through aria-describedby, and errors use aria-invalid.
 * A generated admin that fails a screen reader would be a worse default than
 * hand-written HTML, which defeats the point.
 *
 * When one screen needs to be genuinely different, drop it to the hooks in
 * ./hooks.ts and render whatever you like — same data, same behavior.
 */

const idFor = (view: string, key: string) => `allodium-${view}-${key}`;

/* ------------------------------- inputs -------------------------------- */

function FieldInput({
  field,
  value,
  onChange,
  options,
  inputId,
  describedBy,
  invalid,
}: {
  field: ResolvedField;
  value: unknown;
  onChange: (v: unknown) => void;
  options: { value: unknown; label: string }[];
  inputId: string;
  describedBy?: string;
  invalid: boolean;
}) {
  const common = {
    id: inputId,
    name: field.key,
    disabled: field.readOnly,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
    required: field.required || undefined,
  };
  const str = value === null || value === undefined ? '' : String(value);

  switch (field.widget) {
    case 'checkbox':
      return <input {...common} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;

    case 'number':
      return (
        <input
          {...common}
          type="number"
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );

    case 'date':
      return <input {...common} type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value || null)} />;

    case 'datetime':
      return (
        <input
          {...common}
          type="datetime-local"
          value={str.slice(0, 16)}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );

    case 'textarea':
    case 'markdown':
      return <textarea {...common} value={str} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;

    case 'json':
      return (
        <textarea
          {...common}
          value={typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              onChange(e.target.value); // keep keystrokes; the server rejects bad JSON
            }
          }}
        />
      );

    case 'tags':
      return (
        <input
          {...common}
          type="text"
          value={Array.isArray(value) ? value.join(', ') : str}
          placeholder={field.placeholder ?? 'comma separated'}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            )
          }
        />
      );

    case 'select':
      return (
        <select {...common} value={str} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
          <option value="">{field.required ? '— choose —' : '— none —'}</option>
          {(field.options ?? options.map((o) => ({ value: String(o.value), label: o.label }))).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      );

    case 'radio': {
      const list = field.options ?? options.map((o) => ({ value: String(o.value), label: o.label }));
      return (
        <span role="radiogroup" aria-labelledby={`${inputId}-label`} data-allodium="radiogroup">
          {list.map((o) => (
            <span key={String(o.value)} data-allodium="radio">
              <input
                type="radio"
                id={`${inputId}-${o.value}`}
                name={field.key}
                value={String(o.value)}
                checked={str === String(o.value)}
                disabled={field.readOnly}
                onChange={() => onChange(o.value)}
              />
              <label htmlFor={`${inputId}-${o.value}`}>{o.label}</label>
            </span>
          ))}
        </span>
      );
    }

    /* ---- many-to-many ---- */

    case 'checkboxes': {
      const selected = new Set((Array.isArray(value) ? value : []).map(String));
      return (
        <span role="group" aria-labelledby={`${inputId}-label`} data-allodium="checkboxes">
          {options.map((o) => (
            <span key={String(o.value)} data-allodium="checkbox-option">
              <input
                type="checkbox"
                id={`${inputId}-${o.value}`}
                checked={selected.has(String(o.value))}
                disabled={field.readOnly}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(String(o.value));
                  else next.delete(String(o.value));
                  // Emit the option's original values so ids keep their real types.
                  onChange(options.filter((x) => next.has(String(x.value))).map((x) => x.value));
                }}
              />
              <label htmlFor={`${inputId}-${o.value}`}>{o.label}</label>
            </span>
          ))}
        </span>
      );
    }

    case 'multiselect': {
      const selected = new Set((Array.isArray(value) ? value : []).map(String));
      return (
        <select
          {...common}
          multiple
          value={[...selected]}
          onChange={(e) => {
            const picked = new Set([...e.target.selectedOptions].map((o) => o.value));
            onChange(options.filter((x) => picked.has(String(x.value))).map((x) => x.value));
          }}
        >
          {options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }

    default:
      return <input {...common} type="text" value={str} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

/* -------------------------------- form --------------------------------- */

export function AdminForm({
  config,
  id,
  onSaved,
  onDeleted,
}: {
  config: AdminClientConfig;
  id?: string | number | null;
  onSaved?: (row: Record<string, unknown>) => void;
  onDeleted?: () => void;
}) {
  const form = useAdminForm({ ...config, id });
  const { view, values, setValue, optionsFor, problems, dirty, saving, loading, error } = form;

  if (error && !view) return <p data-allodium="error">{error}</p>;
  if (!view || loading) return <p data-allodium="loading">Loading…</p>;

  // A record screen addresses one row, and some tables have nothing to address
  // one BY — a join table's key spans columns. Say so plainly instead of
  // rendering a form whose every save would fail.
  if (view.primaryKey === null) {
    return (
      <p data-allodium="error" role="note">
        {view.title} has no single-column primary key, so individual rows cannot be opened or edited. The list still works.
      </p>
    );
  }

  const formFields = view.fields.filter((f) => f.in.includes('form'));

  return (
    <>
    <form
      data-allodium="form"
      data-view={view.table}
      onSubmit={async (e) => {
        e.preventDefault();
        const row = await form.save();
        if (row) onSaved?.(row);
      }}
    >
      <header data-allodium="form-header">
        <h1>{view.title}</h1>
        {view.description && <p data-allodium="description">{view.description}</p>}
      </header>

      {view.warnings?.length > 0 && (
        <ul data-allodium="warnings">
          {view.warnings.map((w) => (
            <li key={w} data-allodium="warning">
              {w}
            </li>
          ))}
        </ul>
      )}

      {formFields.map((f) => {
        const inputId = idFor(view.table, f.key);
        const helpId = f.help ? `${inputId}-help` : undefined;
        const errId = problems[f.key] ? `${inputId}-error` : undefined;
        const describedBy = [helpId, errId].filter(Boolean).join(' ') || undefined;
        return (
          <div
            key={f.key}
            data-allodium="field"
            data-field={f.key}
            data-widget={f.widget}
            data-required={f.required || undefined}
            data-invalid={problems[f.key] ? '' : undefined}
          >
            <label id={`${inputId}-label`} htmlFor={inputId} data-allodium="label">
              {f.label}
              {f.required && <span data-allodium="required-mark" aria-hidden="true"> *</span>}
            </label>
            <FieldInput
              field={f}
              value={values[f.key]}
              onChange={(v) => setValue(f.key, v)}
              options={optionsFor(f.key)}
              inputId={inputId}
              describedBy={describedBy}
              invalid={!!problems[f.key]}
            />
            {f.help && (
              <p id={helpId} data-allodium="help">
                {f.help}
              </p>
            )}
            {problems[f.key] && (
              <p id={errId} data-allodium="field-error" role="alert">
                {problems[f.key]}
              </p>
            )}
          </div>
        );
      })}

      {error && (
        <p data-allodium="error" role="alert">
          {error}
        </p>
      )}

      <footer data-allodium="form-actions">
        <button type="submit" data-allodium="save" disabled={saving || !dirty || !form.valid}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button type="button" data-allodium="reset" onClick={form.reset} disabled={saving}>
            Discard
          </button>
        )}
        {id !== undefined && id !== null && (
          <button
            type="button"
            data-allodium="delete"
            disabled={saving}
            onClick={async () => {
              if (await form.remove()) onDeleted?.();
            }}
          >
            Delete
          </button>
        )}
      </footer>
    </form>

    {/* Outside the <form>, not inside it: a panel contains its own controls, and
        nesting interactive lists in the form that edits the parent record makes
        every stray Enter keypress ambiguous. */}
    {view.related.map((r) => (
      <AdminRelated
        key={r.key}
        baseUrl={config.baseUrl}
        related={r}
        parentValue={values[r.references]}
        fetchOptions={config.fetchOptions}
      />
    ))}
    </>
  );
}

/* -------------------------------- list ---------------------------------- */

/**
 * One panel of rows that belong to the record on screen.
 *
 * There is no new fetching machinery here on purpose. A related list IS a list
 * with a bound scope — "orders where customer_id = 41" — so it renders the same
 * component against the same endpoint, and everything the list already does
 * (sorting, searching, the operator's own filters, pagination) keeps working
 * inside the panel. That the feature needed no new query path is the payoff for
 * having made the scope a predicate rather than a special case.
 */
export function AdminRelated({
  baseUrl,
  related,
  parentValue,
  fetchOptions,
  onSelect,
}: {
  baseUrl: string;
  related: ResolvedRelated;
  /** The value of the parent row's referenced column — usually its id. */
  parentValue: unknown;
  fetchOptions?: RequestInit;
  onSelect?: (id: unknown, row: Record<string, unknown>) => void;
}) {
  // Nothing to scope by yet: a record that has not been saved has no id, and an
  // unbound panel would list EVERY row of the related table under a heading
  // claiming they belong to this one.
  if (parentValue === null || parentValue === undefined || parentValue === '') return null;

  return (
    <section data-allodium="related" data-related={related.key}>
      <h2 data-allodium="related-title">{related.title}</h2>
      <AdminList
        title={null}
        onSelect={onSelect}
        // The column every row shares is the one that put them in this panel.
        // Repeating "Elise Moreau" down a list headed by Elise Moreau is noise.
        hideColumns={[related.foreignKey]}
        config={{
          baseUrl,
          view: related.view,
          // The catalog-validated fact. `view` is only what someone named a file,
          // so the server prefers a definition that is genuinely about this table.
          table: related.table,
          fetchOptions,
          boundFilters: [{ column: related.foreignKey, op: 'eq', value: parentValue as string | number }],
        }}
      />
    </section>
  );
}

/**
 * Which comparisons make sense for a field, in the order an operator reaches for
 * them. Derived from the column's family — the catalog already knows the type, so
 * asking a human to say "this is a number" again would be the duplication this
 * project keeps deleting.
 */
function operatorsFor(field: ResolvedField): FilterOp[] {
  const nullable: FilterOp[] = ['isNull', 'notNull'];
  if (field.kind === 'relation') return ['contains', 'eq', 'startsWith', 'ne', ...nullable];
  if (field.options?.length) return ['eq', 'ne', 'in', ...nullable];
  switch (field.family) {
    case 'number':
      return ['eq', 'gt', 'gte', 'lt', 'lte', 'ne', ...nullable];
    case 'date':
    case 'datetime':
      return ['gte', 'lte', 'eq', 'gt', 'lt', ...nullable];
    case 'boolean':
      return ['eq', ...nullable];
    default:
      return ['contains', 'eq', 'startsWith', 'endsWith', 'ne', ...nullable];
  }
}

const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  ne: 'is not',
  lt: 'is before / less than',
  lte: 'is at most',
  gt: 'is after / greater than',
  gte: 'is at least',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  in: 'is any of',
  isNull: 'is empty',
  notNull: 'is not empty',
};

/**
 * A relation filters on the NAME the row displays, not the foreign key — the
 * operator is looking at "Ada Lovelace" and has no idea the column holds 41.
 * That is addressed by the same key the row carries the label under.
 */
const filterColumnFor = (f: ResolvedField) => (f.kind === 'relation' ? `${f.key}__label` : f.key);
const fieldKeyOfFilter = (column: string) => (column.endsWith('__label') ? column.slice(0, -'__label'.length) : column);

/** The value control for one predicate, chosen from what the catalog already told us. */
function FilterValueInput({
  field,
  op,
  value,
  onChange,
}: {
  field: ResolvedField;
  op: FilterOp;
  value: string;
  onChange: (v: string) => void;
}) {
  if (op === 'isNull' || op === 'notNull') return null;

  const common = {
    'data-allodium': 'filter-value',
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(e.target.value),
    'aria-label': `${field.label} value`,
  } as const;

  // An enum knows its own members; offering free text there invites a filter
  // that matches nothing and gives no clue why.
  if (field.options?.length && op !== 'in') {
    return (
      <select {...common}>
        <option value="">—</option>
        {field.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.family === 'boolean') {
    return (
      <select {...common}>
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  const type =
    field.kind === 'relation' ? 'text' : field.family === 'number' ? 'number' : field.family === 'date' ? 'date' : field.family === 'datetime' ? 'datetime-local' : 'text';
  return <input {...common} type={type} placeholder={op === 'in' ? 'comma, separated' : undefined} />;
}

/**
 * The filter bar.
 *
 * Two kinds of restriction appear here and they are deliberately NOT
 * interchangeable. The operator's own filters are chips they can edit and
 * remove. The view's baseline is stated in words and has no remove control,
 * because it cannot be removed — rendering it as a dismissible chip would be a
 * lie about who is in charge of it. A screen that quietly hides rows and says
 * nothing is the failure this whole project keeps designing against.
 */
function FilterBar({ list }: { list: UseAdminListResult }) {
  const view = list.view!;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ column: string; op: FilterOp; value: string } | null>(null);

  const filterable = view.fields.filter((f) => f.filterable && f.kind !== 'm2m' && f.in.includes('list'));
  if (!filterable.length && !view.list.filter.length) return null;

  const fieldFor = (column: string) => view.fields.find((f) => f.key === fieldKeyOfFilter(column));

  const startAdding = () => {
    const first = filterable[0];
    if (!first) return;
    setDraft({ column: filterColumnFor(first), op: operatorsFor(first)[0], value: '' });
    setAdding(true);
  };

  const commit = () => {
    if (!draft) return;
    const valueless = draft.op === 'isNull' || draft.op === 'notNull';
    if (!valueless && draft.value === '') return; // nothing to compare against yet
    list.addFilter({
      column: draft.column,
      op: draft.op,
      ...(valueless ? {} : { value: draft.op === 'in' ? draft.value.split(',').map((s) => s.trim()) : draft.value }),
    });
    setDraft(null);
    setAdding(false);
  };

  return (
    <div data-allodium="filters">
      {view.list.filter.length > 0 && (
        <p data-allodium="filter-baseline" role="note">
          This screen always excludes some rows ({view.list.filter.length}{' '}
          {view.list.filter.length === 1 ? 'rule' : 'rules'} set by the view).
        </p>
      )}

      <ul data-allodium="filter-chips">
        {list.filters.map((p, i) => {
          const f = fieldFor(p.column);
          const valueless = p.op === 'isNull' || p.op === 'notNull';
          return (
            <li key={`${p.column}-${i}`} data-allodium="filter-chip" data-field={p.column}>
              <span data-allodium="filter-label">
                {f?.label ?? p.column} {OP_LABELS[(p.op ?? 'eq') as FilterOp]}
                {valueless ? '' : ` ${Array.isArray(p.value) ? p.value.join(', ') : String(p.value ?? '')}`}
              </span>
              <button
                type="button"
                data-allodium="filter-remove"
                aria-label={`Remove filter on ${f?.label ?? p.column}`}
                onClick={() => list.removeFilter(i)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      {adding && draft ? (
        <div data-allodium="filter-draft">
          <select
            data-allodium="filter-field"
            aria-label="Field to filter on"
            value={draft.column}
            onChange={(e) => {
              const f = fieldFor(e.target.value)!;
              setDraft({ column: e.target.value, op: operatorsFor(f)[0], value: '' });
            }}
          >
            {filterable.map((f) => (
              <option key={f.key} value={filterColumnFor(f)}>
                {f.label}
              </option>
            ))}
          </select>

          <select
            data-allodium="filter-op"
            aria-label="Comparison"
            value={draft.op}
            onChange={(e) => setDraft({ ...draft, op: e.target.value as FilterOp })}
          >
            {operatorsFor(fieldFor(draft.column)!).map((op) => (
              <option key={op} value={op}>
                {OP_LABELS[op]}
              </option>
            ))}
          </select>

          <FilterValueInput
            field={fieldFor(draft.column)!}
            op={draft.op}
            value={draft.value}
            onChange={(v) => setDraft({ ...draft, value: v })}
          />

          <button type="button" data-allodium="filter-apply" onClick={commit}>
            Apply
          </button>
          <button
            type="button"
            data-allodium="filter-cancel"
            onClick={() => {
              setDraft(null);
              setAdding(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        filterable.length > 0 && (
          <button type="button" data-allodium="filter-add" onClick={startAdding}>
            + Filter
          </button>
        )
      )}

      {list.filters.length > 1 && (
        <button type="button" data-allodium="filter-clear" onClick={() => list.clearFilters()}>
          Clear all
        </button>
      )}
    </div>
  );
}

export function AdminList({
  config,
  onSelect,
  onNew,
  title,
  hideColumns,
}: {
  config: AdminClientConfig;
  onSelect?: (id: unknown, row: Record<string, unknown>) => void;
  onNew?: () => void;
  /** Override the heading; `null` omits it, for a panel that supplies its own. */
  title?: string | null;
  /** Columns to drop from this rendering — not from the view. */
  hideColumns?: string[];
}) {
  const list = useAdminList(config);
  const { view, rows, total, page, pageCount, loading, error } = list;

  if (error && !view) return <p data-allodium="error">{error}</p>;
  if (!view) return <p data-allodium="loading">Loading…</p>;

  const columns = view.list.columns
    .map((key) => view.fields.find((f) => f.key === key))
    .filter((f): f is ResolvedField => !!f)
    .filter((f) => !hideColumns?.includes(f.key));

  return (
    <div data-allodium="list" data-view={view.table}>
      <header data-allodium="list-header">
        {title !== null && <h1>{title ?? view.title}</h1>}
        {view.list.searchColumns.length > 0 && (
          <input
            type="search"
            data-allodium="search"
            value={list.search}
            placeholder={`Search ${view.title.toLowerCase()}`}
            aria-label={`Search ${view.title}`}
            onChange={(e) => list.setSearch(e.target.value)}
          />
        )}
        {onNew && (
          <button type="button" data-allodium="new" onClick={onNew}>
            New
          </button>
        )}
      </header>

      <FilterBar list={list} />

      <table data-allodium="table">
        <thead>
          <tr>
            {columns.map((f) => (
              <th key={f.key} data-field={f.key} aria-sort={list.sort === f.key ? (list.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" data-allodium="sort" onClick={() => list.toggleSort(f.key)}>
                  {f.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading ? (
            <tr>
              <td colSpan={columns.length} data-allodium="empty">
                Nothing here yet.
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              // No primary key means no row screen to open — a join table's rows
              // are addressed by a composite key, so there is nothing to put in a
              // URL. The list still renders; the rows just are not links, and the
              // React key falls back to position.
              const id = view.primaryKey ? row[view.primaryKey] : undefined;
              const selectable = onSelect && view.primaryKey !== null;
              return (
                <tr
                  key={String(id ?? i)}
                  data-allodium="row"
                  onClick={selectable ? () => onSelect(id, row) : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  onKeyDown={
                    selectable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(id, row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((f) => {
                    const v = list.cell(row, f);
                    return (
                      <td key={f.key} data-field={f.key} data-widget={f.widget}>
                        {v === null || v === undefined || v === '' ? (
                          <span data-allodium="null" aria-label="empty" />
                        ) : typeof v === 'boolean' ? (
                          <span data-allodium="boolean">{v ? 'Yes' : 'No'}</span>
                        ) : (
                          String(v)
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <footer data-allodium="pagination">
        <span data-allodium="count">{total} total</span>
        <button type="button" data-allodium="prev" disabled={page <= 1 || loading} onClick={() => list.setPage(page - 1)}>
          Previous
        </button>
        <span data-allodium="page">
          {page} / {pageCount}
        </span>
        <button type="button" data-allodium="next" disabled={page >= pageCount || loading} onClick={() => list.setPage(page + 1)}>
          Next
        </button>
      </footer>
    </div>
  );
}
