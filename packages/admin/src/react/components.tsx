'use client';

import type { ResolvedField } from '../server/resolver.js';
import { useAdminForm, useAdminList, type AdminClientConfig } from './hooks.js';

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

  const formFields = view.fields.filter((f) => f.in.includes('form'));

  return (
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
  );
}

/* -------------------------------- list ---------------------------------- */

export function AdminList({
  config,
  onSelect,
  onNew,
}: {
  config: AdminClientConfig;
  onSelect?: (id: unknown, row: Record<string, unknown>) => void;
  onNew?: () => void;
}) {
  const list = useAdminList(config);
  const { view, rows, total, page, pageCount, loading, error } = list;

  if (error && !view) return <p data-allodium="error">{error}</p>;
  if (!view) return <p data-allodium="loading">Loading…</p>;

  const columns = view.list.columns
    .map((key) => view.fields.find((f) => f.key === key))
    .filter((f): f is ResolvedField => !!f);

  return (
    <div data-allodium="list" data-view={view.table}>
      <header data-allodium="list-header">
        <h1>{view.title}</h1>
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
              const id = row[view.primaryKey];
              return (
                <tr
                  key={String(id ?? i)}
                  data-allodium="row"
                  onClick={onSelect ? () => onSelect(id, row) : undefined}
                  tabIndex={onSelect ? 0 : undefined}
                  onKeyDown={
                    onSelect
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
