/**
 * Directus roles + policies + permissions → Allodium's `roles` and `role_permissions`.
 *
 * The models differ in one way that matters: Directus attaches policies (bags of
 * permissions, each with its own filter per action) to roles; Allodium has one row
 * per role × table with four flags and ONE row filter. So:
 *
 *   - a role's policies are unioned (that is what Directus does at request time);
 *   - a permission with an empty filter beats a filtered one for the same action;
 *   - two different filters for the same table × action within a role are an OR,
 *     which one role_permissions row cannot state (unique on role × table) — the
 *     grant is LEFT OUT and reported. Auth unions grants ACROSS roles, so the
 *     remedy is to split the role, not to pick a filter;
 *   - when the actions on a table carry different filters, the grant takes the read
 *     filter and reports the others, because a flag without a filter would widen reach.
 *
 * The output is fail-closed by construction: nothing is granted that Directus did not
 * grant, and anything that could not be translated exactly is omitted and listed.
 */
import { translateFilter, UntranslatableFilter } from './filters.js';
import type { GrantRow, GrantsPlan, Inventory, Permission, Predicate } from './types.js';

export interface GrantsPlanOptions {
  /** Key for the anonymous role. Default `public` (the key `@allodium/auth`'s grant loader expects). */
  publicRoleKey?: string;
  /** Override role keys by Directus role name, e.g. `{ 'Content Editor': 'editor' }`. */
  roleKeys?: Record<string, string>;
  /** Table renames to apply (directus_users → users, directus_files → files, plus your own). */
  tableNames?: Record<string, string>;
  /** Table whose grants the plan should skip (Directus system collections are skipped regardless). */
  skipTables?: string[];
}

const ACTIONS = ['create', 'read', 'update', 'delete'] as const;
type Action = (typeof ACTIONS)[number];

export function slugifyRole(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bpolicy\b|\brole\b/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'role';
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function planGrants(inv: Inventory, opts: GrantsPlanOptions = {}): GrantsPlan {
  const publicKey = opts.publicRoleKey ?? 'public';
  const rename: Record<string, string> = { directus_users: 'users', directus_files: 'files', ...(opts.tableNames ?? {}) };
  const skip = new Set(opts.skipTables ?? []);
  const policyById = new Map(inv.policies.map((p) => [p.id, p]));
  const notes: string[] = [];
  const unexpressible: GrantsPlan['unexpressible'] = [];
  const roles: GrantsPlan['roles'] = [];
  const grants: GrantRow[] = [];
  const usedKeys = new Set<string>();

  const fkColumns = new Set(inv.relations.filter((r) => r.references).map((r) => `${r.table}.${r.column}`));
  const tables = new Set(inv.collections.filter((c) => c.kind === 'table').map((c) => c.name));

  const subjects: { key: string; label: string; description: string | null; directusRoleId: string | null; policyIds: string[] }[] = [];
  if (inv.publicPolicyIds.length) subjects.push({ key: publicKey, label: 'Public', description: 'Anonymous visitors. Anything granted here is readable by the whole internet.', directusRoleId: null, policyIds: inv.publicPolicyIds });
  for (const r of inv.roles) {
    let key = opts.roleKeys?.[r.name] ?? slugifyRole(r.name);
    if (key === publicKey && inv.publicPolicyIds.length) key = `${key}_role`;
    while (usedKeys.has(key)) key = `${key}_`;
    usedKeys.add(key);
    subjects.push({ key, label: r.name, description: r.description, directusRoleId: r.id, policyIds: r.policyIds });
  }

  for (const s of subjects) {
    const policies = s.policyIds.map((id) => policyById.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    const admin = policies.some((p) => p.adminAccess);
    roles.push({ key: s.key, label: s.label, description: s.description, admin, directusRoleId: s.directusRoleId });
    if (admin) {
      notes.push(`role "${s.label}" had admin access: it bypassed permissions entirely. The plan writes NO grants for it — map its ${inv.roles.find((r) => r.id === s.directusRoleId)?.userCount ?? 0} user(s) onto your console-lane role instead.`);
      continue;
    }
    if (!policies.length) {
      notes.push(`role "${s.label}" has no policies — it grants nothing, so no rows are written`);
      continue;
    }

    // table → action → list of candidate filters (one per permission row across the role's policies)
    const byTable = new Map<string, Map<Action, Permission[]>>();
    for (const p of policies) {
      for (const perm of p.permissions) {
        if (perm.collection.startsWith('directus_') || skip.has(perm.collection)) continue;
        if (!(ACTIONS as readonly string[]).includes(perm.action)) continue;
        if (!tables.has(perm.collection)) {
          notes.push(`${s.key}: permission on "${perm.collection}", which is not a table — skipped`);
          continue;
        }
        const m = byTable.get(perm.collection) ?? new Map<Action, Permission[]>();
        m.set(perm.action as Action, [...(m.get(perm.action as Action) ?? []), perm]);
        byTable.set(perm.collection, m);
      }
    }

    for (const [table, actions] of byTable) {
      const perAction: Partial<Record<Action, Predicate[] | null>> = {};
      const flags: Record<Action, boolean> = { create: false, read: false, update: false, delete: false };
      for (const action of ACTIONS) {
        const perms = actions.get(action);
        if (!perms) continue;
        const restricted = perms.filter((p) => p.fields && !p.fields.includes('*'));
        if (restricted.length) notes.push(`${s.key} ${action} ${table}: Directus limited the FIELDS (${restricted.map((p) => p.fields!.join('/')).join('; ')}) — Allodium grants are per table; hide columns through the view and masking`);
        if (perms.some((p) => p.validation && Object.keys(p.validation).length)) notes.push(`${s.key} ${action} ${table}: had a validation rule — restate it as a database constraint`);
        if (perms.some((p) => p.presets && Object.keys(p.presets).length)) notes.push(`${s.key} ${action} ${table}: had presets (default values on create) — restate them as column defaults`);

        // Empty filter wins; otherwise exactly one filter; otherwise it is an OR.
        if (perms.some((p) => !p.filter || Object.keys(p.filter).length === 0)) {
          perAction[action] = null;
          flags[action] = true;
          continue;
        }
        const distinct = [...new Map(perms.map((p) => [JSON.stringify(p.filter), p.filter])).values()];
        if (distinct.length > 1) {
          unexpressible.push({ roleKey: s.key, table, action, reason: `${distinct.length} policies grant ${action} with different filters — one grant row cannot state their OR; split the role (grants union across the roles a person holds) or merge the policies`, filter: distinct });
          continue;
        }
        try {
          const predicates = translateFilter(distinct[0]);
          for (const pr of predicates) checkPath(table, pr.column, fkColumns, tables, inv);
          perAction[action] = predicates;
          flags[action] = true;
        } catch (e) {
          const reason = e instanceof UntranslatableFilter ? `${e.message} (at ${e.at})` : e instanceof Error ? e.message : String(e);
          unexpressible.push({ roleKey: s.key, table, action, reason, filter: distinct[0] });
        }
      }
      if (!Object.values(flags).some(Boolean)) continue;

      // One filter per grant. Every granted action must be at least as restricted as
      // Directus had it, so pick the read filter and refuse any action whose own
      // filter was tighter, unless they are identical.
      const granted = ACTIONS.filter((a) => flags[a]);
      const filters = new Map(granted.map((a) => [a, JSON.stringify(perAction[a] ?? null)]));
      const distinctFilters = new Set(filters.values());
      let rowFilter: Predicate[] | null = perAction.read ?? null;
      if (distinctFilters.size > 1) {
        // Prefer the most restrictive representable choice: the read filter if read is granted,
        // and drop any action whose filter differs from it (a looser grant would widen reach).
        const chosen = flags.read ? filters.get('read')! : [...distinctFilters].find((f) => f !== 'null') ?? 'null';
        rowFilter = JSON.parse(chosen) as Predicate[] | null;
        for (const a of granted) {
          if (filters.get(a) !== chosen) {
            if (perAction[a] === null && rowFilter) {
              // Unfiltered action under a filtered read: granting it under the read filter only narrows it. Keep.
              notes.push(`${s.key} ${a} ${table}: Directus allowed every row; the grant narrows it to the read filter`);
              continue;
            }
            flags[a] = false;
            unexpressible.push({ roleKey: s.key, table, action: a, reason: 'this action had a different row filter from read; one grant carries one filter — split the role or align the filters', filter: perAction[a] });
          }
        }
      }
      const row: GrantRow = { roleKey: s.key, table: rename[table] ?? table, create: flags.create, read: flags.read, update: flags.update, delete: flags.delete, rowFilter };
      if (distinctFilters.size > 1) row.perAction = perAction;
      if (Object.values(flags).some(Boolean)) grants.push(row);
    }
  }

  // SQL: roles then grants, idempotent.
  const lines: string[] = ['begin;', ''];
  lines.push('-- Roles. rank: lower is more privileged; public is ranked last on purpose.');
  let rank = 100;
  for (const r of roles) {
    if (r.admin) continue;
    const rk = r.key === publicKey ? 1000 : (rank += 10);
    lines.push(`insert into roles (key, label, description, rank) values (${sqlString(r.key)}, ${sqlString(r.label)}, ${r.description ? sqlString(r.description) : 'null'}, ${rk})`);
    lines.push(`  on conflict (key) do update set label = excluded.label, description = coalesce(excluded.description, roles.description);`);
  }
  lines.push('', '-- Grants: one row per role x table. row_filter null means every row.');
  for (const g of grants) {
    const rf = g.rowFilter && g.rowFilter.length ? `${sqlString(JSON.stringify(g.rowFilter))}::jsonb` : 'null';
    lines.push(`insert into role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete, row_filter)`);
    lines.push(`  select id, ${sqlString(g.table)}, ${g.create}, ${g.read}, ${g.update}, ${g.delete}, ${rf} from roles where key = ${sqlString(g.roleKey)}`);
    lines.push(`  on conflict (role_id, table_name) do update set can_create = excluded.can_create, can_read = excluded.can_read, can_update = excluded.can_update, can_delete = excluded.can_delete, row_filter = excluded.row_filter;`);
  }
  if (unexpressible.length) {
    lines.push('', `-- ${unexpressible.length} permission(s) were NOT translated (fail closed). Decide each one:`);
    for (const u of unexpressible) lines.push(`--   ${u.roleKey} ${u.action} ${u.table}: ${u.reason}`);
  }
  lines.push('', 'commit;', '');

  return { roles, grants, unexpressible, sql: lines.join('\n'), notes };
}

/** A predicate column may be a plain column or an FK path; alias fields cannot be walked. */
function checkPath(table: string, column: string, fkColumns: Set<string>, tables: Set<string>, inv: Inventory): void {
  const parts = column.split('.');
  let t = table;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    const coll = inv.collections.find((c) => c.name === t);
    const field = coll?.fields.find((f) => f.name === part);
    if (!field) throw new UntranslatableFilter(`"${part}" is not a column of ${t}`, column);
    if (last) {
      if (!field.sqlType) throw new UntranslatableFilter(`"${part}" on ${t} is an alias field, not a column`, column);
      return;
    }
    if (!fkColumns.has(`${t}.${part}`)) throw new UntranslatableFilter(`"${part}" on ${t} is not a foreign key, so the path cannot be walked (o2m/m2m hops are not expressible)`, column);
    const rel = inv.relations.find((r) => r.table === t && r.column === part);
    t = rel?.references ?? '';
    if (t === 'directus_users') t = 'users';
    if (t === 'directus_files') t = 'files';
    if (!tables.has(t) && t !== 'users' && t !== 'files') throw new UntranslatableFilter(`path leaves the known tables at "${part}"`, column);
    if (t === 'users' || t === 'files') {
      // The adopted system tables: accept the remaining hop as a column we cannot check here.
      return;
    }
  }
}
