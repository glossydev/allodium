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
}

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
    filter?: Record<string, string | number | boolean | null>;
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
    } else if (typeof (f as ColumnField).column !== 'string' || !(f as ColumnField).column) {
      problems.push({ path: `${at}.column`, message: 'column is required' });
    }

    const key = fieldKey(f as Field);
    if (key) {
      if (seen.has(key)) problems.push({ path: at, message: `duplicate field "${key}"` });
      seen.add(key);
    }
  });

  return problems.length ? { ok: false, problems } : { ok: true, view: input as ViewDefinition };
}
