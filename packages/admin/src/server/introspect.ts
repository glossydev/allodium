/**
 * Minimal table introspection for the view runtime.
 *
 * Deliberately standalone: this package must not depend on the console, and a
 * consuming dashboard should not have to hand it a schema registry. Everything a
 * view needs is read from pg_catalog at runtime and cached briefly.
 *
 * It reads column COMMENTs too, so help text written once in the schema reaches
 * every screen without being restated in each definition.
 */

/** Anything with a pg-shaped query method: a pg Pool, a Client, a proxy. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface ColumnMeta {
  name: string;
  /** Postgres udt, e.g. int4, varchar, timestamptz, order_status, _text. */
  udtName: string;
  /** Display type, e.g. varchar(200), numeric(10, 2), text[]. */
  type: string;
  family: 'string' | 'number' | 'boolean' | 'json' | 'date' | 'datetime' | 'uuid' | 'enum' | 'array';
  nullable: boolean;
  hasDefault: boolean;
  isPk: boolean;
  /** Postgres COMMENT ON COLUMN — the default source of help text. */
  comment: string | null;
  enumValues?: string[];
  fk?: { table: string; column: string };
}

export interface TableMeta {
  name: string;
  /** COMMENT ON TABLE — the default description for a view built on this table. */
  comment: string | null;
  columns: ColumnMeta[];
  primaryKey: string | null;
  primaryKeyColumns: string[];
  /**
   * Foreign keys pointing AT this table — the inbound direction, "what has rows
   * that belong to mine". `columns[].fk` only answers the outbound question, so
   * a customer could see which user it belongs to but never that orders exist.
   *
   * Single-column keys only: a composite foreign key is one relationship, and
   * unnesting it would report a fake pair of them.
   */
  referencedBy: { table: string; column: string; references: string }[];
}

const qid = (n: string) => '"' + n.replaceAll('"', '""') + '"';
export { qid };

interface RawColumn {
  column_name: string;
  udt_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  comment: string | null;
}

function displayType(c: RawColumn): string {
  if (c.data_type === 'ARRAY') return c.udt_name.replace(/^_/, '') + '[]';
  if (c.data_type === 'USER-DEFINED') return c.udt_name;
  if (c.data_type === 'character varying') return c.character_maximum_length ? `varchar(${c.character_maximum_length})` : 'varchar';
  if (c.data_type === 'character') return c.character_maximum_length ? `char(${c.character_maximum_length})` : 'char';
  if (c.data_type === 'numeric' && c.numeric_precision != null) return `numeric(${c.numeric_precision}, ${c.numeric_scale ?? 0})`;
  return c.data_type;
}

function family(c: RawColumn, isEnum: boolean): ColumnMeta['family'] {
  if (isEnum) return 'enum';
  if (c.data_type === 'ARRAY') return 'array';
  switch (c.udt_name) {
    case 'bool':
      return 'boolean';
    case 'int2':
    case 'int4':
    case 'int8':
    case 'float4':
    case 'float8':
    case 'numeric':
      return 'number';
    case 'json':
    case 'jsonb':
      return 'json';
    case 'date':
      return 'date';
    case 'timestamp':
    case 'timestamptz':
      return 'datetime';
    case 'uuid':
      return 'uuid';
    default:
      return 'string';
  }
}

export interface Introspector {
  table(name: string): Promise<TableMeta | null>;
  enums(): Promise<Map<string, string[]>>;
  /** Forget cached metadata — call after a migration. */
  invalidate(): void;
}

/**
 * `ttlMs` defaults to 5s: long enough that a page render costs one catalog read,
 * short enough that a migration shows up without a restart.
 */
export function createIntrospector(db: Queryable, opts: { schema?: string; ttlMs?: number } = {}): Introspector {
  const schema = opts.schema ?? 'public';
  const ttl = opts.ttlMs ?? 5_000;

  let enumCache: { at: number; value: Map<string, string[]> } | null = null;
  const tableCache = new Map<string, { at: number; value: TableMeta | null }>();

  const loadEnums = async (): Promise<Map<string, string[]>> => {
    if (enumCache && Date.now() - enumCache.at < ttl) return enumCache.value;
    const res = await db.query(
      `select t.typname, e.enumlabel
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = $1
        order by t.typname, e.enumsortorder`,
      [schema]
    );
    const m = new Map<string, string[]>();
    for (const row of res.rows as { typname: string; enumlabel: string }[]) {
      (m.get(row.typname) ?? m.set(row.typname, []).get(row.typname)!).push(row.enumlabel);
    }
    enumCache = { at: Date.now(), value: m };
    return m;
  };

  return {
    invalidate() {
      enumCache = null;
      tableCache.clear();
    },

    enums: loadEnums,

    async table(name: string): Promise<TableMeta | null> {
      const hit = tableCache.get(name);
      if (hit && Date.now() - hit.at < ttl) return hit.value;

      const [colsRes, pkRes, fkRes, enums, tblRes, inboundRes] = await Promise.all([
        db.query(
          `select c.column_name, c.udt_name, c.data_type, c.is_nullable, c.column_default,
                  c.character_maximum_length, c.numeric_precision, c.numeric_scale,
                  col_description(pc.oid, a.attnum) as comment
             from information_schema.columns c
             join pg_class pc on pc.relname = c.table_name
             join pg_namespace n on n.oid = pc.relnamespace and n.nspname = c.table_schema
             join pg_attribute a on a.attrelid = pc.oid and a.attname = c.column_name
            where c.table_schema = $1 and c.table_name = $2
            order by c.ordinal_position`,
          [schema, name]
        ),
        db.query(
          `select a.attname
             from pg_index i
             join pg_class c on c.oid = i.indrelid
             join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
            where i.indisprimary and n.nspname = $1 and c.relname = $2`,
          [schema, name]
        ),
        db.query(
          `select a.attname as column_name, cf.relname as ref_table, af.attname as ref_column
             from pg_constraint con
             join pg_class c on c.oid = con.conrelid
             join pg_namespace n on n.oid = c.relnamespace
             join pg_class cf on cf.oid = con.confrelid
             cross join lateral unnest(con.conkey, con.confkey) with ordinality k(attnum, fattnum, ord)
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             join pg_attribute af on af.attrelid = con.confrelid and af.attnum = k.fattnum
            where con.contype = 'f' and n.nspname = $1 and c.relname = $2`,
          [schema, name]
        ),
        loadEnums(),
        db.query(
          `select obj_description(c.oid, 'pg_class') as comment
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = $1 and c.relname = $2`,
          [schema, name]
        ),
        // The same catalog, read the other way round: constraints whose TARGET
        // is this table. A self-reference is a legitimate answer here (a post's
        // child posts), so it is not filtered out.
        db.query(
          `select c.relname as src_table, a.attname as src_column, af.attname as ref_column
             from pg_constraint con
             join pg_class c on c.oid = con.conrelid
             join pg_class cf on cf.oid = con.confrelid
             join pg_namespace nf on nf.oid = cf.relnamespace
             cross join lateral unnest(con.conkey, con.confkey) with ordinality k(attnum, fattnum, ord)
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             join pg_attribute af on af.attrelid = con.confrelid and af.attnum = k.fattnum
            where con.contype = 'f' and nf.nspname = $1 and cf.relname = $2
              and array_length(con.conkey, 1) = 1
            order by 1, 2`,
          [schema, name]
        ),
      ]);

      const raw = colsRes.rows as RawColumn[];
      if (!raw.length) {
        tableCache.set(name, { at: Date.now(), value: null });
        return null;
      }

      const pkCols = (pkRes.rows as { attname: string }[]).map((r) => r.attname);
      const fkByCol = new Map<string, { table: string; column: string }>();
      for (const r of fkRes.rows as { column_name: string; ref_table: string; ref_column: string }[]) {
        if (!fkByCol.has(r.column_name)) fkByCol.set(r.column_name, { table: r.ref_table, column: r.ref_column });
      }

      const columns: ColumnMeta[] = raw.map((c) => {
        const isEnum = c.data_type === 'USER-DEFINED' && enums.has(c.udt_name);
        return {
          name: c.column_name,
          udtName: c.udt_name,
          type: displayType(c),
          family: family(c, isEnum),
          nullable: c.is_nullable === 'YES',
          hasDefault: c.column_default !== null,
          isPk: pkCols.includes(c.column_name),
          comment: c.comment,
          ...(isEnum ? { enumValues: enums.get(c.udt_name) } : {}),
          ...(fkByCol.has(c.column_name) ? { fk: fkByCol.get(c.column_name) } : {}),
        };
      });

      const meta: TableMeta = {
        name,
        comment: (tblRes.rows[0] as { comment: string | null } | undefined)?.comment ?? null,
        columns,
        primaryKey: pkCols.length === 1 ? pkCols[0] : null,
        primaryKeyColumns: pkCols,
        referencedBy: (inboundRes.rows as { src_table: string; src_column: string; ref_column: string }[]).map((r) => ({
          table: r.src_table,
          column: r.src_column,
          references: r.ref_column,
        })),
      };
      tableCache.set(name, { at: Date.now(), value: meta });
      return meta;
    },
  };
}

/**
 * Detect join tables: a composite primary key whose columns are ALL foreign keys.
 * Any other column is payload (granted_at, sort_order, …).
 *
 * This is why the rule is not "a table with exactly two foreign keys" — user_roles
 * has three (user_id, role_id, granted_by) and is still a plain users↔roles link.
 */
export function asJoinTable(meta: TableMeta): { a: ColumnMeta; b: ColumnMeta; payload: ColumnMeta[] } | null {
  if (meta.primaryKeyColumns.length !== 2) return null;
  const pkCols = meta.primaryKeyColumns.map((n) => meta.columns.find((c) => c.name === n)).filter((c): c is ColumnMeta => !!c);
  if (pkCols.length !== 2 || !pkCols.every((c) => c.fk)) return null;
  return {
    a: pkCols[0],
    b: pkCols[1],
    payload: meta.columns.filter((c) => !meta.primaryKeyColumns.includes(c.name)),
  };
}
