import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from './db';
import { isMaskedColumn } from './masking';
import { qid } from './sql-utils';

/**
 * Live catalog introspection — the console's single source of schema truth.
 * Everything every silo knows about tables comes from pg_catalog /
 * information_schema at request time, so a table created by the Schema silo is
 * browsable in the Content silo on the next fetch. (Ported from the reference
 * deployment's schema-live endpoint, generalized + enum-aware.)
 *
 * A short TTL cache keeps the console snappy without letting it go stale;
 * DDL paths call invalidateCatalog() after every successful statement.
 */

export interface CatalogColumn {
  name: string;
  /** pg attnum — lets result fields be matched back to their source column (SQL silo masking). */
  attnum?: number;
  /** Display type, e.g. 'varchar(200)', 'numeric(10, 2)', 'user_status', 'text[]'. */
  type: string;
  /** Raw udt_name from the catalog, e.g. 'varchar', '_text', 'user_status' — drives casts. */
  udtName: string;
  /** Data family for input widgets: string|number|boolean|json|date|datetime|uuid|enum|array. */
  family: 'string' | 'number' | 'boolean' | 'json' | 'date' | 'datetime' | 'uuid' | 'enum' | 'array';
  nullable: boolean;
  default: string | null;
  isPk: boolean;
  masked: boolean;
  /** Enum labels when family === 'enum'. */
  enumValues?: string[];
  /** FK target, when this column references another table. */
  fkTable?: string;
  fkColumn?: string;
}

export interface CatalogTable {
  name: string;
  /** pg_class oid — matched against result fields' tableID for masking in the SQL silo. */
  oid?: number;
  columns: CatalogColumn[];
  /** Single-column PK name, or null (composite/absent). Composite PKs list all in pkColumns. */
  pk: string | null;
  pkColumns: string[];
  foreignKeysOut: { column: string; refTable: string; refColumn: string }[];
  referencedBy: { table: string; column: string }[];
  indexes: { name: string; definition: string }[];
  sizeBytes: number;
  sizePretty: string;
}

export interface Catalog {
  tables: Map<string, CatalogTable>;
  /** enum type name → labels, for the Schema silo's type pickers. */
  enums: Map<string, string[]>;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  attnum: number;
}

function displayType(c: ColumnRow): string {
  if (c.data_type === 'ARRAY') return c.udt_name.replace(/^_/, '') + '[]';
  if (c.data_type === 'USER-DEFINED') return c.udt_name;
  if (c.data_type === 'character varying') {
    return c.character_maximum_length ? `varchar(${c.character_maximum_length})` : 'varchar';
  }
  if (c.data_type === 'character') {
    return c.character_maximum_length ? `char(${c.character_maximum_length})` : 'char';
  }
  if (c.data_type === 'numeric' && c.numeric_precision != null) {
    return `numeric(${c.numeric_precision}, ${c.numeric_scale ?? 0})`;
  }
  if (c.data_type === 'timestamp with time zone') return 'timestamptz';
  if (c.data_type === 'timestamp without time zone') return 'timestamp';
  return c.data_type;
}

function familyOf(c: ColumnRow, isEnum: boolean): CatalogColumn['family'] {
  if (c.data_type === 'ARRAY') return 'array';
  if (isEnum) return 'enum';
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

async function loadCatalog(): Promise<Catalog> {
  const { db } = getDb();

  const [tablesRes, columnsRes, pksRes, fksRes, indexesRes, enumsRes] = await Promise.all([
    db.execute(sql`
      select c.relname as name,
             c.oid::int as oid,
             pg_total_relation_size(c.oid)::float8 as size_bytes,
             pg_size_pretty(pg_total_relation_size(c.oid)) as size_pretty
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`),
    db.execute(sql`
      select c.table_name, c.column_name, c.data_type, c.udt_name,
             c.character_maximum_length, c.numeric_precision, c.numeric_scale,
             c.is_nullable, c.column_default,
             a.attnum::int as attnum
      from information_schema.columns c
      join pg_class pc on pc.relname = c.table_name
      join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = 'public'
      join pg_attribute a on a.attrelid = pc.oid and a.attname = c.column_name
      where c.table_schema = 'public'
      order by c.table_name, c.ordinal_position`),
    db.execute(sql`
      select cl.relname as table_name, a.attname as column_name
      from pg_index i
      join pg_class cl on cl.oid = i.indrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = cl.oid and a.attnum = any(i.indkey)
      where i.indisprimary and n.nspname = 'public'`),
    db.execute(sql`
      select cl.relname as table_name, a.attname as column_name,
             clf.relname as ref_table, af.attname as ref_column
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_class clf on clf.oid = con.confrelid
      cross join lateral unnest(con.conkey, con.confkey) with ordinality as k(attnum, fattnum, ord)
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      join pg_attribute af on af.attrelid = con.confrelid and af.attnum = k.fattnum
      where con.contype = 'f' and n.nspname = 'public'
      order by cl.relname, con.conname, k.ord`),
    db.execute(sql`
      select tablename, indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
      order by tablename, indexname`),
    db.execute(sql`
      select t.typname, e.enumlabel
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      order by t.typname, e.enumsortorder`),
  ]);

  const enums = new Map<string, string[]>();
  for (const r of enumsRes.rows as unknown as Array<{ typname: string; enumlabel: string }>) {
    (enums.get(r.typname) ?? enums.set(r.typname, []).get(r.typname)!).push(r.enumlabel);
  }

  const pks = new Map<string, string[]>();
  for (const r of pksRes.rows as unknown as Array<{ table_name: string; column_name: string }>) {
    (pks.get(r.table_name) ?? pks.set(r.table_name, []).get(r.table_name)!).push(r.column_name);
  }

  const fkOut = new Map<string, CatalogTable['foreignKeysOut']>();
  const refBy = new Map<string, CatalogTable['referencedBy']>();
  const fkByCol = new Map<string, { refTable: string; refColumn: string }>();
  for (const r of fksRes.rows as unknown as Array<{
    table_name: string;
    column_name: string;
    ref_table: string;
    ref_column: string;
  }>) {
    (fkOut.get(r.table_name) ?? fkOut.set(r.table_name, []).get(r.table_name)!).push({
      column: r.column_name,
      refTable: r.ref_table,
      refColumn: r.ref_column,
    });
    (refBy.get(r.ref_table) ?? refBy.set(r.ref_table, []).get(r.ref_table)!).push({
      table: r.table_name,
      column: r.column_name,
    });
    fkByCol.set(`${r.table_name}.${r.column_name}`, { refTable: r.ref_table, refColumn: r.ref_column });
  }

  const indexes = new Map<string, CatalogTable['indexes']>();
  for (const r of indexesRes.rows as unknown as Array<{ tablename: string; indexname: string; indexdef: string }>) {
    (indexes.get(r.tablename) ?? indexes.set(r.tablename, []).get(r.tablename)!).push({
      name: r.indexname,
      definition: r.indexdef,
    });
  }

  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const r of columnsRes.rows as unknown as ColumnRow[]) {
    (columnsByTable.get(r.table_name) ?? columnsByTable.set(r.table_name, []).get(r.table_name)!).push(r);
  }

  const tables = new Map<string, CatalogTable>();
  for (const t of tablesRes.rows as unknown as Array<{ name: string; oid: number; size_bytes: number; size_pretty: string }>) {
    const pkCols = pks.get(t.name) ?? [];
    const columns: CatalogColumn[] = (columnsByTable.get(t.name) ?? []).map((c) => {
      const isEnum = c.data_type === 'USER-DEFINED' && enums.has(c.udt_name);
      const fk = fkByCol.get(`${t.name}.${c.column_name}`);
      return {
        name: c.column_name,
        attnum: c.attnum,
        type: displayType(c),
        udtName: c.udt_name,
        family: familyOf(c, isEnum),
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        isPk: pkCols.includes(c.column_name),
        masked: isMaskedColumn(t.name, c.column_name),
        ...(isEnum ? { enumValues: enums.get(c.udt_name) } : {}),
        ...(fk ? { fkTable: fk.refTable, fkColumn: fk.refColumn } : {}),
      };
    });
    tables.set(t.name, {
      name: t.name,
      columns,
      pk: pkCols.length === 1 ? pkCols[0] : null,
      pkColumns: pkCols,
      foreignKeysOut: fkOut.get(t.name) ?? [],
      referencedBy: refBy.get(t.name) ?? [],
      indexes: indexes.get(t.name) ?? [],
      sizeBytes: t.size_bytes,
      sizePretty: t.size_pretty,
    });
  }

  return { tables, enums };
}

/* --------------------------- TTL cache + helpers --------------------------- */

const TTL_MS = 2_000;
interface CacheSlot {
  at: number;
  value: Promise<Catalog> | null;
}
const slot = (globalThis as unknown as { __consoleCatalog?: CacheSlot }).__consoleCatalog ?? { at: 0, value: null };
(globalThis as unknown as { __consoleCatalog?: CacheSlot }).__consoleCatalog = slot;

export function getCatalog(): Promise<Catalog> {
  const now = Date.now();
  if (!slot.value || now - slot.at > TTL_MS) {
    slot.at = now;
    slot.value = loadCatalog().catch((e) => {
      slot.value = null; // don't cache failures
      throw e;
    });
  }
  return slot.value;
}

/** Call after every successful DDL statement. */
export function invalidateCatalog(): void {
  slot.value = null;
}

/** Resolve a table by name from the live catalog — the browse/DML gate. */
export async function getTable(name: string): Promise<CatalogTable | null> {
  const cat = await getCatalog();
  return cat.tables.get(name) ?? null;
}

/** Exact row counts — one UNION ALL over all tables. Schema-silo only (it scans). */
export async function getRowCounts(): Promise<Map<string, number>> {
  const cat = await getCatalog();
  const names = [...cat.tables.keys()];
  const counts = new Map<string, number>();
  if (!names.length) return counts;
  const { db } = getDb();
  const q = names
    .map((n) => `select '${n.replaceAll("'", "''")}' as name, count(*)::int as n from ${qid(n)}`)
    .join(' union all ');
  const res = await db.execute(sql.raw(q));
  for (const r of res.rows as unknown as Array<{ name: string; n: number }>) counts.set(r.name, r.n);
  return counts;
}

/**
 * JSON-safe catalog shape for client components.
 *
 * Masked columns still appear (the UI must know they exist, to show them as masked
 * and to keep them out of forms) but their DEFAULT expression is stripped: a default
 * can BE the secret, and "never on the wire" has to mean the value too, not just the
 * column. oid/attnum stay server-side — they exist for result-field matching.
 */
export async function catalogForClient() {
  const cat = await getCatalog();
  return {
    tables: [...cat.tables.values()].map((t) => ({
      name: t.name,
      pk: t.pk,
      pkColumns: t.pkColumns,
      columns: t.columns.map(({ attnum: _a, ...c }) => (c.masked ? { ...c, default: null, enumValues: undefined } : c)),
      foreignKeysOut: t.foreignKeysOut,
      referencedBy: t.referencedBy,
      indexes: t.indexes,
      sizeBytes: t.sizeBytes,
      sizePretty: t.sizePretty,
    })),
    enums: Object.fromEntries(cat.enums),
  };
}

export type CatalogForClient = Awaited<ReturnType<typeof catalogForClient>>;
