import {
  type ViewDefinition,
  type Field,
  type ColumnField,
  type RelationField,
  type ManyToManyField,
  type Predicate,
  normalizeFilter,
  FILTER_OPS,
  type FilterOp,
  fieldKey,
  humanize,
  isColumnField,
  isManyToManyField,
  isRelationField,
  renderDisplay,
  displayColumns,
  validateViewDefinition,
} from '../view.js';
import { createIntrospector, qid, type ColumnMeta, type Introspector, type Queryable, type TableMeta } from './introspect.js';
import { createMaskPolicy, type MaskOptions, type MaskPolicy } from './masking.js';

/**
 * The view resolver — everything the runtime needs, and the only place that talks
 * to the database.
 *
 * It merges a hand-or-console-authored ViewDefinition (human decisions) with live
 * catalog metadata (types, nullability, enum members, FK targets, column comments)
 * into a ResolvedView: a fully-specified description of a screen with no defaults
 * left to compute. The React layer renders that and nothing else, which is what
 * keeps the client free of database knowledge.
 */

export interface ResolvedField {
  key: string;
  kind: 'column' | 'relation' | 'm2m';
  label: string;
  help: string | null;
  required: boolean;
  readOnly: boolean;
  in: ('list' | 'form')[];
  /** False only where a human said so, or where there is no column to order by. */
  sortable: boolean;
  /** False only where a human said so, or where there is no column to compare. */
  filterable: boolean;
  widget: string;
  /** Present for column/relation fields. */
  column?: string;
  type?: string;
  family?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** Relation + m2m: where the options come from. */
  source?: { table: string; value: string; display?: string; filter?: Predicate[] };
}

/** A panel of rows belonging to this record, fully specified. */
export interface ResolvedRelated {
  /** Stable identity for the panel — `<table>.<foreignKey>`, unique per view. */
  key: string;
  title: string;
  table: string;
  /** The view the client should render the panel with. */
  view: string;
  /** Foreign-key column on the related table. */
  foreignKey: string;
  /** Column of THIS table it points at — the value to bind the panel to. */
  references: string;
  pageSize: number;
}

/** A link with its condition normalized and its defaults filled — what the client renders from. */
export interface ResolvedLink {
  label: string;
  href: string;
  when: Predicate[];
  target: '_blank' | '_self';
  in: ('list' | 'form')[];
}

export interface ResolvedView {
  table: string;
  title: string;
  description: string | null;
  /**
   * The column that addresses one row, or null when nothing does (a join table's
   * composite key). Null means the screen is list-only: no record view, and
   * create/update/delete refuse.
   */
  primaryKey: string | null;
  display?: string;
  fields: ResolvedField[];
  /** Related-row panels, in the order they should appear. */
  related: ResolvedRelated[];
  /** Links out of the admin, rendered per row by the client. */
  links: ResolvedLink[];
  list: { columns: string[]; pageSize: number; sort: { column: string; direction: 'asc' | 'desc' }; searchColumns: string[]; filter: Predicate[] };
  /**
   * Definitions that resolve but would render something useless — a select with no
   * options, a list column that isn't a field. Surfaced rather than swallowed,
   * because "the dropdown is empty and I don't know why" is exactly the kind of
   * silent failure this project exists to avoid.
   */
  warnings: string[];
}

export interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

const err = (m: string) => new Error(m);

/**
 * The permission gate, as this package needs to see it.
 *
 * Structural rather than imported: `@allodium/auth` owns the decision, and the
 * admin runtime must not depend on auth — the content API needs the same gate
 * without the admin runtime. `scope` is typed wider than `Predicate` on purpose
 * so an auth policy is assignable; the operators are checked at the boundary
 * instead, where an unsupported one can be refused rather than dropped.
 */
export interface AccessPolicyLike {
  can(
    actor: unknown,
    table: string,
    action: 'create' | 'read' | 'update' | 'delete'
  ): { allowed: boolean; scope: { column: string; op?: string; value?: unknown }[]; reason: string };
}

/**
 * Who may do what. REQUIRED, with no default.
 *
 * `'unrestricted'` is the explicit opt-out, for a caller that is already the
 * trust boundary — the developer console is loopback-pinned, unauthenticated and
 * runs as super_admin by design. Everything else passes a policy.
 *
 * There is no default because the wrong default is an unauthenticated admin API
 * over every table, and that failure is silent: it works perfectly, for everyone.
 * A missing argument should be a compile error, not a leak.
 */
export type AccessConfig = AccessPolicyLike | 'unrestricted';

/**
 * One predicate as a SQL fragment, with its value bound as a parameter.
 *
 * `colExpr` is already-quoted and comes from a field the caller matched against
 * the view — never from the request — which is the same rule the sort column
 * follows. Values are always parameters; nothing here interpolates user input.
 *
 * Two deliberate asymmetries:
 *  - the text predicates cast to ::text so they work on any column type, but the
 *    ordered comparisons do NOT, because as text '9' > '500' and a "greater than
 *    500" filter would quietly return the wrong rows;
 *  - `ne` compiles to IS DISTINCT FROM. Plain `<>` drops NULL rows too, so
 *    "hide the test account" would also hide every user with no email — a filter
 *    removing rows it was never asked to remove is the silent kind of wrong.
 */
function predicateSql(p: Predicate, colExpr: string, params: unknown[]): string | null {
  const bind = (v: unknown) => `$${params.push(v)}`;
  const op = p.op ?? (Array.isArray(p.value) ? 'in' : p.value === null ? 'isNull' : 'eq');
  const v = p.value;

  switch (op) {
    case 'isNull':
      return `${colExpr} is null`;
    case 'notNull':
      return `${colExpr} is not null`;
    case 'eq':
      return v === null ? `${colExpr} is null` : `${colExpr} = ${bind(v)}`;
    case 'ne':
      return v === null ? `${colExpr} is not null` : `${colExpr} is distinct from ${bind(v)}`;
    case 'lt':
      return `${colExpr} < ${bind(v)}`;
    case 'lte':
      return `${colExpr} <= ${bind(v)}`;
    case 'gt':
      return `${colExpr} > ${bind(v)}`;
    case 'gte':
      return `${colExpr} >= ${bind(v)}`;
    case 'contains':
      return `${colExpr}::text ilike ${bind('%' + String(v) + '%')}`;
    case 'startsWith':
      return `${colExpr}::text ilike ${bind(String(v) + '%')}`;
    case 'endsWith':
      return `${colExpr}::text ilike ${bind('%' + String(v))}`;
    case 'in': {
      const list = Array.isArray(v) ? v : [v];
      if (!list.length) return 'false'; // "in nothing" matches nothing, and an empty any() is a syntax error
      return `${colExpr}::text = any(${bind(list.map((x) => (x === null ? null : String(x))))}::text[])`;
    }
    default:
      return null; // unknown operator: validation rejects these, so this is belt-and-braces
  }
}

/** Default widget for a column, from its SQL type. */
function defaultWidget(c: ColumnMeta): string {
  switch (c.family) {
    case 'enum':
      return 'select';
    case 'boolean':
      return 'checkbox';
    case 'json':
      return 'json';
    case 'array':
      return 'tags';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'number':
      return 'number';
    default:
      return c.udtName === 'text' ? 'textarea' : 'text';
  }
}

export interface ViewResolver {
  resolve(def: ViewDefinition): Promise<ResolvedView>;
  list(def: ViewDefinition, opts?: { page?: number; pageSize?: number; search?: string; sort?: string; direction?: 'asc' | 'desc'; filters?: Predicate[]; scope?: Predicate[]; actor?: unknown }): Promise<ListResult>;
  read(def: ViewDefinition, id: unknown, actor?: unknown): Promise<Record<string, unknown> | null>;
  create(def: ViewDefinition, values: Record<string, unknown>, actor?: unknown): Promise<Record<string, unknown>>;
  update(def: ViewDefinition, id: unknown, values: Record<string, unknown>, actor?: unknown): Promise<Record<string, unknown>>;
  remove(def: ViewDefinition, id: unknown, actor?: unknown): Promise<void>;
  /** Selectable rows for a relation/m2m field — a read of the TARGET table, gated and row-scoped for the actor. */
  options(def: ViewDefinition, fieldKeyName: string, opts?: { search?: string; limit?: number; actor?: unknown }): Promise<{ value: unknown; label: string }[]>;
  /**
   * The gate alone: throws "Not permitted" or returns the granted row scope.
   * For callers that need the decision before doing anything — a route deciding
   * whether to describe a screen's shape at all — without paying for a query.
   */
  authorize(def: ViewDefinition, action: 'create' | 'read' | 'update' | 'delete', actor?: unknown): Promise<Predicate[]>;
  introspector: Introspector;
}

export function createViewResolver(
  db: Queryable,
  opts: { access: AccessConfig; schema?: string; ttlMs?: number; masking?: MaskOptions | MaskPolicy }
): ViewResolver {
  const introspector = createIntrospector(db, opts);

  // A caller may pass either options for the built-in policy or a policy outright.
  // Masking is ON by default and there is no way to switch it off wholesale: an
  // omitted `masking` key means the standard pattern, never "none".
  const policy: MaskPolicy =
    opts.masking && typeof (opts.masking as MaskPolicy).isMasked === 'function'
      ? (opts.masking as MaskPolicy)
      : createMaskPolicy(opts.masking as MaskOptions | undefined);

  const isMasked = (table: string, column: string) => policy.isMasked(table, column);

  const access = opts.access;

  /**
   * Decide, and return the rows the decision allows.
   *
   * Throws on refusal rather than returning empty: "you may not" and "there are
   * none" are different answers, and a caller that cannot tell them apart will
   * show an empty screen to someone who should have been told no.
   */
  const gate = (actor: unknown, table: string, action: 'create' | 'read' | 'update' | 'delete'): Predicate[] => {
    if (access === 'unrestricted') return [];
    if (actor === undefined || actor === null) {
      throw err(`Not permitted: ${action} on ${table} needs an actor, and none was supplied`);
    }
    const decision = access.can(actor, table, action);
    if (!decision.allowed) throw err(`Not permitted: ${decision.reason}`);
    // A granted predicate this layer cannot express must DENY. Skipping it would
    // widen the grant to every row — the same failure as dropping an unresolved
    // claim, one layer further down, and just as silent.
    for (const p of decision.scope) {
      if (p.op !== undefined && !FILTER_OPS.includes(p.op as FilterOp)) {
        throw err(`Not permitted: the grant for ${action} on ${table} uses an unsupported comparison "${p.op}"`);
      }
    }
    return decision.scope as Predicate[];
  };

  /**
   * The rows of a relation's target an actor may see, as a scope — or null when
   * none, in which case the label is left out and the foreign key stands alone.
   *
   * Non-throwing on purpose, unlike the gate: a label is decoration on a row the
   * actor IS allowed to read. "You may not see the other table" therefore hides
   * the decoration rather than refusing the row — but it does hide it, because
   * a joined name is a read of that other table by another route, and a grant
   * restricting customers to your own must not print every customer's name down
   * an orders list.
   */
  const labelScope = (actor: unknown, table: string): Predicate[] | null => {
    if (access === 'unrestricted') return [];
    if (actor === undefined || actor === null) return null;
    const decision = access.can(actor, table, 'read');
    if (!decision.allowed) return null;
    for (const p of decision.scope) {
      if (p.op !== undefined && !FILTER_OPS.includes(p.op as FilterOp)) return null;
    }
    return decision.scope as Predicate[];
  };

  /**
   * The columns a caller is allowed to see. Every projection in this file goes
   * through here — `select *` and `returning *` are banned outright, because both
   * expand to whatever the table happens to hold, which is exactly how a secret
   * reaches the wire without any view ever naming it.
   */
  const visibleColumns = (meta: TableMeta): ColumnMeta[] =>
    meta.columns.filter((c) => !isMasked(meta.name, c.name));

  /**
   * One column in a projection. A DATE is selected as text: the driver would
   * otherwise hand back a JS Date at midnight in the SERVER'S zone, which the
   * JSON layer renders in UTC, and on any server east of Greenwich the 10th
   * arrives in the browser as the 9th. A date has no instant to convert; it is
   * the string it always was.
   */
  const projected = (c: ColumnMeta, prefix = ''): string =>
    c.family === 'date' ? `${prefix}${qid(c.name)}::text as ${qid(c.name)}` : `${prefix}${qid(c.name)}`;

  const tableOrThrow = async (name: string): Promise<TableMeta> => {
    const t = await introspector.table(name);
    if (!t) throw err(`Unknown table: ${name}`);
    return t;
  };

  /**
   * The column that addresses one row, or null when nothing does.
   *
   * A composite primary key — a join table's (post_id, tag_id) — leaves no single
   * value to put in a URL, so there is no record screen and no read, update or
   * delete. LISTING is a different question, and it never needed a key: a panel
   * showing a post's tags, or a user's roles with who granted them and when, is
   * exactly the join table's rows and is worth seeing. This used to throw, which
   * made the whole table unviewable to answer a question nobody had asked.
   */
  const pkOf = async (def: ViewDefinition, meta: TableMeta): Promise<string | null> =>
    def.primaryKey ?? meta.primaryKey ?? null;

  /** Reads and writes that address a single row need one; say which and why. */
  const requirePk = (view: ResolvedView): string => {
    if (view.primaryKey) return view.primaryKey;
    throw err(
      `${view.table} has no single-column primary key, so a row cannot be addressed — it can be listed, but not read, created, updated or deleted. Set "primaryKey" in the view if one column does identify a row.`
    );
  };

  /**
   * Fields to use when the definition doesn't list any: every visible column.
   * Masked columns are not visible, so they are absent here silently — this is the
   * default path, and warning about a column nobody asked for would be noise on
   * every view of a table that happens to store a password.
   */
  const impliedFields = (meta: TableMeta): Field[] =>
    visibleColumns(meta).map((c) =>
      c.fk
        ? ({ kind: 'relation', column: c.name, relation: { table: c.fk.table, value: c.fk.column } } as RelationField)
        : ({ column: c.name } as ColumnField)
    );

  async function resolveField(f: Field, meta: TableMeta): Promise<ResolvedField> {
    const common = {
      label: f.label ?? humanize(fieldKey(f)),
      readOnly: f.readOnly ?? false,
      in: f.in ?? (['list', 'form'] as ('list' | 'form')[]),
      // Both default to true: omission means the sensible default, and for
      // everything with a column that is "yes, you may".
      sortable: f.sortable ?? true,
      filterable: f.filterable ?? true,
    };

    if (isManyToManyField(f)) {
      const far = await tableOrThrow(f.farTable);
      const farValue = f.farValue ?? far.primaryKey;
      if (!farValue) throw err(`${f.farTable} has no primary key to link against`);
      return {
        ...common,
        key: fieldKey(f),
        kind: 'm2m',
        help: f.help ?? null,
        required: f.required ?? false,
        // No column of its own, so there is nothing to order or compare against
        // — regardless of what the definition asked for.
        sortable: false,
        filterable: false,
        widget: f.widget ?? 'checkboxes',
        source: { table: f.farTable, value: farValue, display: f.display },
      };
    }

    const col = meta.columns.find((c) => c.name === (f as ColumnField | RelationField).column);
    if (!col) throw err(`${meta.name} has no column "${(f as ColumnField).column}"`);

    // A column that is NOT NULL with a default is not "required" to the operator —
    // the database will fill it in. Requiring it would be a lie in the UI.
    const required = f.required ?? (!col.nullable && !col.hasDefault && !col.isPk);
    const help = f.help ?? col.comment ?? null;

    if (isRelationField(f)) {
      const target = await tableOrThrow(f.relation.table);
      const value = f.relation.value ?? col.fk?.column ?? target.primaryKey;
      if (!value) throw err(`${f.relation.table} has no primary key to reference`);
      return {
        ...common,
        key: col.name,
        kind: 'relation',
        column: col.name,
        type: col.type,
        family: col.family,
        help,
        required,
        widget: f.widget ?? 'select',
        source: { table: f.relation.table, value, display: f.relation.display, filter: normalizeFilter(f.relation.filter) },
      };
    }

    const cf = f as ColumnField;
    const options =
      cf.options?.map((o) => ({ value: o.value, label: o.label ?? o.value })) ??
      col.enumValues?.map((v) => ({ value: v, label: v }));

    return {
      ...common,
      key: col.name,
      kind: 'column',
      column: col.name,
      type: col.type,
      family: col.family,
      help,
      required,
      // A PK with a default (serial/uuid) is the database's business, not the operator's.
      readOnly: cf.readOnly ?? (col.isPk && col.hasDefault),
      widget: cf.widget ?? defaultWidget(col),
      ...(options ? { options } : {}),
      ...(cf.placeholder ? { placeholder: cf.placeholder } : {}),
    };
  }

  async function resolve(def: ViewDefinition): Promise<ResolvedView> {
    const check = validateViewDefinition(def);
    if (!check.ok) throw err('Invalid view: ' + check.problems.map((p) => `${p.path} ${p.message}`).join('; '));

    const meta = await tableOrThrow(def.table);
    const pk = await pkOf(def, meta);

    // A view that NAMES a masked column is a different case from one that implies it:
    // someone asked for it explicitly, so refusing silently would look like a bug in
    // the builder. Drop it and say why. Masking is not overridable from a view file —
    // a screen definition must not be able to widen what a deployment considers secret.
    const requested = def.fields ?? impliedFields(meta);
    const warnings: string[] = [];
    const usable: Field[] = [];
    for (const f of requested) {
      const col = (f as ColumnField | RelationField).column;
      if (col && isMasked(meta.name, col)) {
        warnings.push(
          `"${col}" is a masked column — it is dropped from this view. Masked columns are never selected, returned, sorted, filtered or edited. If it is not a secret, exempt it in the resolver's masking options.`
        );
        continue;
      }
      usable.push(f);
    }

    const fields = await Promise.all(usable.map((f) => resolveField(f, meta)));

    const listable = fields.filter((f) => f.in.includes('list') && f.kind !== 'm2m');

    // The primary key is projected by every read (it is how a row is addressed), so a
    // masked PK cannot be served at all. Better to fail loudly than to return rows
    // with no usable identifier.
    if (pk && isMasked(meta.name, pk)) {
      throw err(`${meta.name}.${pk} is the primary key but is masked — exempt it, or the table cannot be served.`);
    }
    for (const f of fields) {
      // A chooser with nothing to choose from renders an empty control and no clue.
      if ((f.widget === 'select' || f.widget === 'radio') && f.kind === 'column' && !f.options?.length) {
        warnings.push(
          `"${f.key}" uses the ${f.widget} widget but has no options: ${f.type} is not an enum, so add "options" to the field or make the column an enum type.`
        );
      }
      if (f.widget === 'checkboxes' && f.kind !== 'm2m' && !f.source) {
        warnings.push(`"${f.key}" uses checkboxes but is not a many-to-many field.`);
      }
    }
    for (const key of def.list?.columns ?? []) {
      if (!fields.some((f) => f.key === key)) warnings.push(`list.columns names "${key}", which is not a field on this view.`);
    }

    // A view whose own default sort names a field marked sortable:false is
    // asking for two contradictory things. The default wins — it is the more
    // specific decision — but say so rather than let the flag look broken.
    const defaultSortKey = def.list?.sort?.column;
    if (defaultSortKey) {
      const sf = fields.find((f) => f.key === defaultSortKey);
      if (sf && !sf.sortable) {
        warnings.push(`list.sort orders by "${defaultSortKey}", which is marked sortable:false — the default sort still applies, but the operator cannot re-sort by it.`);
      }
    }

    // A baseline filter naming a column that isn't a field would silently do
    // nothing — the screen would show every row and look correct. Say so.
    const listFilter = normalizeFilter(def.list?.filter);
    for (const p of listFilter) {
      // "customer_id__label" filters the joined name; only the base key has to
      // be a field, and it has to be the kind of field that HAS a label.
      const wantsLabel = p.column.endsWith('__label');
      const baseKey = wantsLabel ? p.column.slice(0, -'__label'.length) : p.column;
      const f = fields.find((x) => x.key === baseKey && x.column);
      if (!f) {
        warnings.push(`list.filter names "${p.column}", which is not a column field on this view — that predicate is ignored.`);
      } else if (wantsLabel && f.kind !== 'relation') {
        warnings.push(`list.filter names "${p.column}", but "${baseKey}" is not a relation and has no label — that predicate is ignored.`);
      }
    }
    for (const f of fields) {
      for (const p of f.source?.filter ?? []) {
        const target = await tableOrThrow(f.source!.table);
        if (!target.columns.some((c) => c.name === p.column)) {
          warnings.push(`"${f.key}" filters its options on "${p.column}", which ${f.source!.table} does not have — that predicate is ignored.`);
        }
      }
    }

    // Search columns need their own pass. They are NOT required to be fields — a view
    // may legitimately search a column it does not display — which means they are the
    // one place a masked column could reach a WHERE clause without ever being a field.
    // `ilike` over a secret is a working oracle: a caller who cannot read the column
    // can still recover it a character at a time.
    const searchColumns = (
      def.list?.searchColumns ??
      listable.filter((f) => f.family === 'string' && f.kind === 'column').slice(0, 3).map((f) => f.key)
    ).filter((c) => {
      if (!isMasked(meta.name, c)) return true;
      warnings.push(`list.searchColumns names "${c}", which is masked — it is dropped. Searching a secret column reveals it one character at a time.`);
      return false;
    });

    // Related panels are checked against the catalog, not taken on trust: the
    // whole point is that the database already knows which keys point here, so a
    // definition naming one that does not is a mistake the runtime can see. An
    // unchecked panel would render as an empty list, which reads as "no orders"
    // rather than "this view is wrong".
    const related: ResolvedRelated[] = [];
    for (const r of def.related ?? []) {
      const at = `related[${related.length}] (${r.table}.${r.foreignKey})`;
      const target = await introspector.table(r.table);
      if (!target) {
        warnings.push(`${at} names a table that does not exist — the panel is dropped.`);
        continue;
      }
      const fkCol = target.columns.find((c) => c.name === r.foreignKey);
      if (!fkCol) {
        warnings.push(`${at}: ${r.table} has no column "${r.foreignKey}" — the panel is dropped.`);
        continue;
      }
      // A composite primary key on the target is NOT a reason to drop the panel.
      // It means no record screen over there, and the rows still list — which for
      // a join table is the interesting content: a user's roles with who granted
      // them and when, which a checkbox group cannot show. The client learns the
      // panel is list-only from that view's primaryKey being null.

      // The inbound direction, read from the catalog: does that key really point here?
      const inbound = meta.referencedBy.find((x) => x.table === r.table && x.column === r.foreignKey);
      const references = r.references ?? inbound?.references ?? pk;
      if (!inbound) {
        warnings.push(
          `${at}: ${r.table}.${r.foreignKey} is not a foreign key to ${meta.name} — the panel is dropped. ` +
            `Keys that do point here: ${meta.referencedBy.map((x) => `${x.table}.${x.column}`).join(', ') || 'none'}.`
        );
        continue;
      }
      // The panel binds to a value on THIS row, so this table needs a column to
      // take it from. Usually the primary key — but a view with no addressable
      // key can still host a panel by naming `references` itself.
      if (!references || !meta.columns.some((c) => c.name === references)) {
        warnings.push(
          references
            ? `${at}: this view's table has no column "${references}" to bind the panel to — dropped.`
            : `${at}: ${meta.name} has no single-column primary key to bind the panel to — set "references" on the panel to say which column ${r.table}.${r.foreignKey} points at. Dropped.`
        );
        continue;
      }
      // Binding the panel means filtering the related view by its foreign key, so
      // that key has to be filterable over there. Saying so here beats a 400 from
      // a panel the operator cannot see the request for.
      related.push({
        key: `${r.table}.${r.foreignKey}`,
        title: r.title ?? humanize(r.table),
        table: r.table,
        view: r.view ?? r.table,
        foreignKey: r.foreignKey,
        references,
        pageSize: r.pageSize ?? 5,
      });
    }
    const seenRelated = new Set<string>();
    for (const r of related) {
      if (seenRelated.has(r.key)) warnings.push(`related lists "${r.key}" twice — the second panel is a duplicate.`);
      seenRelated.add(r.key);
    }

    // A link is a template over the row, so every placeholder and every
    // condition has to name something the row will actually carry — a visible
    // column, a field key, or a relation's label. One that does not would
    // render no link on any row and never say why.
    const carried = new Set<string>([
      ...visibleColumns(meta).map((c) => c.name),
      ...fields.map((f) => f.key),
      ...fields.filter((f) => f.kind === 'relation').map((f) => `${f.key}__label`),
    ]);
    const links: ResolvedLink[] = (def.links ?? []).map((l, i) => {
      const at = `links[${i}] ("${l.label}")`;
      for (const m of l.href.matchAll(/\{([^}]+)\}/g)) {
        const key = m[1].trim();
        if (!carried.has(key)) warnings.push(`${at} uses {${key}}, which is not a column or field on this view — the link will never render.`);
      }
      const when = normalizeFilter(l.when);
      for (const p of when) {
        if (!carried.has(p.column)) warnings.push(`${at} conditions on "${p.column}", which is not a column or field on this view — the link will never render.`);
      }
      return { label: l.label, href: l.href, when, target: l.target ?? '_self', in: l.in ?? ['list', 'form'] };
    });

    return {
      table: def.table,
      title: def.title ?? humanize(def.table),
      // Same idea as column comments becoming help text: describe the table once,
      // in the schema, and every view built on it inherits that description.
      description: def.description ?? meta.comment ?? null,
      primaryKey: pk,
      display: def.display,
      fields,
      related,
      links,
      warnings,
      list: {
        columns: def.list?.columns ?? listable.slice(0, 6).map((f) => f.key),
        pageSize: def.list?.pageSize ?? 25,
        // Without a key to order by, fall back to the first listable column —
        // any stable order beats an unordered page, which paginates incoherently.
        sort: {
          column: def.list?.sort?.column ?? pk ?? listable.find((f) => f.column)?.key ?? '',
          direction: def.list?.sort?.direction ?? 'desc',
        },
        searchColumns,
        filter: listFilter,
      },
    };
  }

  /* ------------------------------ reads ------------------------------ */

  /**
   * Select list that also resolves each relation's display value in the same query,
   * as `<column>__label`. One round trip per screen rather than one per row per
   * relation, which is the N+1 that makes generated admins feel slow.
   */
  type RelationSource = { table: string; value: string; display?: string; targetPk: string; displayCols: string[]; meta: TableMeta };

  /**
   * `params` is shared with the caller's WHERE clause: a label join carries the
   * actor's row scope on the target as bound parameters, and parameter numbers
   * are by push order, so the join binds first and the clauses continue from it.
   */
  function selectWithLabels(view: ResolvedView, meta: TableMeta, relationDisplays: Map<string, RelationSource>, actor: unknown, params: unknown[]) {
    // Every column the caller may see — NOT `meta.columns`. Selecting the whole table
    // and trusting the view to have declared only safe fields is how a password hash
    // reaches the client without any view mentioning it.
    const base = visibleColumns(meta).map((c) => projected(c, 't.'));
    const joins: string[] = [];
    // fieldKey -> the SQL expression producing what the operator SEES for that
    // relation. Sorting and searching a relation column both have to use this
    // rather than the foreign key: the screen shows "Ada Lovelace", so ordering
    // by customer_id would sort by an opaque number the operator cannot see, and
    // searching it would match against digits nobody typed.
    const labelExpr = new Map<string, string>();
    let i = 0;
    for (const f of view.fields) {
      if (f.kind !== 'relation' || !f.column) continue;
      const src = relationDisplays.get(f.key);
      if (!src) continue;
      // What the actor may see of the target decides whether there is a label at
      // all, and for which rows. The scope goes INTO the join condition, so a row
      // outside it labels as null — the same shape as a dangling foreign key.
      const scope = labelScope(actor, src.table);
      if (scope === null) continue;
      const alias = `r${i++}`;
      const on = [`${alias}.${qid(src.value)} = t.${qid(f.column)}`];
      let scopable = true;
      for (const p of scope) {
        const col = src.meta.columns.find((c) => c.name === p.column);
        if (!col) {
          scopable = false; // a grant naming a column the target lacks: closed, so no label
          break;
        }
        const sql = predicateSql(p, `${alias}.${qid(col.name)}`, params);
        if (sql) on.push(sql);
      }
      if (!scopable) continue;
      const cols = src.displayCols;
      const expr = cols.length
        ? cols.length === 1
          ? `${alias}.${qid(cols[0])}::text`
          : `concat_ws(' ', ${cols.map((c) => `${alias}.${qid(c)}::text`).join(', ')})`
        : `${alias}.${qid(src.value)}::text`;
      base.push(`${expr} as ${qid(f.key + '__label')}`);
      joins.push(`left join ${qid(src.table)} ${alias} on ${on.join(' and ')}`);
      labelExpr.set(f.key, expr);
    }
    return { select: base.join(', '), join: joins.join('\n'), labelExpr };
  }

  async function relationSources(view: ResolvedView) {
    const m = new Map<string, RelationSource>();
    for (const f of view.fields) {
      if (!f.source) continue;
      const target = await tableOrThrow(f.source.table);
      m.set(f.key, {
        table: f.source.table,
        value: f.source.value,
        display: f.source.display,
        targetPk: target.primaryKey ?? f.source.value,
        meta: target,
        // Resolved here rather than in selectWithLabels because this is where the
        // target's metadata is in hand. Filtered on both existence and masking: the
        // label is selected, sorted and searched, so a masked column reaching it is
        // the same leak by three different routes.
        displayCols: displayColumns(f.source.display).filter(
          (c) => target.columns.some((x) => x.name === c) && !isMasked(target.name, c)
        ),
      });
    }
    return m;
  }

  async function list(def: ViewDefinition, o: { page?: number; pageSize?: number; search?: string; sort?: string; direction?: 'asc' | 'desc'; filters?: Predicate[]; scope?: Predicate[]; actor?: unknown } = {}): Promise<ListResult> {
    const view = await resolve(def);
    const meta = await tableOrThrow(def.table);
    const sources = await relationSources(view);
    // Parameters bind in one sequence: the label joins' scopes first, then the
    // clauses below in order. Everything numbers itself by push, so the array is
    // shared rather than merged.
    const params: unknown[] = [];
    const { select, join, labelExpr } = selectWithLabels(view, meta, sources, o.actor, params);
    const joinHasParams = params.length > 0;

    const page = Math.max(1, o.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, o.pageSize ?? view.list.pageSize));

    /**
     * What to compare against for a field key: a relation's label, else its column.
     * Used by SEARCH and SORT, where a relation can only sensibly mean the name on
     * screen — nobody searches for the digits of a foreign key.
     */
    let reachesThroughJoin = false;
    const exprFor = (key: string): string | null => {
      const f = view.fields.find((x) => x.key === key && x.column);
      if (!f) return null;
      const label = labelExpr.get(key);
      if (label) reachesThroughJoin = true;
      return label ?? `t.${qid(f.column!)}`;
    };

    /**
     * The same question for a FILTER, where the answer differs and has to be
     * explicit. `customer_id` means the foreign key — that is what a bound parent
     * scope ("this customer's orders") compares, and it takes an id. The name is
     * addressed as `customer_id__label`, which is exactly the key the row already
     * carries it under, so what the client sees is what the client can filter on.
     */
    const filterTarget = (key: string): { expr: string; field: ResolvedField } | null => {
      const wantsLabel = key.endsWith('__label');
      const baseKey = wantsLabel ? key.slice(0, -'__label'.length) : key;
      const f = view.fields.find((x) => x.key === baseKey && x.column);
      if (!f) return null;
      if (!wantsLabel) return { expr: `t.${qid(f.column!)}`, field: f };
      const label = labelExpr.get(baseKey);
      if (!label) return null; // asked for a label on something with no relation
      reachesThroughJoin = true;
      return { expr: label, field: f };
    };

    // Clauses are ANDed and built in one pass so the parameter numbers stay in
    // step: the baseline filter binds first, then the operator's, then search.
    const clauses: string[] = [];

    for (const p of view.list.filter) {
      const target = filterTarget(p.column);
      if (!target) continue; // resolve() already warned; don't invent a column
      const sql = predicateSql(p, target.expr, params);
      if (sql) clauses.push(sql);
    }

    // The bound scope — "the roles OF THIS USER". Structural, not the operator's,
    // so it is checked against the TABLE rather than the view's fields: a curated
    // panel view legitimately omits the key it is bound by, because repeating the
    // parent down every row is noise. Requiring it to be a field meant hiding the
    // column broke the panel. Masked columns are still refused — scoping by a
    // secret is the same oracle filtering by one would be.
    // Granted rows first, and through their own error path. Both restrictions are
    // structural and both check against the table rather than the view's fields —
    // hiding a column must not widen who sees the row — but a broken GRANT is a
    // permission failure that has to fail closed and say so, while a broken bound
    // scope is the caller getting it wrong. Same channel, different fault.
    for (const p of gate(o.actor, def.table, 'read')) {
      const col = meta.columns.find((c) => c.name === p.column);
      if (!col) throw err(`Not permitted: the grant restricts ${meta.name}.${p.column}, which does not exist`);
      const sql = predicateSql(p, `t.${qid(col.name)}`, params);
      if (sql) clauses.push(sql);
    }

    for (const p of o.scope ?? []) {
      const col = meta.columns.find((c) => c.name === p.column);
      if (!col) throw err(`Cannot scope by "${p.column}": ${meta.name} has no such column`);
      if (isMasked(meta.name, col.name)) throw err(`Cannot scope by "${p.column}": it is masked`);
      const sql = predicateSql(p, `t.${qid(col.name)}`, params);
      if (sql) clauses.push(sql);
    }

    // The operator's own filters. Unlike the baseline these arrive from a
    // request, so a field that opted out is REFUSED rather than dropped: a
    // filter that looks applied but is not would misreport the data.
    for (const p of o.filters ?? []) {
      const target = filterTarget(p.column);
      if (!target) throw err(`Cannot filter on "${p.column}": not a field on this view`);
      if (!target.field.filterable) throw err(`Cannot filter on "${p.column}": this field is not filterable`);
      const sql = predicateSql(p, target.expr, params);
      if (sql) clauses.push(sql);
    }

    const search = o.search?.trim();
    if (search && view.list.searchColumns.length) {
      const n = params.push('%' + search + '%');
      // A search column naming a relation matches the LABEL, so "search orders
      // for Ada" finds her orders instead of matching nothing.
      // The fallback for a search column that is not a field must still be a column
      // the caller may see. Falling straight through to `t.<name>` let a searchColumns
      // entry name anything on the table, masked or not.
      const terms = view.list.searchColumns
        .map((c) => {
          const expr = exprFor(c);
          if (expr) return expr;
          const col = meta.columns.find((x) => x.name === c);
          if (!col || isMasked(meta.name, c)) return null;
          return `t.${qid(c)}`;
        })
        .filter((e): e is string => e !== null)
        .map((expr) => `${expr}::text ilike $${n}`);
      if (terms.length) clauses.push('(' + terms.join(' or ') + ')');
      else params.pop(); // nothing to search: don't leave a bound parameter dangling
    }

    const where = clauses.length ? ' where ' + clauses.join(' and ') : '';
    // Snapshot before the sort is resolved below: ordering by a relation label
    // also touches a join, but the COUNT has no order by, so only a filtering or
    // searching clause should pull the joins into it.
    const whereReachesThroughJoin = reachesThroughJoin;

    // Sort target is validated against the view's own fields — never taken raw —
    // and a field that opted out falls back to the view's default rather than
    // erroring, because a stale bookmark should still render a list.
    const asked = view.fields.find((f) => f.key === o.sort && f.column);
    const sortKey = asked && asked.sortable ? asked.key : view.list.sort.column;
    const sortExpr = exprFor(sortKey) ?? `t.${qid(view.list.sort.column)}`;
    const dir = (o.direction ?? view.list.sort.direction) === 'asc' ? 'asc' : 'desc';

    // The count only needs the joins when a clause reaches through one. Adding
    // them unconditionally would be wrong as well as slower: these are left
    // joins onto the referenced column, which is unique for a real foreign key
    // but not guaranteed for a hand-authored relation.value — and a duplicate
    // there would multiply rows and inflate the count.
    // One exception: a join that bound parameters (a scoped label) must be in
    // the count too, or the count statement is handed values it has no
    // placeholders for and Postgres refuses to run it.
    const countJoin = whereReachesThroughJoin || joinHasParams ? `\n${join}` : '';

    const [rowsRes, countRes] = await Promise.all([
      db.query(
        `select ${select} from ${qid(def.table)} t\n${join}${where}\norder by ${sortExpr} ${dir} nulls last limit ${pageSize} offset ${(page - 1) * pageSize}`,
        params
      ),
      db.query(`select count(*)::int as n from ${qid(def.table)} t${countJoin}${where}`, params),
    ]);

    return {
      rows: rowsRes.rows as Record<string, unknown>[],
      total: (countRes.rows[0] as { n: number }).n,
      page,
      pageSize,
    };
  }

  /**
   * Granted predicates as an ` and ...` fragment, checked against the TABLE.
   *
   * A grant restricts rows the view may not even expose as fields — hiding a
   * column must never widen who can see the row — so this validates against the
   * catalog, exactly as the bound scope does.
   */
  function grantClauses(granted: Predicate[], meta: TableMeta, params: unknown[], prefix = 't.'): string {
    const out: string[] = [];
    for (const p of granted) {
      const col = meta.columns.find((c) => c.name === p.column);
      if (!col) throw err(`Not permitted: the grant restricts ${meta.name}.${p.column}, which does not exist`);
      const sql = predicateSql(p, `${prefix}${qid(col.name)}`, params);
      if (sql) out.push(sql);
    }
    return out.length ? ' and ' + out.join(' and ') : '';
  }

  async function read(def: ViewDefinition, id: unknown, actor?: unknown): Promise<Record<string, unknown> | null> {
    const view = await resolve(def);
    const meta = await tableOrThrow(def.table);
    const sources = await relationSources(view);
    const params: unknown[] = [];
    const { select, join } = selectWithLabels(view, meta, sources, actor, params);

    // The grant narrows WHICH row this id may address. A row outside it comes
    // back null — the same answer as a row that does not exist, deliberately:
    // "no such order" and "not your order" must not be distinguishable, or the
    // endpoint becomes a way to enumerate other people's ids.
    const idParam = params.push(String(id));
    const scoped = grantClauses(gate(actor, def.table, 'read'), meta, params);

    const res = await db.query(
      `select ${select} from ${qid(def.table)} t\n${join}\nwhere t.${qid(requirePk(view))}::text = $${idParam}${scoped} limit 1`,
      params
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    // Current members of each many-to-many, as an array of far-side values.
    //
    // A membership is a set of references INTO the far table, and a reference is
    // readable only when the row it points at is — the same rule as a relation's
    // label. No grant on the far table leaves the key out; a row scope on it
    // narrows the set. The join table itself is not gated separately: its rows
    // are part of this record, and writing them is editing this record.
    for (const f of view.fields) {
      if (f.kind !== 'm2m' || !f.source) continue;
      const m2m = (def.fields ?? []).find((x) => isManyToManyField(x) && fieldKey(x) === f.key) as ManyToManyField | undefined;
      if (!m2m) continue;
      const scope = labelScope(actor, f.source.table);
      if (scope === null) continue;
      const params: unknown[] = [String(id)];
      let narrowed = '';
      if (scope.length) {
        let inner: string;
        try {
          inner = grantClauses(scope, await tableOrThrow(f.source.table), params, '');
        } catch {
          continue; // a grant naming a column the far table lacks: closed, so no membership
        }
        narrowed = ` and ${qid(m2m.far)} in (select ${qid(f.source.value)} from ${qid(f.source.table)} where true${inner})`;
      }
      const linked = await db.query(
        `select ${qid(m2m.far)} as v from ${qid(m2m.through)} where ${qid(m2m.near)}::text = $1${narrowed}`,
        params
      );
      row[f.key] = (linked.rows as { v: unknown }[]).map((r) => r.v);
    }
    return row;
  }

  /**
   * Rows of a relation's target, as a picker offers them.
   *
   * Gated as a read OF THE TARGET, row scope included: an operator who may read
   * only their own customer must not be offered every customer in a dropdown,
   * which is a list of the table by another route. The route checks the
   * table-level answer first so a refusal is a 403 rather than an empty menu.
   */
  async function options(def: ViewDefinition, key: string, o: { search?: string; limit?: number; actor?: unknown } = {}) {
    const { search, limit = 100 } = o;
    const view = await resolve(def);
    const field = view.fields.find((f) => f.key === key);
    if (!field?.source) throw err(`No relation field "${key}"`);
    const target = await tableOrThrow(field.source.table);
    const granted = gate(o.actor, target.name, 'read');

    const display = field.source.display;
    const cols = displayColumns(display);
    // Existence is not enough: the display expression is rendered to the operator, so a
    // relation pointing at users with display "password_hash" would print the digest in
    // a dropdown. Masking follows the column to whatever table it lives on.
    const valid = cols.filter((c) => target.columns.some((x) => x.name === c) && !isMasked(target.name, c));
    const labelExpr = valid.length
      ? valid.length === 1
        ? `${qid(valid[0])}::text`
        : `concat_ws(' ', ${valid.map((c) => `${qid(c)}::text`).join(', ')})`
      : `${qid(field.source.value)}::text`;

    // The filter is the view's own rule about what may be chosen; the search is
    // the operator narrowing that. Both, ANDed — never one instead of the other.
    const params: unknown[] = [];
    const clauses: string[] = [];

    // The grant's rows first, through its own error path — a grant naming a
    // column the target does not have is a broken grant, and fails closed.
    for (const p of granted) {
      if (!target.columns.some((c) => c.name === p.column)) throw err(`Not permitted: the grant restricts ${target.name}.${p.column}, which does not exist`);
      const sql = predicateSql(p, qid(p.column), params);
      if (sql) clauses.push(sql);
    }

    for (const p of field.source.filter ?? []) {
      if (!target.columns.some((c) => c.name === p.column)) continue; // warned at resolve time
      const sql = predicateSql(p, qid(p.column), params);
      if (sql) clauses.push(sql);
    }

    if (search?.trim()) {
      const n = params.push('%' + search.trim() + '%');
      clauses.push(`${labelExpr} ilike $${n}`);
    }

    const where = clauses.length ? ' where ' + clauses.join(' and ') : '';
    const res = await db.query(
      `select ${qid(field.source.value)} as value, ${labelExpr} as label from ${qid(field.source.table)}${where} order by 2 limit ${Math.min(500, limit)}`,
      params
    );
    return res.rows as { value: unknown; label: string }[];
  }

  /* ------------------------------ writes ------------------------------ */

  /** Split submitted values into own-table columns and many-to-many sets. */
  async function partition(def: ViewDefinition, values: Record<string, unknown>) {
    const view = await resolve(def);
    const own: Record<string, unknown> = {};
    const links: { field: ManyToManyField; want: unknown[] }[] = [];

    for (const [k, v] of Object.entries(values)) {
      const f = view.fields.find((x) => x.key === k);
      if (!f) throw err(`Unknown field: ${k}`);
      if (f.readOnly) continue;
      if (f.kind === 'm2m') {
        const m2m = (def.fields ?? []).find((x) => isManyToManyField(x) && fieldKey(x) === k) as ManyToManyField | undefined;
        if (m2m) links.push({ field: m2m, want: Array.isArray(v) ? v : [] });
        continue;
      }
      own[f.column!] = v;
    }
    return { view, own, links };
  }

  /**
   * Reconcile one many-to-many to exactly the submitted set: delete what is no
   * longer wanted, insert what is new, leave untouched rows alone so any payload
   * on the join table (granted_at, sort_order) survives editing.
   */
  async function syncLinks(link: { field: ManyToManyField; want: unknown[] }, id: unknown, exec: Queryable) {
    const { through, near, far } = link.field;
    const current = await exec.query(`select ${qid(far)} as v from ${qid(through)} where ${qid(near)}::text = $1`, [String(id)]);
    const have = new Set((current.rows as { v: unknown }[]).map((r) => String(r.v)));
    const want = new Set(link.want.map((v) => String(v)));

    const remove = [...have].filter((v) => !want.has(v));
    const add = [...want].filter((v) => !have.has(v));

    if (remove.length) {
      await exec.query(`delete from ${qid(through)} where ${qid(near)}::text = $1 and ${qid(far)}::text = any($2::text[])`, [String(id), remove]);
    }
    for (const v of add) {
      await exec.query(
        `insert into ${qid(through)} (${qid(near)}, ${qid(far)}) values ($1, $2) on conflict do nothing`,
        [id, v]
      );
    }
  }

  /** Run a unit of work on a dedicated connection when the driver exposes one. */
  async function transact<T>(fn: (exec: Queryable) => Promise<T>): Promise<T> {
    const pool = db as Queryable & { connect?: () => Promise<Queryable & { release: () => void }> };
    if (typeof pool.connect !== 'function') return fn(db);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function create(def: ViewDefinition, values: Record<string, unknown>, actor?: unknown) {
    const { view, own, links } = await partition(def, values);
    const meta = await tableOrThrow(def.table);
    // A row-restricted grant cannot be checked on an INSERT: there is no existing
    // row to test, and guessing which submitted values would satisfy the rule is
    // how you end up writing a row the grantee cannot then read. Refuse plainly.
    const granted = gate(actor, def.table, 'create');
    if (granted.length) {
      throw err(
        `Not permitted: creating in ${def.table} is granted only for a restricted set of rows, which cannot be verified on insert — grant create on the whole table, or create through your own endpoint.`
      );
    }
    // `returning *` returns the row the DATABASE produced, which includes columns the
    // caller never submitted and may not see — a create against a users table handed
    // back the stored password hash. Project it, exactly like a read.
    const returning = visibleColumns(meta).map((c) => projected(c)).join(', ');
    return transact(async (exec) => {
      const cols = Object.keys(own);
      const res = cols.length
        ? await exec.query(
            `insert into ${qid(def.table)} (${cols.map(qid).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning ${returning}`,
            Object.values(own)
          )
        : await exec.query(`insert into ${qid(def.table)} default values returning ${returning}`);
      const row = res.rows[0] as Record<string, unknown>;
      const id = row[requirePk(view)];
      for (const l of links) await syncLinks(l, id, exec);
      return row;
    });
  }

  async function update(def: ViewDefinition, id: unknown, values: Record<string, unknown>, actor?: unknown) {
    const { view, own, links } = await partition(def, values);
    const meta = await tableOrThrow(def.table);
    const returning = visibleColumns(meta).map((c) => projected(c)).join(', ');
    // Editing a row outside the grant must fail as "not found", the same answer a
    // missing row gives — telling someone their edit was FORBIDDEN confirms the
    // row exists and belongs to somebody.
    const granted = gate(actor, def.table, 'update');
    return transact(async (exec) => {
      let row: Record<string, unknown> | undefined;
      const cols = Object.keys(own);
      if (cols.length) {
        const params: unknown[] = [String(id), ...Object.values(own)];
        const scoped = grantClauses(granted, meta, params, '');
        const res = await exec.query(
          `update ${qid(def.table)} set ${cols.map((c, i) => `${qid(c)} = $${i + 2}`).join(', ')} where ${qid(requirePk(view))}::text = $1${scoped} returning ${returning}`,
          params
        );
        row = res.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw err('Row not found');
      } else {
        // The no-op branch still returns the row, so it needs the same projection —
        // `select *` here would undo the whole guard for any update that submitted
        // only many-to-many changes.
        const params: unknown[] = [String(id)];
        const scoped = grantClauses(granted, meta, params, '');
        const res = await exec.query(`select ${returning} from ${qid(def.table)} where ${qid(requirePk(view))}::text = $1${scoped}`, params);
        row = res.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw err('Row not found');
      }
      for (const l of links) await syncLinks(l, id, exec);
      return row;
    });
  }

  async function remove(def: ViewDefinition, id: unknown, actor?: unknown) {
    const view = await resolve(def);
    const meta = await tableOrThrow(def.table);
    const params: unknown[] = [String(id)];
    const scoped = grantClauses(gate(actor, def.table, 'delete'), meta, params, '');
    const res = await db.query(`delete from ${qid(def.table)} where ${qid(requirePk(view))}::text = $1${scoped}`, params);
    if (!res.rowCount) throw err('Row not found');
  }

  async function authorize(def: ViewDefinition, action: 'create' | 'read' | 'update' | 'delete', actor?: unknown): Promise<Predicate[]> {
    return gate(actor, def.table, action);
  }

  return { resolve, list, read, create, update, remove, options, authorize, introspector };
}

export { renderDisplay, isColumnField, isRelationField, isManyToManyField };
