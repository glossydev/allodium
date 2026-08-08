import type { ViewDefinition, Field, ColumnField, RelationField, ManyToManyField, RelatedList } from '@allodium/admin/view';

export type { ViewDefinition, Field, ColumnField, RelationField, ManyToManyField, RelatedList };

/**
 * The builder's working shape.
 *
 * A definition on disk only lists fields that are INCLUDED, but the editor needs
 * to show excluded ones too so you can put them back. So the builder holds every
 * candidate field with an `include` flag, and the flag is dropped on save — the
 * file records what is on the screen, not what was considered.
 */
export interface DraftField {
  include: boolean;
  field: Field;
  /** Help text inherited from the column's COMMENT — shown as a placeholder, never written. */
  inheritedHelp?: string | null;
  /** Live column facts for the editor: type, nullability, enum-ness. */
  meta?: { type: string; family: string; nullable: boolean; isPk: boolean };
}

export interface Draft {
  name: string;
  table: string;
  title: string;
  description: string;
  display: string;
  fields: DraftField[];
  listColumns: string[];
  pageSize: number;
  searchColumns: string[];
  /** Panels of rows belonging to this record — see RelatedList in the contract. */
  related: RelatedList[];
  /**
   * The file on disk has no `fields` key, which the runtime reads as "every
   * visible column, including ones added later". Tracked so the editor can say
   * so — saving pins the list and that automatic behavior stops.
   */
  implicitFields: boolean;
  /**
   * The definition exactly as it was loaded.
   *
   * The editor models a SUBSET of the format — it has controls for the list
   * columns, page size and search columns, and nothing for `primaryKey`,
   * `list.sort` or `list.filter`. Rebuilding the definition from the editor's
   * own state therefore deleted every key it had no control for: open a
   * hand-written view, change a label, save, and the sort order was gone with
   * no error and nothing in the diff to explain it.
   *
   * So saving MERGES onto this instead of starting from nothing. What the editor
   * models, it owns; everything else is carried through untouched.
   */
  source: ViewDefinition;
}

export const fieldKeyOf = (f: Field): string =>
  f.kind === 'm2m' ? ((f as ManyToManyField).name ?? (f as ManyToManyField).farTable) : (f as ColumnField).column;

export const fieldKind = (f: Field): 'column' | 'relation' | 'm2m' => (f.kind === 'm2m' ? 'm2m' : f.kind === 'relation' ? 'relation' : 'column');

/** Widgets offered per field kind — the runtime ignores anything else. */
export const WIDGETS: Record<string, string[]> = {
  column: ['text', 'textarea', 'markdown', 'number', 'checkbox', 'select', 'radio', 'date', 'datetime', 'json', 'tags'],
  relation: ['select', 'radio', 'autocomplete'],
  m2m: ['checkboxes', 'multiselect', 'tags'],
};

/**
 * Turn the editor's working state back into a definition to save.
 *
 * Merges onto `d.source` so keys the editor has no control for survive — see the
 * note on `Draft.source`. An empty string in a text box is a real edit meaning
 * "unset", so those keys are deleted rather than left at their loaded value.
 */
export function draftToDefinition(d: Draft): ViewDefinition {
  const def: ViewDefinition = { ...d.source, table: d.table };

  const text = (v: string, key: 'title' | 'description' | 'display') => {
    const trimmed = v.trim();
    if (trimmed) def[key] = trimmed;
    else delete def[key];
  };
  text(d.title, 'title');
  text(d.description, 'description');
  text(d.display, 'display');

  def.fields = d.fields.filter((f) => f.include).map((f) => f.field);

  const included = new Set(def.fields.map(fieldKeyOf));
  const list = {
    ...(d.source.list ?? {}),
    columns: d.listColumns.filter((c) => included.has(c)),
    pageSize: d.pageSize,
    searchColumns: d.searchColumns.filter((c) => included.has(c)),
  };
  // A sort or filter naming a field that has just been removed would resolve to
  // a warning on every render, so drop those the same way list.columns are.
  if (list.sort && !included.has(list.sort.column)) delete list.sort;

  // `related` is modelled by the editor now, so the editor owns it: an empty set
  // means the key is gone, not that a previous value should be carried over.
  const related = d.related ?? [];
  if (related.length) def.related = related;
  else delete def.related;

  const editorKeysEmpty = !list.columns.length && !list.searchColumns.length && list.pageSize === 25;
  const carriedKeys = Object.keys(list).filter((k) => !['columns', 'pageSize', 'searchColumns'].includes(k));
  if (editorKeysEmpty && !carriedKeys.length) delete def.list;
  else def.list = list;

  return def;
}
