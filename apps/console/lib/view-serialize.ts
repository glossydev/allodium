import type { ViewDefinition, Field, ColumnField, RelationField, ManyToManyField } from '@allodium/admin/view';
// The runtime's own humanize, not a copy. pruneDefaults strips a title/label that
// equals the default, so this MUST be the same function the resolver defaults with
// or the console would strip decisions the runtime then fails to reproduce.
import { humanize } from '@allodium/admin/view';

/**
 * Writing a definition back out.
 *
 * Deliberately dependency-free — no `server-only`, no catalog — so the round-trip
 * can be tested by running it, which is the only way to catch the failure this
 * module exists to prevent.
 *
 * ## The rule: strip what the runtime infers, keep everything else
 *
 * This used to build its output by listing the keys it knew about, which meant
 * any key it had not been taught was dropped on save. That is silent data loss
 * with no error and no diff to notice — the operator opens a screen, saves an
 * unrelated edit, and a hand-written option is gone.
 *
 * So every level below writes the keys it understands in a deliberate order (for
 * readable `git diff`s, which is the whole reason these are files) and then
 * copies through anything else untouched. A new option added to the contract
 * survives this function without it having to be taught the option at all.
 */

/** Keys this module writes explicitly; anything else is carried through verbatim. */
const KNOWN_ROOT = new Set(['$schema', 'table', 'title', 'description', 'display', 'primaryKey', 'fields', 'list']);
const KNOWN_LIST = new Set(['columns', 'pageSize', 'sort', 'searchColumns']);
const KNOWN_FIELD = new Set([
  'kind', 'name', 'column', 'relation', 'through', 'near', 'far', 'farTable', 'farValue',
  'display', 'widget', 'options', 'placeholder', 'label', 'help', 'readOnly', 'required', 'in',
]);

/** Copy keys from `src` that `known` does not cover. */
function carryUnknown(src: Record<string, unknown>, known: Set<string>, dest: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    if (!known.has(k) && v !== undefined) dest[k] = v;
  }
}

/**
 * Strip anything the runtime would have inferred anyway.
 *
 * This is what keeps a saved file small and readable: a definition should record
 * DECISIONS, not restate defaults. It also means a `git diff` after using the
 * builder shows what you actually changed rather than a wall of noise — which is
 * the whole reason these are files instead of database rows.
 */
export function pruneDefaults(def: ViewDefinition): ViewDefinition {
  const out: Record<string, unknown> = { table: def.table };
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
        if (m.farValue) clean.farValue = m.farValue;
        if (m.display) clean.display = m.display;
        if (m.widget && m.widget !== 'checkboxes') clean.widget = m.widget;
      } else if (f.kind === 'relation') {
        const r = f as RelationField;
        clean.kind = 'relation';
        clean.column = r.column;
        clean.relation = {
          table: r.relation.table,
          ...(r.relation.value ? { value: r.relation.value } : {}),
          ...(r.relation.display ? { display: r.relation.display } : {}),
          // A relation's filter is a human decision the runtime cannot re-derive.
          ...(r.relation.filter ? { filter: r.relation.filter } : {}),
        };
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

      carryUnknown(f as unknown as Record<string, unknown>, KNOWN_FIELD, clean);
      return clean as unknown as Field;
    });
  }

  if (def.list) {
    const l: Record<string, unknown> = {};
    if (def.list.columns?.length) l.columns = def.list.columns;
    if (def.list.pageSize && def.list.pageSize !== 25) l.pageSize = def.list.pageSize;
    if (def.list.sort?.column) l.sort = def.list.sort;
    if (def.list.searchColumns?.length) l.searchColumns = def.list.searchColumns;
    carryUnknown(def.list as unknown as Record<string, unknown>, KNOWN_LIST, l);
    if (Object.keys(l).length) out.list = l;
  }

  carryUnknown(def as unknown as Record<string, unknown>, KNOWN_ROOT, out);
  return out as unknown as ViewDefinition;
}
