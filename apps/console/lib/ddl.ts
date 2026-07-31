import 'server-only';
import { getCatalog, getTable, invalidateCatalog } from './catalog';
import { getDb } from './db';
import { qid, validateIdentifier, pgErrorMessage } from './sql-utils';

/**
 * DDL builders for the Schema silo — the v1 schema builder.
 *
 * Philosophy (owner's spec): simple and sensible, the anti-mystery-error builder.
 * Every mutation is (1) built here from validated parts, (2) shown to the user as
 * SQL before executing, (3) executed in a transaction, (4) failed with the
 * VERBATIM pg error. No UI abstraction ever hides what actually runs.
 *
 * Safety: NEW names pass validateIdentifier (strict snake_case); EXISTING names
 * must resolve in the live catalog; types come from a fixed allowlist (+ live
 * enum types); defaults must match a conservative literal grammar. Nothing
 * user-typed is ever concatenated raw.
 */

type Built = { ok: true; sql: string } | { ok: false; error: string };

const err = (error: string): Built => ({ ok: false, error });

/* ------------------------------- type allowlist ------------------------------- */

/** Fixed scalar types the builder offers. varchar/numeric take validated params. */
const SCALAR_TYPES = new Set([
  'text',
  'integer',
  'bigint',
  'boolean',
  'timestamptz',
  'date',
  'uuid',
  'jsonb',
  'text[]',
]);

const VARCHAR_RE = /^varchar\((\d{1,4})\)$/;
const NUMERIC_RE = /^numeric\((\d{1,3}),\s*(\d{1,3})\)$/;

/** Presets the create-table UI offers for PKs. */
export const PK_PRESETS = {
  serial: { type: 'serial', renders: 'serial' },
  uuid: { type: 'uuid', renders: 'uuid default gen_random_uuid()' },
} as const;

async function resolveType(raw: string): Promise<{ ok: true; sql: string } | { ok: false; error: string }> {
  const t = raw.trim().toLowerCase();
  if (SCALAR_TYPES.has(t)) return { ok: true, sql: t };
  if (t === 'serial') return { ok: true, sql: 'serial' };
  const vc = VARCHAR_RE.exec(t);
  if (vc) {
    // pg rejects varchar(0); catch it here so the preview never shows invalid SQL.
    if (Number(vc[1]) < 1) return { ok: false, error: `varchar length must be at least 1 (got ${vc[1]})` };
    return { ok: true, sql: t };
  }
  const num = NUMERIC_RE.exec(t);
  if (num) {
    if (Number(num[1]) < 1) return { ok: false, error: `numeric precision must be at least 1 (got ${num[1]})` };
    if (Number(num[2]) > Number(num[1])) return { ok: false, error: `numeric scale > precision: ${t}` };
    return { ok: true, sql: t };
  }
  // Live enum types are legal column types (quoted).
  const cat = await getCatalog();
  if (cat.enums.has(raw.trim())) return { ok: true, sql: qid(raw.trim()) };
  return { ok: false, error: `Type not allowed: ${raw}` };
}

/**
 * Conservative DEFAULT grammar: numeric literal, single-quoted string (escaped by
 * doubling), true/false/null, now(), gen_random_uuid(), '{}'::jsonb-ish handled as
 * quoted string + we allow a raw '{}' shorthand for jsonb/array columns.
 */
function resolveDefault(raw: string | undefined): { ok: true; sql: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, sql: null };
  const d = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(d)) return { ok: true, sql: d };
  if (/^(true|false|null)$/i.test(d)) return { ok: true, sql: d.toLowerCase() };
  if (/^(now\(\)|gen_random_uuid\(\))$/i.test(d)) return { ok: true, sql: d.toLowerCase() };
  if (d === '{}') return { ok: true, sql: `'{}'` };
  // Anything else must be a plain string default — we quote and escape it ourselves.
  if (/^'.*'$/.test(d)) {
    const inner = d.slice(1, -1);
    return { ok: true, sql: `'${inner.replaceAll("'", "''")}'` };
  }
  return {
    ok: false,
    error: `Default not allowed: ${d} — use a number, 'quoted string', true/false, now(), gen_random_uuid(), or {}`,
  };
}

/* --------------------------------- builders --------------------------------- */

export interface ColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  pk?: boolean;
  /** Inline FK, so relationships can be declared while creating the table. */
  references?: { table: string; column: string; onDelete?: string };
}

/** Validate an inline REFERENCES clause against the live catalog. */
async function referencesSql(
  ref: NonNullable<ColumnSpec['references']>
): Promise<{ ok: true; sql: string } | { ok: false; error: string }> {
  const target = await getTable(ref.table);
  if (!target) return { ok: false, error: `unknown referenced table: ${ref.table}` };
  if (!target.columns.some((c) => c.name === ref.column)) {
    return { ok: false, error: `unknown referenced column: ${ref.table}.${ref.column}` };
  }
  const onDelete = (ref.onDelete ?? 'no action').toLowerCase();
  if (!ON_DELETE.has(onDelete)) return { ok: false, error: `unknown on-delete behavior: ${ref.onDelete}` };
  const clause = ` references ${qid(target.name)} (${qid(ref.column)})`;
  return { ok: true, sql: onDelete === 'no action' ? clause : `${clause} on delete ${onDelete}` };
}

async function columnSql(c: ColumnSpec): Promise<{ ok: true; sql: string } | { ok: false; error: string }> {
  const name = validateIdentifier(c.name);
  if (!name.ok) return { ok: false, error: name.error };
  const type = await resolveType(c.type);
  if (!type.ok) return type;
  const def = resolveDefault(c.default);
  if (!def.ok) return def;

  // serial already installs a nextval default; a second DEFAULT is a pg error
  // ("multiple default values specified"). Reject with the reason, not the symptom.
  if (type.sql === 'serial' && def.sql !== null) {
    return { ok: false, error: 'serial already provides a default — remove the explicit default' };
  }

  let sql = `${qid(c.name)} ${type.sql}`;
  // serial implies not null; otherwise honor the checkbox.
  if (type.sql !== 'serial' && !c.nullable) sql += ' not null';
  if (def.sql !== null) sql += ` default ${def.sql}`;
  if (c.references) {
    const ref = await referencesSql(c.references);
    if (!ref.ok) return ref;
    sql += ref.sql;
  }
  return { ok: true, sql };
}

export async function buildCreateTable(spec: { name: string; columns: ColumnSpec[] }): Promise<Built> {
  const name = validateIdentifier(spec.name);
  if (!name.ok) return err(name.error);
  if (await getTable(spec.name)) return err(`Table already exists: ${spec.name}`);
  if (!spec.columns.length) return err('At least one column is required');

  const dupes = spec.columns
    .map((c) => c.name.trim().toLowerCase())
    .filter((n, i, a) => n && a.indexOf(n) !== i);
  if (dupes.length) return err(`Duplicate column name: ${[...new Set(dupes)].join(', ')}`);

  const lines: string[] = [];
  for (const c of spec.columns) {
    const built = await columnSql(c);
    if (!built.ok) return err(`${c.name}: ${built.error}`);
    lines.push('  ' + built.sql);
  }
  const pkCols = spec.columns.filter((c) => c.pk).map((c) => qid(c.name));
  if (pkCols.length) lines.push(`  primary key (${pkCols.join(', ')})`);

  return { ok: true, sql: `create table ${qid(spec.name)} (\n${lines.join(',\n')}\n);` };
}

export async function buildAddColumn(table: string, col: ColumnSpec): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  if (t.columns.some((c) => c.name === col.name)) return err(`Column already exists: ${col.name}`);
  const built = await columnSql(col);
  if (!built.ok) return err(built.error);
  if (col.pk) return err('Add the column first, then add a PK constraint separately');
  return { ok: true, sql: `alter table ${qid(t.name)} add column ${built.sql};` };
}

export async function buildDropColumn(table: string, column: string): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  if (!t.columns.some((c) => c.name === column)) return err(`Unknown column: ${column}`);
  return { ok: true, sql: `alter table ${qid(t.name)} drop column ${qid(column)};` };
}

export async function buildDropTable(table: string): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  return { ok: true, sql: `drop table ${qid(t.name)};` };
}

export async function buildRenameTable(table: string, newName: string): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  const name = validateIdentifier(newName);
  if (!name.ok) return err(name.error);
  if (await getTable(newName)) return err(`Table already exists: ${newName}`);
  return { ok: true, sql: `alter table ${qid(t.name)} rename to ${qid(newName)};` };
}

const ON_DELETE = new Set(['no action', 'cascade', 'set null', 'restrict']);

export async function buildAddForeignKey(spec: {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}): Promise<Built> {
  const t = await getTable(spec.table);
  if (!t) return err('Unknown table');
  if (!t.columns.some((c) => c.name === spec.column)) return err(`Unknown column: ${spec.column}`);
  const ref = await getTable(spec.refTable);
  if (!ref) return err('Unknown referenced table');
  if (!ref.columns.some((c) => c.name === spec.refColumn)) return err(`Unknown referenced column: ${spec.refColumn}`);
  const onDelete = spec.onDelete.toLowerCase();
  if (!ON_DELETE.has(onDelete)) return err(`Unknown on-delete behavior: ${spec.onDelete}`);

  // Constraint names are pg identifiers (63-byte cap). Long table/column pairs would
  // otherwise fail with an error about a name the user never typed, so truncate
  // deterministically and keep the flow working.
  let cname = `fk_${spec.table}_${spec.column}`;
  if (cname.length > 63) cname = cname.slice(0, 63).replace(/_+$/, '');

  return {
    ok: true,
    sql: `alter table ${qid(t.name)}\n  add constraint ${qid(cname)}\n  foreign key (${qid(spec.column)})\n  references ${qid(ref.name)} (${qid(spec.refColumn)})\n  on delete ${onDelete};`,
  };
}

/* ----------------------------- alter column ----------------------------- */

export async function buildRenameColumn(table: string, column: string, newName: string): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  if (!t.columns.some((c) => c.name === column)) return err(`Unknown column: ${column}`);
  const name = validateIdentifier(newName);
  if (!name.ok) return err(name.error);
  if (t.columns.some((c) => c.name === newName)) return err(`Column already exists: ${newName}`);
  return { ok: true, sql: `alter table ${qid(t.name)} rename column ${qid(column)} to ${qid(newName)};` };
}

/**
 * Change a column's type. The USING clause is always emitted, even when it looks
 * redundant: it is what actually converts existing rows, and showing it is the
 * point — the preview should never hide the conversion that is about to run.
 */
export async function buildAlterColumnType(table: string, column: string, newType: string): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  const col = t.columns.find((c) => c.name === column);
  if (!col) return err(`Unknown column: ${column}`);
  const type = await resolveType(newType);
  if (!type.ok) return err(type.error);
  if (type.sql === 'serial') return err('serial is a shorthand for table creation, not a column type — use integer');
  return {
    ok: true,
    sql: `alter table ${qid(t.name)}\n  alter column ${qid(column)} type ${type.sql}\n  using ${qid(column)}::${type.sql};`,
  };
}

export async function buildSetNotNull(table: string, column: string, notNull: boolean): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  const col = t.columns.find((c) => c.name === column);
  if (!col) return err(`Unknown column: ${column}`);
  return {
    ok: true,
    sql: `alter table ${qid(t.name)} alter column ${qid(column)} ${notNull ? 'set' : 'drop'} not null;`,
  };
}

export async function buildSetDefault(table: string, column: string, value: string | undefined): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  if (!t.columns.some((c) => c.name === column)) return err(`Unknown column: ${column}`);
  const def = resolveDefault(value);
  if (!def.ok) return err(def.error);
  return {
    ok: true,
    sql:
      def.sql === null
        ? `alter table ${qid(t.name)} alter column ${qid(column)} drop default;`
        : `alter table ${qid(t.name)} alter column ${qid(column)} set default ${def.sql};`,
  };
}

/**
 * How many rows would violate a pending SET NOT NULL. Cheap, and it turns a
 * pg failure into a sentence the UI can show BEFORE the user commits to it.
 */
export async function countNulls(table: string, column: string): Promise<number | null> {
  const t = await getTable(table);
  if (!t || !t.columns.some((c) => c.name === column)) return null;
  const res = await getDb().pool.query(`select count(*)::int as n from ${qid(t.name)} where ${qid(column)} is null`);
  return (res.rows[0] as { n: number }).n;
}

/* ------------------------------- comments -------------------------------- */

/**
 * COMMENT ON — schema-level documentation.
 *
 * Worth doing properly rather than storing descriptions in app config: a comment
 * lives WITH the column, shows up in psql and every other Postgres tool, survives
 * a dump/restore, and travels with the migration that created the column. The
 * admin runtime reads it as default help text, so a field is described once
 * instead of once per screen that shows it.
 *
 * The text is DATA, not an identifier — it goes through literal quoting, and an
 * empty string drops the comment rather than storing "".
 */
export async function buildSetColumnComment(table: string, column: string, comment: string | null): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  if (!t.columns.some((c) => c.name === column)) return err(`Unknown column: ${column}`);
  const text = comment?.trim() ? qlit(comment.trim()) : 'null';
  return { ok: true, sql: `comment on column ${qid(t.name)}.${qid(column)} is ${text};` };
}

export async function buildSetTableComment(table: string, comment: string | null): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  const text = comment?.trim() ? qlit(comment.trim()) : 'null';
  return { ok: true, sql: `comment on table ${qid(t.name)} is ${text};` };
}

/* -------------------------------- indexes -------------------------------- */

/** Postgres caps identifiers at 63 bytes; generated names must fit or it errors. */
const fitIdentifier = (s: string) => (s.length > 63 ? s.slice(0, 63).replace(/_+$/, '') : s);

export async function buildCreateIndex(spec: {
  table: string;
  columns: string[];
  unique?: boolean;
  name?: string;
}): Promise<Built> {
  const t = await getTable(spec.table);
  if (!t) return err('Unknown table');
  if (!spec.columns?.length) return err('Pick at least one column');
  for (const c of spec.columns) {
    if (!t.columns.some((x) => x.name === c)) return err(`Unknown column: ${c}`);
  }
  const dupes = spec.columns.filter((c, i, a) => a.indexOf(c) !== i);
  if (dupes.length) return err(`Column listed twice: ${dupes[0]}`);

  const name = spec.name?.trim() || fitIdentifier(`${t.name}_${spec.columns.join('_')}_${spec.unique ? 'key' : 'idx'}`);
  const check = validateIdentifier(name);
  if (!check.ok) return err(check.error);

  return {
    ok: true,
    sql: `create ${spec.unique ? 'unique ' : ''}index ${qid(name)}\n  on ${qid(t.name)} (${spec.columns.map(qid).join(', ')});`,
  };
}

export async function buildDropIndex(name: string): Promise<Built> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) return err('Invalid index name');
  return { ok: true, sql: `drop index ${qid(name)};` };
}

/* ------------------------------- enum types ------------------------------- */

/** Enum labels are data, not identifiers — quoted as string literals. */
const qlit = (s: string) => `'${s.replaceAll("'", "''")}'`;

function validateEnumValues(values: unknown): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(values)) return { ok: false, error: 'values must be an array' };
  const out: string[] = [];
  for (const raw of values) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) return { ok: false, error: 'Enum values cannot be empty' };
    if (v.length > 63) return { ok: false, error: `Enum value too long: ${v.slice(0, 20)}…` };
    if (out.includes(v)) return { ok: false, error: `Duplicate enum value: ${v}` };
    out.push(v);
  }
  if (!out.length) return { ok: false, error: 'An enum needs at least one value' };
  return { ok: true, values: out };
}

export async function buildCreateEnum(spec: { name: string; values: unknown }): Promise<Built> {
  const name = validateIdentifier(spec.name);
  if (!name.ok) return err(name.error);
  const cat = await getCatalog();
  if (cat.enums.has(spec.name)) return err(`Type already exists: ${spec.name}`);
  if (cat.tables.has(spec.name)) return err(`A table already uses that name: ${spec.name}`);
  const vals = validateEnumValues(spec.values);
  if (!vals.ok) return err(vals.error);
  return {
    ok: true,
    sql: `create type ${qid(spec.name)} as enum (${vals.values.map(qlit).join(', ')});`,
  };
}

export async function buildAddEnumValue(spec: { type: string; value: string; before?: string }): Promise<Built> {
  const cat = await getCatalog();
  const existing = cat.enums.get(spec.type);
  if (!existing) return err(`Unknown enum type: ${spec.type}`);
  const vals = validateEnumValues([spec.value]);
  if (!vals.ok) return err(vals.error);
  if (existing.includes(vals.values[0])) return err(`Value already exists: ${vals.values[0]}`);
  // Position matters for ORDER BY on an enum column, so allow inserting before an
  // existing label rather than only appending.
  const where = spec.before ? ` before ${qlit(spec.before)}` : '';
  if (spec.before && !existing.includes(spec.before)) return err(`Unknown value to insert before: ${spec.before}`);
  return { ok: true, sql: `alter type ${qid(spec.type)} add value ${qlit(vals.values[0])}${where};` };
}

export async function buildRenameEnumValue(spec: { type: string; from: string; to: string }): Promise<Built> {
  const cat = await getCatalog();
  const existing = cat.enums.get(spec.type);
  if (!existing) return err(`Unknown enum type: ${spec.type}`);
  if (!existing.includes(spec.from)) return err(`Unknown value: ${spec.from}`);
  const vals = validateEnumValues([spec.to]);
  if (!vals.ok) return err(vals.error);
  if (existing.includes(vals.values[0])) return err(`Value already exists: ${vals.values[0]}`);
  return { ok: true, sql: `alter type ${qid(spec.type)} rename value ${qlit(spec.from)} to ${qlit(vals.values[0])};` };
}

export async function buildDropEnum(name: string): Promise<Built> {
  const cat = await getCatalog();
  if (!cat.enums.has(name)) return err(`Unknown enum type: ${name}`);
  return { ok: true, sql: `drop type ${qid(name)};` };
}

export async function buildDropConstraint(table: string, constraint: string): Promise<Built> {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  // Constraint names come from the catalog (index list / FK names), but validate
  // shape anyway — they're still identifiers.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(constraint)) return err('Invalid constraint name');
  return { ok: true, sql: `alter table ${qid(t.name)} drop constraint ${qid(constraint)};` };
}

export async function buildCreateJoinTable(spec: { tableA: string; tableB: string; name?: string }): Promise<Built> {
  const a = await getTable(spec.tableA);
  if (!a) return err('Unknown table: ' + spec.tableA);
  const b = await getTable(spec.tableB);
  if (!b) return err('Unknown table: ' + spec.tableB);
  if (!a.pk || !b.pk) return err('Both tables need a single-column primary key');
  if (a.name === b.name) return err('Pick two different tables');

  const name = spec.name?.trim() || `${a.name}_${b.name}`;
  const nameCheck = validateIdentifier(name);
  if (!nameCheck.ok) return err(nameCheck.error);
  if (await getTable(name)) return err(`Table already exists: ${name}`);

  const aPk = a.columns.find((c) => c.name === a.pk)!;
  const bPk = b.columns.find((c) => c.name === b.pk)!;

  /**
   * The FK column type must match the referenced PK exactly or pg rejects the
   * constraint. Mapping unknown types to `text` produced SQL that always failed, so
   * derive from the real udt and refuse what we can't express.
   */
  const typeOf = (udt: string, len: number | null): { ok: true; sql: string } | { ok: false; error: string } => {
    switch (udt) {
      case 'int2':
        return { ok: true, sql: 'smallint' };
      case 'int4':
        return { ok: true, sql: 'integer' };
      case 'int8':
        return { ok: true, sql: 'bigint' };
      case 'uuid':
        return { ok: true, sql: 'uuid' };
      case 'text':
        return { ok: true, sql: 'text' };
      case 'varchar':
        return { ok: true, sql: len ? `varchar(${len})` : 'varchar' };
      case 'bpchar':
        return { ok: true, sql: len ? `char(${len})` : 'char' };
      default:
        return { ok: false, error: `unsupported primary-key type for a join table: ${udt}` };
    }
  };

  /** varchar(n) etc. — recover the declared length from the display type. */
  const lenOf = (display: string) => {
    const m = /\((\d+)\)/.exec(display);
    return m ? Number(m[1]) : null;
  };

  const typeA = typeOf(aPk.udtName, lenOf(aPk.type));
  if (!typeA.ok) return err(`${a.name}.${a.pk}: ${typeA.error}`);
  const typeB = typeOf(bPk.udtName, lenOf(bPk.type));
  if (!typeB.ok) return err(`${b.name}.${b.pk}: ${typeB.error}`);

  // Join-table columns are <table>_<pk>. These CAN collide across distinct tables
  // (e.g. `user` + `roles.user_id` shapes), and a duplicate column is a pg error, so
  // disambiguate instead of asserting it cannot happen.
  let colA = `${a.name}_${a.pk}`;
  let colB = `${b.name}_${b.pk}`;
  if (colA === colB) {
    colA = `${a.name}_a_${a.pk}`;
    colB = `${b.name}_b_${b.pk}`;
  }
  for (const col of [colA, colB]) {
    const check = validateIdentifier(col);
    if (!check.ok) return err(`derived column ${col}: ${check.error}`);
  }

  return {
    ok: true,
    sql: `create table ${qid(name)} (\n  ${qid(colA)} ${typeA.sql} not null references ${qid(a.name)} (${qid(a.pk)}) on delete cascade,\n  ${qid(colB)} ${typeB.sql} not null references ${qid(b.name)} (${qid(b.pk)}) on delete cascade,\n  primary key (${qid(colA)}, ${qid(colB)})\n);`,
  };
}

/* --------------------------------- executor --------------------------------- */

export async function executeDdl(sql: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = await getDb().pool.connect();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    invalidateCatalog();
    console.log('[console] DDL:', sql.replaceAll('\n', ' '));
    return { ok: true };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    return { ok: false, error: pgErrorMessage(e) };
  } finally {
    client.release();
  }
}
