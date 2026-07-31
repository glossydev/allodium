/** Client-side view of the catalog (the /api/catalog JSON shapes). */

export interface ClientColumn {
  name: string;
  type: string;
  udtName: string;
  family: 'string' | 'number' | 'boolean' | 'json' | 'date' | 'datetime' | 'uuid' | 'enum' | 'array';
  nullable: boolean;
  default: string | null;
  isPk: boolean;
  masked: boolean;
  enumValues?: string[];
  fkTable?: string;
  fkColumn?: string;
  /** COMMENT ON COLUMN — schema-level documentation, and the admin runtime's default help text. */
  comment: string | null;
}

export interface ClientTable {
  name: string;
  /** COMMENT ON TABLE — what this table is for. */
  comment: string | null;
  pk: string | null;
  pkColumns: string[];
  columns: ClientColumn[];
  foreignKeysOut: { column: string; refTable: string; refColumn: string }[];
  referencedBy: { table: string; column: string }[];
  indexes: { name: string; definition: string }[];
  sizeBytes: number;
  sizePretty: string;
}

export interface ClientCatalog {
  tables: ClientTable[];
  enums: Record<string, string[]>;
}

export type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'null' | 'notnull';

export interface UiFilter {
  col: string;
  op: FilterOp;
  val: string;
}

export const FILTER_OPS: { value: FilterOp; label: string; needsValue: boolean }[] = [
  { value: 'eq', label: '=', needsValue: true },
  { value: 'neq', label: '≠', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '≥', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '≤', needsValue: true },
  { value: 'null', label: 'is null', needsValue: false },
  { value: 'notnull', label: 'not null', needsValue: false },
];

/** Serialize a filter for the f= URL/API param (col:op:val — val may contain ':'). */
export const filterToParam = (f: UiFilter): string =>
  FILTER_OPS.find((o) => o.value === f.op)?.needsValue ? `${f.col}:${f.op}:${f.val}` : `${f.col}:${f.op}`;

export function paramToFilter(raw: string): UiFilter | null {
  const first = raw.indexOf(':');
  if (first < 0) return null;
  const col = raw.slice(0, first);
  const rest = raw.slice(first + 1);
  const second = rest.indexOf(':');
  const op = (second < 0 ? rest : rest.slice(0, second)) as FilterOp;
  if (!col || !FILTER_OPS.some((o) => o.value === op)) return null;
  return { col, op, val: second < 0 ? '' : rest.slice(second + 1) };
}

/** Pick the most label-like column of a table (for relation pickers). */
export function labelColumn(t: ClientTable): string | null {
  const preferred = ['name', 'label', 'title', 'email', 'filename', 'display_name', 'full_name', 'key', 'slug'];
  const visible = t.columns.filter((c) => !c.masked);
  for (const p of preferred) {
    const hit = visible.find((c) => c.name === p);
    if (hit) return hit.name;
  }
  return visible.find((c) => !c.isPk && (c.family === 'string' || c.family === 'enum'))?.name ?? null;
}
