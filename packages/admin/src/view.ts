/**
 * The view definition — the contract between the two lanes.
 *
 * The developer console WRITES these (as JSON files in your repo, committed and
 * reviewed like any other code); the admin dashboard READS them to render a
 * working screen. Nothing else passes between the lanes.
 *
 * Three properties this format is deliberately built around:
 *
 * 1. It is DATA, not code. It round-trips: the console can re-open a definition it
 *    wrote and keep editing. That rules out functions, and it is why help text and
 *    labels are strings rather than render callbacks.
 *
 * 2. It only carries what a human decided. Everything derivable from the database —
 *    a column's type, nullability, enum members, which table a foreign key points at
 *    — is read from the live catalog at render time and deliberately NOT duplicated
 *    here. A definition that restated the schema would be a second source of truth,
 *    and would rot the moment someone ran a migration.
 *
 * 3. Omission means "sensible default", never "off". A definition listing only a
 *    table name renders a usable screen. Every field below is optional except the
 *    ones with no possible default.
 */

/** Serialized form of a whole screen. This is the shape of a `.view.json` file. */
export interface ViewDefinition {
  /** Editor autocomplete only — ignored at runtime. */
  $schema?: string;

  /** SQL table this screen edits. */
  table: string;

  /** Heading. Defaults to a title-cased table name. */
  title?: string;
  /** Shown under the heading — what this screen is for, in the operator's language. */
  description?: string;

  /**
   * Column that identifies a row. Defaults to the table's primary key, which is
   * almost always right; set it only for a table whose PK is not what the URL
   * should carry.
   */
  primaryKey?: string;

  /**
   * How a row of THIS table should be labelled when something else references it —
   * a column name, or a template over columns: "{first_name} {last_name}".
   *
   * Defining it here rather than on every referencing view means a table describes
   * itself once. A relation field may still override it locally.
   */
  display?: string;

  /** Fields, in the order they should appear. Omit to expose every visible column. */
  fields?: Field[];

  /** List-screen behavior. */
  list?: ListOptions;
}

export interface ListOptions {
  /** Columns shown in the table, in order. Defaults to the first few fields. */
  columns?: string[];
  pageSize?: number;
  sort?: { column: string; direction?: 'asc' | 'desc' };
  /** Columns a search box should match against (ILIKE). */
  searchColumns?: string[];
  /**
   * Rows this screen may show AT ALL — e.g. hiding seed accounts:
   * `[{ "column": "email", "op": "ne", "value": "admin+test@example.com" }]`.
   *
   * This is a baseline the operator cannot clear, so the runtime reports how many
   * rows it removed rather than quietly showing a short list. It is a tidiness
   * tool, NOT a security boundary — anything that must not be readable belongs in
   * roles and permissions, not in a file that ships to the client.
   */
  filter?: FilterInput;
}

/* ------------------------------- filters ------------------------------- */

/**
 * A predicate — the one shape behind every way this system narrows a list.
 *
 * The same structure serves four callers that look unrelated in the UI: the
 * baseline filter on a view, the restriction on a relation picker's options, an
 * operator's ad-hoc filtering, and (once related lists land) the parent scope on
 * a nested screen — "orders where customer_id = 42" is not a special feature, it
 * is this with `op: 'eq'`.
 *
 * Deliberately flat and AND-only. Arbitrary boolean trees would make this a query
 * builder, and a query builder is a worse SQL console than the SQL console.
 */
export type FilterScalar = string | number | boolean | null;

/**
 * Comparison operators. `contains`/`startsWith`/`endsWith` match case-insensitively
 * against the value's text form, so they work on any column type; the ordered
 * comparisons deliberately do NOT cast, because '9' > '500' is true as text and
 * false as a number.
 */
export type FilterOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'startsWith' | 'endsWith' | 'in' | 'isNull' | 'notNull';

export const FILTER_OPS: readonly FilterOp[] = [
  'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'in', 'isNull', 'notNull',
];

/** Operators that carry no value; giving them one is a mistake worth reporting. */
export const VALUELESS_OPS: readonly FilterOp[] = ['isNull', 'notNull'];

export interface Predicate {
  /** A field key on the view being filtered (or a column, on a relation target). */
  column: string;
  /** Defaults to `in` for an array value, `isNull` for null, `eq` otherwise. */
  op?: FilterOp;
  value?: FilterScalar | FilterScalar[];
}

/**
 * Either the explicit array, or the equality shorthand `{ archived: false }` that
 * `relation.filter` has always used. The shorthand stays because it is the common
 * case and it is already in published files.
 */
export type FilterInput = Predicate[] | Record<string, FilterScalar | FilterScalar[]>;

export type Field = ColumnField | RelationField | ManyToManyField;

interface FieldCommon {
  /** Human label. Defaults to the column name, title-cased. */
  label?: string;
  /**
   * Help text under the input. If omitted, the runtime falls back to the column's
   * Postgres COMMENT — so a description written once in the schema reaches every
   * screen without being restated.
   */
  help?: string;
  /** Visible but not editable. */
  readOnly?: boolean;
  /** Override the schema's nullability. Defaults to NOT NULL ⇒ required. */
  required?: boolean;
  /** Where this field appears. Defaults to both. */
  in?: ('list' | 'form')[];
  /**
   * Whether the list may be sorted by this field. Defaults to true.
   *
   * Only ever set this to false. Sorting is right for most columns and the
   * runtime cannot tell which ones it is wrong for — ordering a shipping
   * address alphabetically is technically valid and humanly meaningless, and
   * only a person knows that. Ignored for m2m fields, which have no column.
   */
  sortable?: boolean;
  /**
   * Whether the operator may filter on this field. Defaults to true.
   *
   * Set false for columns where filtering is meaningless or expensive — a jsonb
   * blob, a long text body. This governs what the RUNTIME will accept, not just
   * what the UI offers: a filter on a field marked false is refused rather than
   * quietly ignored, because a filter that appears to apply and does not is
   * worse than one that is missing.
   */
  filterable?: boolean;
}

/** A plain column on the view's own table. */
export interface ColumnField extends FieldCommon {
  kind?: 'column';
  column: string;
  /**
   * Input to render. Defaults from the column's SQL type: enum → select,
   * boolean → checkbox, timestamptz → datetime, jsonb → json, text[] → tags,
   * numeric/int → number, everything else → text.
   */
  widget?: 'text' | 'textarea' | 'markdown' | 'number' | 'checkbox' | 'select' | 'radio' | 'date' | 'datetime' | 'json' | 'tags';
  /** For select/radio on a non-enum column. Enum columns get their members automatically. */
  options?: { value: string; label?: string }[];
  placeholder?: string;
}

/**
 * A foreign key — "which row of the other table is this one attached to".
 *
 * The console fills `relation` in from the catalog's FK graph; the only genuinely
 * human decision is `display`: which column of the target a person should SEE,
 * given the database stores an opaque id.
 */
export interface RelationField extends FieldCommon {
  kind: 'relation';
  /** The foreign-key column on this view's table. */
  column: string;
  relation: {
    /** Referenced table. Derivable from the FK; stored so the file reads standalone. */
    table: string;
    /** Referenced column — the value actually stored. Defaults to that table's PK. */
    value?: string;
    /** Column or "{a} {b}" template shown to the operator. Falls back to the target view's `display`. */
    display?: string;
    /** Restrict selectable rows, e.g. { "archived": false }. */
    filter?: FilterInput;
  };
  /** select for many options, radio for a handful, autocomplete for very many. */
  widget?: 'select' | 'radio' | 'autocomplete';
}

/**
 * A many-to-many across a join table.
 *
 * `through` is the join table, `near` its FK back to this view's table, `far` its FK
 * to the other side. The console detects all four from the catalog: a composite
 * primary key whose columns are all foreign keys IS a relationship, and any other
 * column on that table is payload (granted_at, sort_order, …).
 *
 * That rule matters — a join table is not "a table with exactly two foreign keys".
 * user_roles has three (user_id, role_id, granted_by) and is still a plain
 * users↔roles relationship with provenance attached.
 */
export interface ManyToManyField extends FieldCommon {
  kind: 'm2m';
  /** Field name in the form's value object; no column of its own. Defaults to farTable. */
  name?: string;
  /** The join table. */
  through: string;
  /** Join-table column pointing back at this view's table. */
  near: string;
  /** Join-table column pointing at the other side. */
  far: string;
  /** The table on the other side. */
  farTable: string;
  /** Column `far` references. Defaults to farTable's PK. */
  farValue?: string;
  /** Column or template shown per option. Falls back to the far table's `display`. */
  display?: string;
  widget?: 'checkboxes' | 'multiselect' | 'tags';
}

/* ------------------------------ helpers ------------------------------ */

export const isRelationField = (f: Field): f is RelationField => f.kind === 'relation';
export const isManyToManyField = (f: Field): f is ManyToManyField => f.kind === 'm2m';
export const isColumnField = (f: Field): f is ColumnField => f.kind === undefined || f.kind === 'column';

/** The key a field's value lives under in a form's value object. */
export function fieldKey(f: Field): string {
  if (isManyToManyField(f)) return f.name ?? f.farTable;
  return f.column;
}

/** snake_case → Title Case, the default for any missing label. */
export function humanize(name: string): string {
  return name
    .replace(/_id$/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Render a display template against a row. A bare column name is treated as
 * "{that_column}", so `display: "name"` and `display: "{name}"` mean the same thing.
 * Missing values collapse to empty rather than printing "undefined".
 */
export function renderDisplay(template: string | undefined, row: Record<string, unknown>, fallbackKey?: string): string {
  if (!template) {
    const v = fallbackKey ? row[fallbackKey] : undefined;
    return v === null || v === undefined ? '' : String(v);
  }
  if (!template.includes('{')) {
    const v = row[template];
    return v === null || v === undefined ? '' : String(v);
  }
  return template
    .replace(/\{([^}]+)\}/g, (_, key: string) => {
      const v = row[key.trim()];
      return v === null || v === undefined ? '' : String(v);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Both filter forms reduced to the one the SQL builder consumes.
 *
 * Defaulting the operator from the value's shape is what keeps the shorthand
 * honest: `{ archived: false }` and `{ deleted_at: null }` both read naturally,
 * and the second means "is null" rather than "= null", which in SQL matches
 * nothing and would silently empty the screen.
 */
export function normalizeFilter(input: FilterInput | undefined): Predicate[] {
  if (!input) return [];
  const one = (column: string, op: FilterOp | undefined, value: Predicate['value']): Predicate => ({
    column,
    op: op ?? (Array.isArray(value) ? 'in' : value === null ? 'isNull' : 'eq'),
    ...(value === undefined ? {} : { value }),
  });
  if (Array.isArray(input)) return input.map((p) => one(p.column, p.op, p.value));
  return Object.entries(input).map(([column, value]) => one(column, undefined, value));
}

/** Structural problems in a filter — shape only; columns are checked against the catalog later. */
export function validateFilter(input: unknown, path: string): ViewProblem[] {
  if (input === undefined || input === null) return [];
  const problems: ViewProblem[] = [];
  if (typeof input !== 'object') {
    return [{ path, message: 'filter must be an array of predicates or an object of column/value pairs' }];
  }

  const entries: { at: string; column: unknown; op: unknown; value: unknown; hasValue: boolean }[] = Array.isArray(input)
    ? input.map((p, i) => ({
        at: `${path}[${i}]`,
        column: (p as Predicate)?.column,
        op: (p as Predicate)?.op,
        value: (p as Predicate)?.value,
        hasValue: p !== null && typeof p === 'object' && 'value' in (p as object),
      }))
    : Object.entries(input as Record<string, unknown>).map(([k, v]) => ({ at: `${path}.${k}`, column: k, op: undefined, value: v, hasValue: true }));

  for (const e of entries) {
    if (typeof e.column !== 'string' || !e.column.trim()) {
      problems.push({ path: e.at, message: 'column is required on a filter predicate' });
      continue;
    }
    if (e.op !== undefined && !FILTER_OPS.includes(e.op as FilterOp)) {
      problems.push({ path: `${e.at}.op`, message: `unknown operator "${String(e.op)}" — expected one of ${FILTER_OPS.join(', ')}` });
      continue;
    }
    const op = (e.op as FilterOp) ?? (Array.isArray(e.value) ? 'in' : e.value === null ? 'isNull' : 'eq');
    const valueless = VALUELESS_OPS.includes(op);
    if (valueless && e.hasValue && e.value !== null) {
      problems.push({ path: e.at, message: `${op} takes no value` });
    }
    if (!valueless && !e.hasValue) {
      problems.push({ path: e.at, message: `${op} needs a value` });
    }
    if (op === 'in' && !Array.isArray(e.value)) {
      problems.push({ path: e.at, message: 'in needs an array value' });
    }
    if (op !== 'in' && Array.isArray(e.value)) {
      problems.push({ path: e.at, message: `${op} does not take an array — use "in"` });
    }
  }
  return problems;
}

/** Column names a display template reads, so the resolver can select them. */
export function displayColumns(template: string | undefined): string[] {
  if (!template) return [];
  if (!template.includes('{')) return [template];
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1].trim());
}

/* ---------------------------- validation ---------------------------- */

export interface ViewProblem {
  path: string;
  message: string;
}

/**
 * Structural validation of a parsed definition — shape only, no database access.
 * The resolver checks it against the live catalog separately, because a definition
 * can be perfectly well-formed and still name a table that no longer exists.
 */
export function validateViewDefinition(input: unknown): { ok: true; view: ViewDefinition } | { ok: false; problems: ViewProblem[] } {
  const problems: ViewProblem[] = [];
  const v = input as Partial<ViewDefinition>;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: [{ path: '', message: 'A view definition must be an object' }] };
  }
  if (typeof v.table !== 'string' || !v.table.trim()) {
    problems.push({ path: 'table', message: 'table is required' });
  }

  const seen = new Set<string>();
  (v.fields ?? []).forEach((f, i) => {
    const at = `fields[${i}]`;
    if (!f || typeof f !== 'object') {
      problems.push({ path: at, message: 'must be an object' });
      return;
    }
    if (isManyToManyField(f)) {
      for (const k of ['through', 'near', 'far', 'farTable'] as const) {
        if (typeof f[k] !== 'string' || !f[k]) problems.push({ path: `${at}.${k}`, message: `${k} is required for an m2m field` });
      }
    } else if (isRelationField(f)) {
      if (typeof f.column !== 'string' || !f.column) problems.push({ path: `${at}.column`, message: 'column is required' });
      if (!f.relation || typeof f.relation.table !== 'string' || !f.relation.table) {
        problems.push({ path: `${at}.relation.table`, message: 'relation.table is required' });
      }
      problems.push(...validateFilter(f.relation?.filter, `${at}.relation.filter`));
    } else if (typeof (f as ColumnField).column !== 'string' || !(f as ColumnField).column) {
      problems.push({ path: `${at}.column`, message: 'column is required' });
    }

    const key = fieldKey(f as Field);
    if (key) {
      if (seen.has(key)) problems.push({ path: at, message: `duplicate field "${key}"` });
      seen.add(key);
    }
  });

  problems.push(...validateFilter(v.list?.filter, 'list.filter'));

  return problems.length ? { ok: false, problems } : { ok: true, view: input as ViewDefinition };
}
