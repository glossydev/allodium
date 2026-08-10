'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedField, ResolvedView } from '../server/resolver.js';
import { type Predicate, filtersToParams } from '../view.js';

/**
 * Layer 2 — data and behavior, zero markup.
 *
 * Everything an admin screen has to DO lives here: fetching, pagination, search,
 * dirty tracking, validation, relation options, save and delete. A consumer that
 * wants a completely custom look renders from these and never touches layer 3.
 *
 * The hooks talk to an HTTP endpoint rather than the database directly, because
 * they run in the browser. `baseUrl` points at wherever the app mounted the admin
 * handlers; nothing else about the server is assumed.
 */

export interface AdminClientConfig {
  /** Where the admin routes are mounted, e.g. "/api/admin". */
  baseUrl: string;
  /** Which view to operate on — the key the server resolves to a definition. */
  view: string;
  /**
   * The table this screen must be about, when the caller knows it.
   *
   * A related panel does: its table came from the catalog, while `view` is only
   * the name someone gave a file. Sending it lets the server prefer a definition
   * that genuinely covers the table over one that merely shares its filename —
   * and fall back to a default screen when no view exists yet, rather than 404.
   */
  table?: string;
  /** Passed to every request (auth headers, credentials, …). */
  fetchOptions?: RequestInit;
  /**
   * Filters to start from — read these out of the page URL to make a narrowed
   * list shareable. `parseFilterParams` turns the query string back into them.
   */
  initialFilters?: Predicate[];
  /**
   * The scope this list exists inside — "the orders OF THIS CUSTOMER".
   *
   * Applied to every request and deliberately kept out of `filters`, so no UI can
   * render it as a removable chip. Clearing it would not narrow the screen, it
   * would change what the screen IS.
   *
   * It is a scope, NOT an authorization boundary: it travels as a query parameter
   * and a caller can send whatever they like. What a user may read is the
   * permission layer's job, and always was.
   */
  boundFilters?: Predicate[];
}

async function request<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `Request failed (${res.status})`;
      return { ok: false, error: msg };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request failed' };
  }
}

/* ------------------------------- the view -------------------------------- */

export function useAdminView(config: AdminClientConfig) {
  const [view, setView] = useState<ResolvedView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = config.table ? `?table=${encodeURIComponent(config.table)}` : '';
    request<ResolvedView>(`${config.baseUrl}/${config.view}/view${q}`, config.fetchOptions).then((r) => {
      if (cancelled) return;
      if (r.ok) setView(r.data);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [config.baseUrl, config.view, config.table]);

  return { view, error, loading: !view && !error };
}

/* --------------------------------- list ---------------------------------- */

export interface UseAdminListResult {
  view: ResolvedView | null;
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  search: string;
  sort: string | null;
  direction: 'asc' | 'desc';
  /**
   * The operator's own filters — theirs to add, change and clear.
   *
   * Deliberately NOT merged with the view's baseline (`view.list.filter`): that
   * one is authored, always applies, and cannot be cleared from here. Showing
   * them as one list would invite a UI that lets you remove a restriction it
   * cannot actually remove.
   */
  filters: Predicate[];
  loading: boolean;
  error: string | null;
  setPage(n: number): void;
  setSearch(s: string): void;
  toggleSort(column: string): void;
  addFilter(p: Predicate): void;
  updateFilter(index: number, p: Predicate): void;
  removeFilter(index: number): void;
  clearFilters(): void;
  /** The filters as URL parameters, for pushing to the address bar. */
  filterParams: string[];
  refresh(): void;
  /** Display value for a cell, preferring a relation's resolved label. */
  cell(row: Record<string, unknown>, field: ResolvedField): unknown;
}

export function useAdminList(config: AdminClientConfig): UseAdminListResult {
  const { view, error: viewError } = useAdminView(config);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearchRaw] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<string | null>(null);
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [filters, setFilters] = useState<Predicate[]>(config.initialFilters ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Serialized here so the request effect depends on a stable string rather than
  // an array identity that changes on every render. The bound scope is encoded
  // separately: it belongs in the request but never in the operator's chips, and
  // a caller that re-creates the array each render must not re-fetch forever.
  const filterParams = useMemo(() => filtersToParams(filters), [filters]);
  const boundParams = useMemo(() => filtersToParams(config.boundFilters ?? []), [JSON.stringify(config.boundFilters ?? [])]);
  const filterKey = [...boundParams, ...filterParams].join('&');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page) });
    // Must match what useAdminView asked for, or the columns and the rows would
    // come from two different definitions.
    if (config.table) p.set('table', config.table);
    if (debounced) p.set('search', debounced);
    if (sort) {
      p.set('sort', sort);
      p.set('direction', direction);
    }
    // Scope travels on its own parameter, not as a filter. The server checks it
    // against the TABLE rather than the view's fields, so a panel still works
    // when its view omits the key it is bound by.
    for (const f of boundParams) p.append('scope', f);
    for (const f of filterParams) p.append('filter', f);
    request<{ rows: Record<string, unknown>[]; total: number }>(`${config.baseUrl}/${config.view}/list?${p}`, config.fetchOptions).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setRows(r.data.rows);
        setTotal(r.data.total);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [view, page, debounced, sort, direction, filterKey, tick, config.baseUrl, config.view, config.table, boundParams, filterParams]);

  // Any change to the filter set puts you back on page 1 — staying on page 7 of a
  // result set that now has two pages shows an empty table and looks like a bug.
  const changeFilters = useCallback((next: Predicate[] | ((cur: Predicate[]) => Predicate[])) => {
    setFilters((cur) => (typeof next === 'function' ? next(cur) : next));
    setPage(1);
  }, []);

  const toggleSort = useCallback(
    (column: string) => {
      if (sort === column) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSort(column);
        setDirection('asc');
      }
      setPage(1);
    },
    [sort]
  );

  const cell = useCallback((row: Record<string, unknown>, field: ResolvedField) => {
    // A relation resolves to a human label server-side; fall back to the raw id.
    if (field.kind === 'relation' && `${field.key}__label` in row) return row[`${field.key}__label`];
    return row[field.key];
  }, []);

  return {
    view,
    rows,
    total,
    page,
    pageSize: view?.list.pageSize ?? 25,
    pageCount: Math.max(1, Math.ceil(total / (view?.list.pageSize ?? 25))),
    search,
    sort: sort ?? view?.list.sort.column ?? null,
    direction,
    filters,
    filterParams,
    loading,
    error: error ?? viewError,
    setPage,
    setSearch: setSearchRaw,
    toggleSort,
    addFilter: (p: Predicate) => changeFilters((cur) => [...cur, p]),
    updateFilter: (i: number, p: Predicate) => changeFilters((cur) => cur.map((x, n) => (n === i ? p : x))),
    removeFilter: (i: number) => changeFilters((cur) => cur.filter((_, n) => n !== i)),
    clearFilters: () => changeFilters([]),
    refresh: () => setTick((n) => n + 1),
    cell,
  };
}

/* --------------------------------- form ---------------------------------- */

export interface UseAdminFormResult {
  view: ResolvedView | null;
  values: Record<string, unknown>;
  setValue(key: string, value: unknown): void;
  /** Options for a relation or m2m field, loaded on demand. */
  optionsFor(key: string): { value: unknown; label: string }[];
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  error: string | null;
  /** Per-field validation messages, computed from the resolved view. */
  problems: Record<string, string>;
  valid: boolean;
  save(): Promise<Record<string, unknown> | null>;
  remove(): Promise<boolean>;
  reset(): void;
}

export function useAdminForm(config: AdminClientConfig & { id?: string | number | null }): UseAdminFormResult {
  const { view, error: viewError } = useAdminView(config);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [initial, setInitial] = useState<Record<string, unknown>>({});
  const [options, setOptions] = useState<Record<string, { value: unknown; label: string }[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = config.id === undefined || config.id === null || config.id === '';
  const requested = useRef(new Set<string>());

  // Load the record (or start blank for a new one).
  useEffect(() => {
    if (!view) return;
    if (isNew) {
      const blank: Record<string, unknown> = {};
      for (const f of view.fields) blank[f.key] = f.kind === 'm2m' ? [] : null;
      setValues(blank);
      setInitial(blank);
      return;
    }
    let cancelled = false;
    setLoading(true);
    request<Record<string, unknown>>(`${config.baseUrl}/${config.view}/record/${encodeURIComponent(String(config.id))}`, config.fetchOptions).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setValues(r.data);
        setInitial(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [view, config.id, isNew, config.baseUrl, config.view]);

  // Relation options: one request per relation field, once.
  useEffect(() => {
    if (!view) return;
    for (const f of view.fields) {
      if (!f.source || requested.current.has(f.key)) continue;
      requested.current.add(f.key);
      request<{ options: { value: unknown; label: string }[] }>(
        `${config.baseUrl}/${config.view}/options/${encodeURIComponent(f.key)}`,
        config.fetchOptions
      ).then((r) => {
        if (r.ok) setOptions((prev) => ({ ...prev, [f.key]: r.data.options }));
      });
    }
  }, [view, config.baseUrl, config.view]);

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const problems = useMemo(() => {
    const out: Record<string, string> = {};
    if (!view) return out;
    for (const f of view.fields) {
      if (!f.required || f.readOnly) continue;
      const v = values[f.key];
      const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
      if (empty) out[f.key] = `${f.label} is required`;
    }
    return out;
  }, [view, values]);

  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);

  const save = useCallback(async () => {
    if (!view) return null;
    setSaving(true);
    setError(null);
    // Only send what the operator actually touched, so untouched columns keep their
    // database defaults on create instead of being explicitly nulled.
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (JSON.stringify(v) !== JSON.stringify(initial[k])) payload[k] = v;
      else if (isNew && v !== null && !(Array.isArray(v) && v.length === 0)) payload[k] = v;
    }
    const url = isNew
      ? `${config.baseUrl}/${config.view}/record`
      : `${config.baseUrl}/${config.view}/record/${encodeURIComponent(String(config.id))}`;
    const r = await request<Record<string, unknown>>(url, {
      ...config.fetchOptions,
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(config.fetchOptions?.headers ?? {}) },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return null;
    }
    setInitial(values);
    return r.data;
  }, [view, values, initial, isNew, config.baseUrl, config.view, config.id]);

  const remove = useCallback(async () => {
    if (isNew) return false;
    setSaving(true);
    setError(null);
    const r = await request(`${config.baseUrl}/${config.view}/record/${encodeURIComponent(String(config.id))}`, {
      ...config.fetchOptions,
      method: 'DELETE',
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    return true;
  }, [isNew, config.baseUrl, config.view, config.id]);

  return {
    view,
    values,
    setValue,
    optionsFor: (key) => options[key] ?? [],
    dirty,
    saving,
    loading,
    error: error ?? viewError,
    problems,
    valid: Object.keys(problems).length === 0,
    save,
    remove,
    reset: () => setValues(initial),
  };
}
