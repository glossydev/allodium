import {
  type ViewDefinition,
  type Field,
  type ColumnField,
  type RelationField,
  type ManyToManyField,
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
  widget: string;
  /** Present for column/relation fields. */
  column?: string;
  type?: string;
  family?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** Relation + m2m: where the options come from. */
  source?: { table: string; value: string; display?: string };
}

export interface ResolvedView {
  table: string;
  title: string;
  description: string | null;
  primaryKey: string;
  display?: string;
  fields: ResolvedField[];
  list: { columns: string[]; pageSize: number; sort: { column: string; direction: 'asc' | 'desc' }; searchColumns: string[] };
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
  list(def: ViewDefinition, opts?: { page?: number; pageSize?: number; search?: string; sort?: string; direction?: 'asc' | 'desc' }): Promise<ListResult>;
  read(def: ViewDefinition, id: unknown): Promise<Record<string, unknown> | null>;
  create(def: ViewDefinition, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(def: ViewDefinition, id: unknown, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(def: ViewDefinition, id: unknown): Promise<void>;
  /** Selectable rows for a relation/m2m field. */
  options(def: ViewDefinition, fieldKeyName: string, search?: string, limit?: number): Promise<{ value: unknown; label: string }[]>;
  introspector: Introspector;
}

export function createViewResolver(db: Queryable, opts: { schema?: string; ttlMs?: number } = {}): ViewResolver {
  const introspector = createIntrospector(db, opts);

  const tableOrThrow = async (name: string): Promise<TableMeta> => {
    const t = await introspector.table(name);
    if (!t) throw err(`Unknown table: ${name}`);
    return t;
  };

  const pkOf = async (def: ViewDefinition, meta: TableMeta): Promise<string> => {
    const pk = def.primaryKey ?? meta.primaryKey;
    if (!pk) throw err(`${meta.name} has no single-column primary key; set "primaryKey" in the view`);
    return pk;
  };

  /** Fields to use when the definition doesn't list any: every visible column. */
  const impliedFields = (meta: TableMeta): Field[] =>
    meta.columns.map((c) =>
      c.fk
        ? ({ kind: 'relation', column: c.name, relation: { table: c.fk.table, value: c.fk.column } } as RelationField)
        : ({ column: c.name } as ColumnField)
    );

  async function resolveField(f: Field, meta: TableMeta): Promise<ResolvedField> {
    const common = {
      label: f.label ?? humanize(fieldKey(f)),
      readOnly: f.readOnly ?? false,
      in: f.in ?? (['list', 'form'] as ('list' | 'form')[]),
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
        source: { table: f.relation.table, value, display: f.relation.display },
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
    const fields = await Promise.all((def.fields ?? impliedFields(meta)).map((f) => resolveField(f, meta)));

    const listable = fields.filter((f) => f.in.includes('list') && f.kind !== 'm2m');

    const warnings: string[] = [];
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

    return {
      table: def.table,
      title: def.title ?? humanize(def.table),
      // Same idea as column comments becoming help text: describe the table once,
      // in the schema, and every view built on it inherits that description.
      description: def.description ?? meta.comment ?? null,
      primaryKey: pk,
      display: def.display,
      fields,
      warnings,
      list: {
        columns: def.list?.columns ?? listable.slice(0, 6).map((f) => f.key),
        pageSize: def.list?.pageSize ?? 25,
        sort: { column: def.list?.sort?.column ?? pk, direction: def.list?.sort?.direction ?? 'desc' },
        searchColumns:
          def.list?.searchColumns ??
          listable.filter((f) => f.family === 'string' && f.kind === 'column').slice(0, 3).map((f) => f.key),
      },
    };
  }

  /* ------------------------------ reads ------------------------------ */

  /**
   * Select list that also resolves each relation's display value in the same query,
   * as `<column>__label`. One round trip per screen rather than one per row per
   * relation, which is the N+1 that makes generated admins feel slow.
   */
  function selectWithLabels(view: ResolvedView, meta: TableMeta, relationDisplays: Map<string, { table: string; value: string; display?: string; targetPk: string }>) {
    const base = meta.columns.map((c) => `t.${qid(c.name)}`);
    const joins: string[] = [];
    let i = 0;
    for (const f of view.fields) {
      if (f.kind !== 'relation' || !f.column) continue;
      const src = relationDisplays.get(f.key);
      if (!src) continue;
      const alias = `r${i++}`;
      const cols = displayColumns(src.display);
      const expr = cols.length
        ? cols.length === 1
          ? `${alias}.${qid(cols[0])}::text`
          : `concat_ws(' ', ${cols.map((c) => `${alias}.${qid(c)}::text`).join(', ')})`
        : `${alias}.${qid(src.value)}::text`;
      base.push(`${expr} as ${qid(f.key + '__label')}`);
      joins.push(`left join ${qid(src.table)} ${alias} on ${alias}.${qid(src.value)} = t.${qid(f.column)}`);
    }
    return { select: base.join(', '), join: joins.join('\n') };
  }

  async function relationSources(view: ResolvedView) {
    const m = new Map<string, { table: string; value: string; display?: string; targetPk: string }>();
    for (const f of view.fields) {
      if (!f.source) continue;
      const target = await tableOrThrow(f.source.table);
      m.set(f.key, {
        table: f.source.table,
        value: f.source.value,
        display: f.source.display,
        targetPk: target.primaryKey ?? f.source.value,
      });
    }
    return m;
  }

  async function list(def: ViewDefinition, o: { page?: number; pageSize?: number; search?: string; sort?: string; direction?: 'asc' | 'desc' } = {}): Promise<ListResult> {
    const view = await resolve(def);
    const meta = await tableOrThrow(def.table);
    const sources = await relationSources(view);
    const { select, join } = selectWithLabels(view, meta, sources);

    const page = Math.max(1, o.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, o.pageSize ?? view.list.pageSize));

    const params: unknown[] = [];
    let where = '';
    const search = o.search?.trim();
    if (search && view.list.searchColumns.length) {
      params.push('%' + search + '%');
      where = ' where ' + view.list.searchColumns.map((c) => `t.${qid(c)}::text ilike $1`).join(' or ');
    }

    // Sort column is validated against the view's own fields — never taken raw.
    const sortCol = view.fields.find((f) => f.key === o.sort && f.column)?.column ?? view.list.sort.column;
    const dir = (o.direction ?? view.list.sort.direction) === 'asc' ? 'asc' : 'desc';

    const [rowsRes, countRes] = await Promise.all([
      db.query(
        `select ${select} from ${qid(def.table)} t\n${join}${where}\norder by t.${qid(sortCol)} ${dir} nulls last limit ${pageSize} offset ${(page - 1) * pageSize}`,
        params
      ),
      db.query(`select count(*)::int as n from ${qid(def.table)} t${where}`, params),
    ]);

    return {
      rows: rowsRes.rows as Record<string, unknown>[],
      total: (countRes.rows[0] as { n: number }).n,
      page,
      pageSize,
    };
  }

  async function read(def: ViewDefinition, id: unknown): Promise<Record<string, unknown> | null> {
    const view = await resolve(def);
    const meta = await tableOrThrow(def.table);
    const sources = await relationSources(view);
    const { select, join } = selectWithLabels(view, meta, sources);

    const res = await db.query(
      `select ${select} from ${qid(def.table)} t\n${join}\nwhere t.${qid(view.primaryKey)}::text = $1 limit 1`,
      [String(id)]
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    // Current members of each many-to-many, as an array of far-side values.
    for (const f of view.fields) {
      if (f.kind !== 'm2m') continue;
      const m2m = (def.fields ?? []).find((x) => isManyToManyField(x) && fieldKey(x) === f.key) as ManyToManyField | undefined;
      if (!m2m) continue;
      const linked = await db.query(
        `select ${qid(m2m.far)} as v from ${qid(m2m.through)} where ${qid(m2m.near)}::text = $1`,
        [String(id)]
      );
      row[f.key] = (linked.rows as { v: unknown }[]).map((r) => r.v);
    }
    return row;
  }

  async function options(def: ViewDefinition, key: string, search?: string, limit = 100) {
    const view = await resolve(def);
    const field = view.fields.find((f) => f.key === key);
    if (!field?.source) throw err(`No relation field "${key}"`);
    const target = await tableOrThrow(field.source.table);

    const display = field.source.display;
    const cols = displayColumns(display);
    const valid = cols.filter((c) => target.columns.some((x) => x.name === c));
    const labelExpr = valid.length
      ? valid.length === 1
        ? `${qid(valid[0])}::text`
        : `concat_ws(' ', ${valid.map((c) => `${qid(c)}::text`).join(', ')})`
      : `${qid(field.source.value)}::text`;

    const params: unknown[] = [];
    let where = '';
    if (search?.trim()) {
      params.push('%' + search.trim() + '%');
      where = ` where ${labelExpr} ilike $1`;
    }
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

  async function create(def: ViewDefinition, values: Record<string, unknown>) {
    const { view, own, links } = await partition(def, values);
    return transact(async (exec) => {
      const cols = Object.keys(own);
      const res = cols.length
        ? await exec.query(
            `insert into ${qid(def.table)} (${cols.map(qid).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
            Object.values(own)
          )
        : await exec.query(`insert into ${qid(def.table)} default values returning *`);
      const row = res.rows[0] as Record<string, unknown>;
      const id = row[view.primaryKey];
      for (const l of links) await syncLinks(l, id, exec);
      return row;
    });
  }

  async function update(def: ViewDefinition, id: unknown, values: Record<string, unknown>) {
    const { view, own, links } = await partition(def, values);
    return transact(async (exec) => {
      let row: Record<string, unknown> | undefined;
      const cols = Object.keys(own);
      if (cols.length) {
        const res = await exec.query(
          `update ${qid(def.table)} set ${cols.map((c, i) => `${qid(c)} = $${i + 2}`).join(', ')} where ${qid(view.primaryKey)}::text = $1 returning *`,
          [String(id), ...Object.values(own)]
        );
        row = res.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw err('Row not found');
      } else {
        const res = await exec.query(`select * from ${qid(def.table)} where ${qid(view.primaryKey)}::text = $1`, [String(id)]);
        row = res.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw err('Row not found');
      }
      for (const l of links) await syncLinks(l, id, exec);
      return row;
    });
  }

  async function remove(def: ViewDefinition, id: unknown) {
    const view = await resolve(def);
    const res = await db.query(`delete from ${qid(def.table)} where ${qid(view.primaryKey)}::text = $1`, [String(id)]);
    if (!res.rowCount) throw err('Row not found');
  }

  return { resolve, list, read, create, update, remove, options, introspector };
}

export { renderDisplay, isColumnField, isRelationField, isManyToManyField };
