import { getTableColumns, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Schema-driven table registry — the core of the admin lane.
 *
 * Everything an admin surface knows about tables comes from Drizzle metadata at
 * runtime: names, SQL types, PKs, nullability, defaults, and the FK graph. There is
 * NO parallel configuration language — new tables appear the moment they land in the
 * schema module, and the registry can never drift from the code because it IS the code.
 *
 * Credential/secret columns are masked by name: never selected, never editable, never
 * on the wire. Masking is the deployment's one required piece of judgment — pass every
 * password/token/hash column your schema carries.
 */

export interface RegistryColumn {
  /** Drizzle TS property key (select/insert mapping). */
  key: string;
  /** SQL column name (wire key, what a UI shows). */
  name: string;
  /** SQL type for display (e.g. 'varchar(255)'). */
  sqlType: string;
  /** Drizzle data family: string | number | boolean | json | date | ... */
  dataType: string;
  pk: boolean;
  notNull: boolean;
  hasDefault: boolean;
  masked: boolean;
  /** FK target, when this column references another table in the schema. */
  fkTable?: string;
  fkColumn?: string;
}

export interface RegisteredTable {
  name: string;
  table: PgTable;
  columns: RegistryColumn[];
  columnsByName: Map<string, { meta: RegistryColumn; column: AnyPgColumn }>;
  pk: { meta: RegistryColumn; column: AnyPgColumn } | null;
}

export interface TableRegistry {
  /** All registered tables, keyed by SQL table name. Built once, cached. */
  registry(): Map<string, RegisteredTable>;
  table(name: string): RegisteredTable | null;
  /** JSON-safe schema description for a UI (keys dropped, sorted by name). */
  schemaForClient(): Array<{
    name: string;
    pk: string | null;
    columns: Array<Omit<RegistryColumn, 'key'>>;
  }>;
}

export function createTableRegistry(opts: {
  /** Your Drizzle schema module (import * as schema). Every exported PgTable registers. */
  schema: Record<string, unknown>;
  /** Secret columns by SQL table name → SQL column names. Masked end-to-end. */
  maskedColumns?: Record<string, Iterable<string>>;
  /** Extra/override table defs — same-named entries replace the schema module's. */
  extraTables?: PgTable[];
}): TableRegistry {
  const maskedByTable = new Map<string, Set<string>>(
    Object.entries(opts.maskedColumns ?? {}).map(([t, cols]) => [t, new Set(cols)])
  );

  function buildEntry(table: PgTable): RegisteredTable {
    const cfg = getTableConfig(table);
    const masked = maskedByTable.get(cfg.name) ?? new Set<string>();

    // FK map: local column name -> {table, column}
    const fkByColumn = new Map<string, { fkTable: string; fkColumn: string }>();
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const local = ref.columns[0];
      const foreign = ref.foreignColumns[0];
      if (local && foreign) {
        fkByColumn.set(local.name, {
          fkTable: getTableConfig(ref.foreignTable as PgTable).name,
          fkColumn: foreign.name,
        });
      }
    }

    const columns: RegistryColumn[] = [];
    const columnsByName = new Map<string, { meta: RegistryColumn; column: AnyPgColumn }>();
    let pk: RegisteredTable['pk'] = null;

    for (const [key, col] of Object.entries(getTableColumns(table))) {
      const c = col as AnyPgColumn;
      const meta: RegistryColumn = {
        key,
        name: c.name,
        sqlType: c.getSQLType(),
        dataType: c.dataType,
        pk: c.primary,
        notNull: c.notNull,
        hasDefault: c.hasDefault,
        masked: masked.has(c.name),
        ...(fkByColumn.get(c.name) ?? {}),
      };
      columns.push(meta);
      columnsByName.set(c.name, { meta, column: c });
      if (c.primary) pk = { meta, column: c };
    }

    return { name: cfg.name, table, columns, columnsByName, pk };
  }

  let cache: Map<string, RegisteredTable> | null = null;

  const registry = (): Map<string, RegisteredTable> => {
    if (cache) return cache;
    const map = new Map<string, RegisteredTable>();
    for (const value of Object.values(opts.schema)) {
      if (is(value, PgTable)) {
        const entry = buildEntry(value);
        map.set(entry.name, entry);
      }
    }
    for (const t of opts.extraTables ?? []) {
      const entry = buildEntry(t);
      map.set(entry.name, entry);
    }
    cache = map;
    return map;
  };

  return {
    registry,
    table: (name) => registry().get(name) ?? null,
    schemaForClient: () =>
      [...registry().values()]
        .map((t) => ({
          name: t.name,
          pk: t.pk?.meta.name ?? null,
          columns: t.columns.map(({ key: _key, ...rest }) => rest),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
