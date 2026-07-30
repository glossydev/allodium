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
