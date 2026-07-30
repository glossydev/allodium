import 'server-only';
import { getDb } from './db';
import { getTable, type CatalogTable, type CatalogColumn } from './catalog';
import { maskedInsertBlockers } from './masking';
import { castExpr, qid } from './sql-utils';

/**
 * Catalog-driven DML — the console's one read/write path over arbitrary tables.
 *
 * Safety model (see sql-utils.ts): table and column names must resolve in the
 * live catalog before they reach SQL (so they exist and are qid-quoted known
 * names); values ONLY travel as bound parameters with ::casts from udt_name.
 *
 * Masked columns are stripped from every read and rejected on every write.
 * These are RAW table writes — no app logic fires. That's the console's contract.
 */

export type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'null' | 'notnull';
export interface Filter {
  col: string;
  op: FilterOp;
  val?: string;
}

const err = (error: string) => ({ ok: false as const, error });

function visibleColumns(t: CatalogTable): CatalogColumn[] {
  return t.columns.filter((c) => !c.masked);
}

/** SELECT list that never touches masked columns. */
function selectList(t: CatalogTable): string {
  return selectListFor(visibleColumns(t));
}

/** SELECT list for an explicit column set (already mask-filtered by the caller). */
function selectListFor(cols: CatalogColumn[]): string {
  if (!cols.length) return 'null as __empty';
  // Timestamps → ISO-ish text at the SQL layer so the wire is JSON-stable
  // (the node-pg Date round trip is where timezone bugs breed — see @allodium/db).
  return cols
    .map((c) => {
      if (c.udtName === 'timestamptz') return `to_char(${qid(c.name)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${qid(c.name)}`;
      if (c.udtName === 'timestamp') return `to_char(${qid(c.name)}, 'YYYY-MM-DD"T"HH24:MI:SS.MS') as ${qid(c.name)}`;
      if (c.udtName === 'date') return `to_char(${qid(c.name)}, 'YYYY-MM-DD') as ${qid(c.name)}`;
      return qid(c.name);
    })
    .join(', ');
}

interface WhereBuild {
  clause: string; // starts with ' where ' or ''
  params: unknown[];
}

function buildWhere(t: CatalogTable, filters: Filter[], startIndex = 1): WhereBuild | { error: string } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;
  for (const f of filters) {
    const col = t.columns.find((c) => c.name === f.col);
    if (!col || col.masked) return { error: `Unknown filter column: ${f.col}` };
    const id = qid(col.name);
    switch (f.op) {
      case 'eq':
        parts.push(`${id}::text = $${i++}`);
        params.push(f.val ?? '');
        break;
      case 'neq':
        parts.push(`${id}::text is distinct from $${i++}`);
        params.push(f.val ?? '');
        break;
      case 'contains':
        parts.push(`${id}::text ilike $${i++}`);
        params.push('%' + (f.val ?? '') + '%');
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
        // Compare in the column's own type — text comparison breaks numbers/dates.
        parts.push(`${id} ${op} ${castExpr(`$${i++}`, col.udtName)}`);
        params.push(f.val ?? '');
        break;
      }
      case 'null':
        parts.push(`${id} is null`);
        break;
      case 'notnull':
        parts.push(`${id} is not null`);
        break;
      default:
        return { error: `Unknown filter op: ${String(f.op)}` };
    }
  }
  return { clause: parts.length ? ' where ' + parts.join(' and ') : '', params };
}

export interface SelectRowsArgs {
  table: string;
  page?: number;
  pageSize?: number;
  sort?: string | null;
  dir?: 'asc' | 'desc';
  filters?: Filter[];
}

/**
 * Which columns a hover card should show, in priority order.
 *
 * Deliberately a HEURISTIC with no configuration: the console has no per-table
 * config anywhere else, and requiring one here would mean a table is unhelpful
 * until someone remembers to annotate it. The ordering below reads like what a
 * human wants to confirm — "is this the right row?" — rather than column order.
 */
function peekColumns(t: CatalogTable, refColumn: string): CatalogColumn[] {
  const visible = visibleColumns(t);
  const chosen: CatalogColumn[] = [];
  const take = (c: CatalogColumn | undefined) => {
    if (c && !chosen.some((x) => x.name === c.name)) chosen.push(c);
  };

  // 1. The column being referenced — the identity you clicked through.
  take(visible.find((c) => c.name === refColumn));
  // 2. The most name-like column: what a person actually recognizes a row by.
  const NAMEY = ['name', 'title', 'label', 'display_name', 'full_name', 'filename', 'email', 'key', 'slug', 'order_number', 'sku'];
  for (const n of NAMEY) take(visible.find((c) => c.name === n));
  // 3. Status-ish columns — enums and booleans carry a lot of meaning per pixel.
  for (const c of visible) {
    if (chosen.length >= 6) break;
    if (c.family === 'enum' || c.family === 'boolean') take(c);
  }
  // 4. Fill the rest in declaration order, skipping noise a card can't use:
  //    long text bodies, json blobs, arrays, and the PK if already covered.
  for (const c of visible) {
    if (chosen.length >= 6) break;
    if (c.family === 'json' || c.family === 'array') continue;
    if (c.udtName === 'text') continue;
    take(c);
  }
  return chosen.slice(0, 6);
}

/**
 * Fetch ONE referenced row for a hover peek, trimmed to peekColumns.
 * `column` must be the FK's target column (catalog-verified, and masked columns
 * are refused so a peek can never become a secret oracle).
 */
export async function peekRow(table: string, column: string, value: string) {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  const col = t.columns.find((c) => c.name === column);
  if (!col) return err(`Unknown column: ${column}`);
  if (col.masked) return err(`Column is masked: ${column}`);

  const cols = peekColumns(t, column);
  if (!cols.length) return err('Table has no showable columns');

  const { pool } = getDb();
  const res = await pool.query(
    `select ${selectListFor(cols)} from ${qid(t.name)} where ${qid(col.name)}::text = $1 limit 1`,
    [value]
  );

  return {
    ok: true as const,
    row: (res.rows[0] as Record<string, unknown> | undefined) ?? null,
    columns: cols.map((c) => ({ name: c.name, type: c.type, family: c.family, isPk: c.isPk })),
    pk: t.pk,
  };
}

export async function selectRows(args: SelectRowsArgs) {
  const t = await getTable(args.table);
  if (!t) return err('Unknown table');

  const page = Math.max(1, args.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, args.pageSize ?? 50));

  const where = buildWhere(t, args.filters ?? []);
  if ('error' in where) return err(where.error);

  // Sort: requested visible column, else single PK desc, else first column.
  // The PK fallback must ALSO respect masking — ordering by a secret leaks its
  // collation order, which is the same oracle buildWhere refuses filters for.
  const pkVisible = t.pk && !t.columns.find((c) => c.name === t.pk)?.masked ? t.pk : null;
  const sortCol =
    (args.sort && t.columns.find((c) => c.name === args.sort && !c.masked)?.name) ||
    pkVisible ||
    visibleColumns(t)[0]?.name;
  if (!sortCol) return err('Table has no selectable columns');
  const dir = args.dir === 'asc' ? 'asc' : 'desc';

  // Parameterized raw SQL goes through the pool directly (drizzle's sql.raw
  // carries no bind params); identifiers are catalog-verified + qid-quoted above.
  const { pool } = getDb();
  const offset = (page - 1) * pageSize;
  const body = `from ${qid(t.name)}${where.clause}`;
  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `select ${selectList(t)} ${body} order by ${qid(sortCol)} ${dir} nulls last limit ${pageSize} offset ${offset}`,
      where.params
    ),
    pool.query(`select count(*)::int as n ${body}`, where.params),
  ]);

  return {
    ok: true as const,
    rows: rowsRes.rows as Record<string, unknown>[],
    total: (countRes.rows[0] as { n: number }).n,
    page,
    pageSize,
  };
}

type WritePairs =
  | { ok: false; error: string }
  | { ok: true; cols: string[]; exprs: string[]; params: unknown[]; nextIndex: number };

/** values arrive keyed by column name; strings are coerced by ::cast in pg itself. */
function buildWritePairs(t: CatalogTable, values: unknown, startIndex = 1): WritePairs {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'values must be an object' };
  }
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;
  for (const [name, raw] of Object.entries(values as Record<string, unknown>)) {
    const col = t.columns.find((c) => c.name === name);
    if (!col) return { ok: false, error: `Unknown column: ${name}` };
    if (col.masked) return { ok: false, error: `Column is not editable: ${name}` };
    cols.push(qid(col.name));
    if (raw === null) {
      exprs.push('null');
    } else {
      exprs.push(castExpr(`$${i++}`, col.udtName));
      // jsonb/json params must be strings for the ::cast; arrays pass as JS arrays.
      params.push(col.family === 'json' && typeof raw !== 'string' ? JSON.stringify(raw) : raw);
    }
  }
  return { ok: true, cols, exprs, params, nextIndex: i };
}

export async function insertRow(table: string, values: unknown) {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  // A masked NOT NULL column with no default cannot be satisfied through the generic
  // path — say so plainly instead of letting pg raise an opaque NOT NULL violation.
  const blockers = maskedInsertBlockers(t.columns);
  if (blockers.length) {
    return err(
      `${t.name} cannot be inserted here: ${blockers.join(', ')} ${blockers.length === 1 ? 'is' : 'are'} masked, NOT NULL, and ${blockers.length === 1 ? 'has' : 'have'} no default. Use a purpose-built route (see /api/users/create) or exempt the column via CONSOLE_MASK_EXEMPT.`
    );
  }
  const w = buildWritePairs(t, values);
  if (!w.ok) return err(w.error);
  if (!w.cols.length) return err('No values');

  const q = `insert into ${qid(t.name)} (${w.cols.join(', ')}) values (${w.exprs.join(', ')}) returning ${selectList(t)}`;
  const res = await getDb().pool.query(q, w.params);
  return { ok: true as const, row: res.rows[0] as Record<string, unknown> };
}

type PkWhere = { ok: false; error: string } | { ok: true; clause: string; params: string[] };

function pkWhere(t: CatalogTable, id: unknown, startIndex: number): PkWhere {
  if (!t.pk) return { ok: false, error: 'Table has no single-column primary key' };
  if (id === null || id === undefined || id === '') return { ok: false, error: 'Missing id' };
  const col = t.columns.find((c) => c.name === t.pk)!;
  // A masked PK would turn update/delete into an equality-confirmation oracle on the
  // secret ("did row X exist with this hash?"), so refuse rather than probe it.
  if (col.masked) {
    return { ok: false, error: `Primary key ${t.name}.${col.name} is masked — rows cannot be addressed by it` };
  }
  return {
    ok: true,
    clause: ` where ${qid(col.name)} = ${castExpr(`$${startIndex}`, col.udtName)}`,
    params: [String(id)],
  };
}

export async function updateRow(table: string, id: unknown, values: unknown) {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  const w = buildWritePairs(t, values);
  if (!w.ok) return err(w.error);
  if (!w.cols.length) return err('No values');
  const pk = pkWhere(t, id, w.nextIndex);
  if (!pk.ok) return err(pk.error);

  const sets = w.cols.map((c, idx) => `${c} = ${w.exprs[idx]}`).join(', ');
  const q = `update ${qid(t.name)} set ${sets}${pk.clause} returning ${selectList(t)}`;
  const res = await getDb().pool.query(q, [...w.params, ...pk.params]);
  if (!res.rows.length) return err('Row not found');
  return { ok: true as const, row: res.rows[0] as Record<string, unknown> };
}

export async function deleteRow(table: string, id: unknown) {
  const t = await getTable(table);
  if (!t) return err('Unknown table');
  const pk = pkWhere(t, id, 1);
  if (!pk.ok) return err(pk.error);

  const res = await getDb().pool.query(`delete from ${qid(t.name)}${pk.clause}`, pk.params);
  if (!res.rowCount) return err('Row not found');
  return { ok: true as const };
}
