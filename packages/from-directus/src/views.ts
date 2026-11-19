/**
 * Inventory → `.view.json` drafts and `COMMENT ON` statements.
 *
 * The view contract carries only what a human decided. Directus kept most of those
 * decisions as field metadata — the interface someone picked, the choices they typed,
 * the note they wrote, the display template — and that is exactly what this recovers.
 * Everything derivable from the catalog (types, nullability, FK targets) is left out
 * on purpose; the admin reads it live.
 *
 * Notes go into the schema as comments, where every later tool finds them, and the
 * views do not restate them: the admin falls back to the column comment for help text.
 */
import type { Collection, Field, Inventory, Relation, ViewDraft, ViewsPlan } from './types.js';

export interface ViewsPlanOptions {
  /** What `directus_users` and `directus_files` will be called after the decommission. */
  usersTable?: string;
  filesTable?: string;
  /** Column of the users table to show for a user relation. Default `email`. */
  usersDisplay?: string;
  /** Column of the files table to show for a file relation. Default `filename`. */
  filesDisplay?: string;
  /** Directory the files are written to, used only for the `file` names in the plan. */
  viewsDir?: string;
}

const WIDGET_BY_INTERFACE: Record<string, string> = {
  input: 'text',
  'input-multiline': 'textarea',
  'input-rich-text-md': 'markdown',
  'input-rich-text-html': 'textarea',
  'input-block-editor': 'json',
  'input-code': 'textarea',
  'input-hash': 'text',
  'input-autocomplete-api': 'text',
  slider: 'number',
  boolean: 'checkbox',
  toggle: 'checkbox',
  'select-dropdown': 'select',
  'select-radio': 'radio',
  'select-multiple-dropdown': 'tags',
  'select-multiple-checkbox': 'tags',
  tags: 'tags',
  datetime: 'datetime',
  'select-color': 'text',
  'select-icon': 'text',
  'input-json': 'json',
  map: 'json',
};

const RELATION_WIDGET_BY_INTERFACE: Record<string, string> = {
  'select-dropdown-m2o': 'select',
  'select-radio': 'radio',
  'list-m2o': 'autocomplete',
  'select-dropdown': 'select',
};

/** Columns Directus maintained for its own bookkeeping; the admin should show them read-only. */
const BOOKKEEPING = new Set(['date-created', 'date-updated', 'user-created', 'user-updated', 'uuid', 'sort']);

const humanize = (name: string) =>
  name
    .replace(/_id$/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

export function planViews(inv: Inventory, opts: ViewsPlanOptions = {}): ViewsPlan {
  const usersTable = opts.usersTable ?? 'users';
  const filesTable = opts.filesTable ?? 'files';
  const usersDisplay = opts.usersDisplay ?? 'email';
  const filesDisplay = opts.filesDisplay ?? 'filename';
  const dir = (opts.viewsDir ?? 'admin/views').replace(/\/+$/, '');
  const notes: string[] = [];
  const comments: string[] = [];

  const targetName = (t: string | null) => (t === 'directus_users' ? usersTable : t === 'directus_files' ? filesTable : t);
  const byName = new Map(inv.collections.map((c) => [c.name, c]));
  const displayOf = (table: string | null): string | undefined => {
    if (!table) return undefined;
    if (table === 'directus_users') return usersDisplay;
    if (table === 'directus_files') return filesDisplay;
    return byName.get(table)?.display ?? undefined;
  };

  const views: ViewsPlan['views'] = [];
  for (const c of inv.collections) {
    if (c.kind !== 'table') continue;
    if (c.note) comments.push(`comment on table ${ident(c.name)} is ${sqlString(c.note)};`);
    for (const f of c.fields) if (f.note && f.sqlType) comments.push(`comment on column ${ident(c.name)}.${ident(f.name)} is ${sqlString(f.note)};`);

    // A junction table is edited through the m2m field on its owners, not on its own.
    const isJunction = inv.relations.some((r) => r.table === c.name && r.junctionPartner);
    if (isJunction) {
      notes.push(`${c.name}: a junction table; no view of its own (its owners get an m2m field)`);
      continue;
    }

    const fields: Record<string, unknown>[] = [];
    const listColumns: string[] = [];
    const related: Record<string, unknown>[] = [];
    for (const f of c.fields) {
      if (f.isPrimaryKey) continue;
      const rel = inv.relations.find((r) => r.table === c.name && r.column === f.name);
      const special = new Set(f.special);

      if (special.has('o2m') || (special.has('m2m') && !f.sqlType) || (!f.sqlType && special.has('files'))) {
        if (special.has('m2m')) {
          const m2m = m2mFor(inv, c.name, f.name);
          if (m2m) {
            fields.push(prune({
              kind: 'm2m',
              name: f.name,
              label: humanize(f.name),
              through: m2m.through,
              near: m2m.near,
              far: m2m.far,
              farTable: targetName(m2m.farTable),
              display: displayOf(m2m.farTable),
              widget: 'multiselect',
              in: ['form'],
              help: undefined,
            }));
          } else notes.push(`${c.name}.${f.name}: m2m alias whose junction could not be resolved — add it by hand`);
          continue;
        }
        // o2m (and the `files` multi-file alias, which is an o2m onto a junction): a related list.
        const inbound = inv.relations.find((r) => r.references === c.name && r.inboundField === f.name);
        if (inbound) related.push(prune({ table: inbound.table, foreignKey: inbound.column, title: humanize(f.name) }));
        else notes.push(`${c.name}.${f.name}: o2m alias with no matching relation row — skipped`);
        continue;
      }
      if (!f.sqlType) {
        if (f.interface && !['presentation-divider', 'presentation-notice', 'presentation-links', 'group-raw', 'group-detail', 'group-accordion'].includes(f.interface)) {
          notes.push(`${c.name}.${f.name}: alias field (${f.interface}) with no column — skipped`);
        }
        continue;
      }
      if (f.hidden && !rel) continue; // hidden scalar: the admin has no role for it

      const common: Record<string, unknown> = {
        label: humanize(f.name),
        readOnly: f.readonly || [...special].some((s) => BOOKKEEPING.has(s)) ? true : undefined,
        required: f.required ? true : undefined,
      };
      if (rel) {
        const target = targetName(rel.references);
        const isFile = rel.references === 'directus_files' || special.has('file');
        const widget = isFile ? 'file' : RELATION_WIDGET_BY_INTERFACE[f.interface ?? ''] ?? 'select';
        const localDisplay = templateOf(f.displayOptions);
        fields.push(prune({
          kind: 'relation',
          column: f.name,
          ...common,
          relation: prune({ table: target, display: localDisplay ?? (isFile ? filesDisplay : rel.references === 'directus_users' ? usersDisplay : undefined) }),
          widget,
          in: f.hidden ? ['form'] : undefined,
        }));
        if (!f.hidden && listColumns.length < 6) listColumns.push(f.name);
        continue;
      }
      const choices = choicesOf(f);
      const widget = widgetFor(f, !!choices);
      fields.push(prune({
        column: f.name,
        ...common,
        widget,
        options: choices,
        filterable: f.sqlType === 'json' || f.sqlType === 'jsonb' || f.sqlType === 'text' && widget === 'markdown' ? false : undefined,
      }));
      if (listColumns.length < 6 && !['text', 'json', 'jsonb'].includes(f.sqlType) && widget !== 'markdown' && widget !== 'textarea') listColumns.push(f.name);
    }

    const list: Record<string, unknown> = {};
    if (listColumns.length) list.columns = listColumns;
    if (c.sortField) list.sort = { column: c.sortField, direction: 'asc' };
    else if (c.primaryKey) list.sort = { column: c.primaryKey, direction: 'desc' };
    const searchable = c.fields
      .filter((f) => f.sqlType && /char|text/.test(f.sqlType) && !f.hidden && !choicesOf(f) && !inv.relations.some((r) => r.table === c.name && r.column === f.name))
      .map((f) => f.name)
      .slice(0, 4);
    if (searchable.length) list.searchColumns = searchable;
    if (c.archiveField && c.archiveValue) {
      notes.push(`${c.name}: Directus archived rows where ${c.archiveField} = ${JSON.stringify(c.archiveValue)}; the draft adds no baseline filter so archived rows stay reachable — add one if you want them hidden`);
    }

    const definition: ViewDraft = prune({
      $schema: 'https://unpkg.com/@allodium/admin/view.schema.json',
      table: c.name,
      title: humanize(c.name),
      description: c.note ?? undefined,
      display: c.display ?? undefined,
      fields,
      list: Object.keys(list).length ? list : undefined,
      related: related.length ? related : undefined,
    }) as ViewDraft;
    views.push({ file: `${dir}/${c.name}.view.json`, definition });
    if (c.singleton) notes.push(`${c.name}: a singleton in Directus — the view is an ordinary table screen; pin the one row with a baseline filter if you like`);
  }

  // Views for the adopted system tables so relations to them resolve a display.
  views.push({
    file: `${dir}/${usersTable}.view.json`,
    definition: { $schema: 'https://unpkg.com/@allodium/admin/view.schema.json', table: usersTable, title: 'Users', display: usersDisplay, fields: [{ column: 'email' }, { column: 'display_name' }, { column: 'status' }, { column: 'last_login_at', readOnly: true }] },
  });
  if (inv.files.total || inv.files.referencedBy.length) {
    views.push({
      file: `${dir}/${filesTable}.view.json`,
      definition: { $schema: 'https://unpkg.com/@allodium/admin/view.schema.json', table: filesTable, title: 'Files', display: filesDisplay, fields: [{ column: 'filename' }, { column: 'title' }, { column: 'mime_type', readOnly: true }, { column: 'filesize_bytes', readOnly: true }, { column: 'uploaded_at', readOnly: true }] },
    });
  }

  return { views, commentsSql: comments.join('\n') + (comments.length ? '\n' : ''), notes };
}

function m2mFor(inv: Inventory, table: string, aliasField: string): { through: string; near: string; far: string; farTable: string } | null {
  const near = inv.relations.find((r) => r.references === table && r.inboundField === aliasField && r.junctionPartner);
  if (!near) return null;
  const far = inv.relations.find((r) => r.table === near.table && r.column === near.junctionPartner);
  if (!far?.references) return null;
  return { through: near.table, near: near.column, far: far.column, farTable: far.references };
}

function choicesOf(f: Field): { value: string; label?: string }[] | undefined {
  const raw = f.options?.choices;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: { value: string; label?: string }[] = [];
  for (const c of raw) {
    if (c && typeof c === 'object' && 'value' in c) {
      const value = String((c as { value: unknown }).value);
      const text = (c as { text?: unknown }).text;
      out.push(typeof text === 'string' && text !== value ? { value, label: text } : { value });
    } else if (typeof c === 'string') out.push({ value: c });
  }
  return out.length ? out : undefined;
}

function widgetFor(f: Field, hasChoices: boolean): string | undefined {
  const t = f.sqlType ?? '';
  const byInterface = f.interface ? WIDGET_BY_INTERFACE[f.interface] : undefined;
  if (hasChoices) return f.interface === 'select-radio' ? 'radio' : t.endsWith('[]') || f.interface?.startsWith('select-multiple') ? 'tags' : 'select';
  // Directus's tags interface stores a JSON array; the admin's tags widget is for text[].
  if (byInterface === 'tags' && !t.endsWith('[]')) return /json/.test(t) ? 'json' : 'text';
  if (byInterface === 'datetime') return t === 'date' ? 'date' : 'datetime';
  if (byInterface === 'checkbox' && t !== 'boolean') return undefined;
  if (byInterface === 'text' || byInterface === undefined) return undefined; // let the admin default from the SQL type
  return byInterface;
}

function templateOf(displayOptions: Record<string, unknown> | null): string | undefined {
  const t = displayOptions?.template;
  if (typeof t !== 'string' || !t) return undefined;
  const converted = t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '{$1}');
  // A template that hops a relation ({topics_id.label}) is not one the admin can render; drop it.
  return /\{[^}]*\.[^}]*\}/.test(converted) ? undefined : converted;
}

/** Drop undefined values so the JSON reads as the operator would have written it. */
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export type { Collection, Relation };
