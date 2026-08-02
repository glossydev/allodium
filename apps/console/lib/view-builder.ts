import 'server-only';
import type { ViewDefinition, Field, ColumnField, RelationField, ManyToManyField } from '@allodium/admin/view';
// The runtime's own humanize, not a copy. pruneDefaults strips a title/label that
// equals the default, so this MUST be the same function the resolver defaults with
// or the console would strip decisions the runtime then fails to reproduce.
import { humanize } from '@allodium/admin/view';
import { getCatalog, type CatalogTable } from './catalog';

/**
 * Proposing a starting definition — the console's half of "one lane builds the other".
 *
 * Everything here is a GUESS the operator can override. The point is that opening
 * the builder on a table should already show a screen worth keeping, so the work is
 * editing a draft rather than filling in a blank form.
 */

/**
 * Which column of a table a human recognises a row by. Same heuristic the FK peek
 * uses, deliberately: if the peek card shows you "Grace Hopper", the relation
 * dropdown built from the same table should too.
 */
const NAMEY = ['name', 'title', 'label', 'display_name', 'full_name', 'filename', 'email', 'key', 'slug', 'order_number', 'sku'];

export function guessDisplayColumn(t: CatalogTable): string | undefined {
  const visible = t.columns.filter((c) => !c.masked);
  for (const n of NAMEY) {
    if (visible.some((c) => c.name === n)) return n;
  }
  return visible.find((c) => !c.isPk && (c.family === 'string' || c.family === 'enum'))?.name;
}

/**
 * Join tables that link `table` to something else: a composite primary key whose
 * columns are all foreign keys, one of which points back here.
 *
 * Same rule as the runtime's — NOT "a table with two foreign keys", which would
 * misread user_roles (three FKs, plus granted_at/granted_by payload).
 */
export interface DetectedM2M {
  through: string;
  near: string;
  far: string;
  farTable: string;
  /** Extra columns on the join table — payload the console cannot edit through an m2m field. */
  payload: string[];
}

export function detectManyToMany(cat: Awaited<ReturnType<typeof getCatalog>>, table: string): DetectedM2M[] {
  const out: DetectedM2M[] = [];
  for (const jt of cat.tables.values()) {
    if (jt.name === table || jt.pkColumns.length !== 2) continue;
    const fkFor = (col: string) => jt.foreignKeysOut.find((f) => f.column === col);
    const [a, b] = jt.pkColumns;
    const fa = fkFor(a);
    const fb = fkFor(b);
    if (!fa || !fb) continue; // both PK columns must be foreign keys

    const near = fa.refTable === table ? a : fb.refTable === table ? b : null;
    if (!near) continue;
    const far = near === a ? b : a;
    const farFk = fkFor(far)!;
    out.push({
      through: jt.name,
      near,
      far,
      farTable: farFk.refTable,
      payload: jt.columns.filter((c) => !jt.pkColumns.includes(c.name)).map((c) => c.name),
    });
  }
  return out;
}

/** A full draft definition for a table: every column, plus any many-to-many found. */
export async function proposeView(table: string): Promise<{ definition: ViewDefinition; m2m: DetectedM2M[] } | null> {
  const cat = await getCatalog();
  const t = cat.tables.get(table);
  if (!t) return null;

  const fields: Field[] = [];
  for (const c of t.columns) {
    if (c.masked) continue; // a secret column has no business on an admin screen
    if (c.fkTable && c.fkColumn) {
      const target = cat.tables.get(c.fkTable);
      fields.push({
        kind: 'relation',
        column: c.name,
        relation: {
          table: c.fkTable,
          value: c.fkColumn,
          ...(target && guessDisplayColumn(target) ? { display: guessDisplayColumn(target) } : {}),
        },
      } as RelationField);
    } else {
      fields.push({ column: c.name } as ColumnField);
    }
  }

  const m2m = detectManyToMany(cat, table);
  for (const link of m2m) {
    const far = cat.tables.get(link.farTable);
    fields.push({
      kind: 'm2m',
      name: link.farTable,
      through: link.through,
      near: link.near,
      far: link.far,
      farTable: link.farTable,
      ...(far && guessDisplayColumn(far) ? { display: guessDisplayColumn(far) } : {}),
    } as ManyToManyField);
  }

  return { definition: { table, display: guessDisplayColumn(t), fields }, m2m };
}

/* ---------------------------- writing it back ---------------------------- */

/**
 * Strip anything the runtime would have inferred anyway.
 *
 * This is what keeps a saved file small and readable: a definition should record
 * DECISIONS, not restate defaults. It also means a `git diff` after using the
 * builder shows what you actually changed rather than a wall of noise — which is
 * the whole reason these are files instead of database rows.
 */
export function pruneDefaults(def: ViewDefinition): ViewDefinition {
  const out: ViewDefinition = { table: def.table };
  if (def.title && def.title !== humanize(def.table)) out.title = def.title;
  if (def.description) out.description = def.description;
  if (def.display) out.display = def.display;
  if (def.primaryKey) out.primaryKey = def.primaryKey;

  if (def.fields?.length) {
    out.fields = def.fields.map((f) => {
      const clean: Record<string, unknown> = {};
      const key = f.kind === 'm2m' ? ((f as ManyToManyField).name ?? (f as ManyToManyField).farTable) : (f as ColumnField).column;

      if (f.kind === 'm2m') {
        const m = f as ManyToManyField;
        Object.assign(clean, {
          kind: 'm2m',
          name: m.name,
          through: m.through,
          near: m.near,
          far: m.far,
          farTable: m.farTable,
        });
        if (m.display) clean.display = m.display;
        if (m.widget && m.widget !== 'checkboxes') clean.widget = m.widget;
      } else if (f.kind === 'relation') {
        const r = f as RelationField;
        clean.kind = 'relation';
        clean.column = r.column;
        clean.relation = { table: r.relation.table, ...(r.relation.value ? { value: r.relation.value } : {}), ...(r.relation.display ? { display: r.relation.display } : {}) };
        if (r.widget && r.widget !== 'select') clean.widget = r.widget;
      } else {
        const c = f as ColumnField;
        clean.column = c.column;
        // Widget is only recorded when it differs from what the column's type implies.
        if (c.widget) clean.widget = c.widget;
        if (c.options?.length) clean.options = c.options;
        if (c.placeholder) clean.placeholder = c.placeholder;
      }

      if (f.label && f.label !== humanize(key)) clean.label = f.label;
      if (f.help) clean.help = f.help;
      if (f.readOnly) clean.readOnly = true;
      if (f.required !== undefined) clean.required = f.required;
      if (f.in && !(f.in.includes('list') && f.in.includes('form'))) clean.in = f.in;

      return clean as unknown as Field;
    });
  }

  if (def.list) {
    const l: NonNullable<ViewDefinition['list']> = {};
    if (def.list.columns?.length) l.columns = def.list.columns;
    if (def.list.pageSize && def.list.pageSize !== 25) l.pageSize = def.list.pageSize;
    if (def.list.sort?.column) l.sort = def.list.sort;
    if (def.list.searchColumns?.length) l.searchColumns = def.list.searchColumns;
    if (Object.keys(l).length) out.list = l;
  }

  return out;
}
