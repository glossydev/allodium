import type { ViewDefinition, Field, ColumnField, RelationField, ManyToManyField } from '@allodium/admin/view';

export type { ViewDefinition, Field, ColumnField, RelationField, ManyToManyField };

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
  /**
   * The file on disk has no `fields` key, which the runtime reads as "every
   * visible column, including ones added later". Tracked so the editor can say
   * so — saving pins the list and that automatic behavior stops.
   */
  implicitFields: boolean;
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

/** Turn the editor's working state back into a definition to save. */
export function draftToDefinition(d: Draft): ViewDefinition {
  const def: ViewDefinition = {
    table: d.table,
    title: d.title.trim() || undefined,
    description: d.description.trim() || undefined,
    display: d.display.trim() || undefined,
    fields: d.fields.filter((f) => f.include).map((f) => f.field),
  };
  const included = new Set(def.fields!.map(fieldKeyOf));
  const list = {
    columns: d.listColumns.filter((c) => included.has(c)),
    pageSize: d.pageSize,
    searchColumns: d.searchColumns.filter((c) => included.has(c)),
  };
  if (list.columns.length || list.searchColumns.length || list.pageSize !== 25) def.list = list;
  return def;
}
