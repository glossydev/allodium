/**
 * Read a Directus database into an Inventory. Reads only: nothing here writes.
 *
 * Two sources are merged for every collection: the Postgres catalog (what the table
 * actually is) and `directus_fields` (what Directus remembered about it: notes,
 * choices, interfaces, specials). Either side can be missing a column the other
 * has — a column added by hand never gets a metadata row, and an alias field
 * (m2m/o2m) has no column — so the merge is a union, flagged where one side is empty.
 */
import type { Collection, Field, Flow, Inventory, Permission, Policy, Queryable, Relation, Role } from './types.js';

type Row = Record<string, unknown>;

const SYSTEM_PREFIX = 'directus_';

async function rows<T extends Row = Row>(db: Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  const res = await db.query(text, values);
  return res.rows as T[];
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => v === true || v === 't' || v === 1;
const json = (v: unknown): Record<string, unknown> | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : null;
};
const csv = (v: unknown): string[] =>
  typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? v.map(String) : [];

/** Directus `{{col}}` template → the admin's `{col}` form. */
export function convertDisplayTemplate(t: string | null | undefined): string | null {
  if (!t) return null;
  return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '{$1}');
}

export async function inspect(db: Queryable, opts: { schema?: string } = {}): Promise<Inventory> {
  const schema = opts.schema ?? 'public';
  const warnings: string[] = [];

  const tables = (await rows<{ table_name: string }>(db, `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`, [schema])).map((r) => r.table_name);
  const systemTables = tables.filter((t) => t.startsWith(SYSTEM_PREFIX));
  const userTables = tables.filter((t) => !t.startsWith(SYSTEM_PREFIX));
  if (!systemTables.includes('directus_fields')) {
    throw new Error(`no directus_fields table in schema "${schema}" — is this a Directus database?`);
  }

  const systemDependencies = (
    await rows<{ table_name: string; refs: string }>(
      db,
      `select distinct tc.table_name, ccu.table_name as refs
         from information_schema.table_constraints tc
         join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1
          and tc.table_name like 'directus\\_%' and ccu.table_name like 'directus\\_%' and tc.table_name <> ccu.table_name
        order by 1, 2`,
      [schema],
    )
  ).map((r) => ({ table: r.table_name, references: r.refs }));

  const lastMigration = str((await rows(db, `select version from directus_migrations order by timestamp desc nulls last, version desc limit 1`).catch(() => [] as Row[]))[0]?.version);

  // Catalog columns for every user table.
  const columns = await rows<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }>(
    db,
    `select table_name, column_name, data_type, udt_name, is_nullable, column_default
       from information_schema.columns where table_schema = $1 order by table_name, ordinal_position`,
    [schema],
  );
  const pks = await rows<{ table_name: string; column_name: string }>(
    db,
    `select tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      where tc.table_schema = $1 and tc.constraint_type = 'PRIMARY KEY'`,
    [schema],
  );
  const pkOf = new Map<string, string[]>();
  for (const p of pks) pkOf.set(p.table_name, [...(pkOf.get(p.table_name) ?? []), p.column_name]);

  const collectionRows = await rows(db, `select collection, note, display_template, archive_field, archive_value, sort_field, singleton, hidden from directus_collections order by collection`);
  const fieldRows = await rows(db, `select collection, field, special, interface, options, display, display_options, readonly, hidden, sort, note, required from directus_fields order by collection, sort nulls last, id`);

  const names = new Set<string>([...userTables, ...collectionRows.map((r) => String(r.collection)).filter((c) => !c.startsWith(SYSTEM_PREFIX))]);
  const collections: Collection[] = [];
  for (const name of [...names].sort()) {
    const meta = collectionRows.find((r) => r.collection === name);
    const hasTable = userTables.includes(name);
    if (!meta && hasTable) warnings.push(`table "${name}" has no directus_collections row — it was created outside Directus, or Directus never saw it`);
    const cols = columns.filter((c) => c.table_name === name);
    const metas = fieldRows.filter((r) => r.collection === name);
    const pk = pkOf.get(name) ?? [];
    if (hasTable && pk.length !== 1) warnings.push(`table "${name}" has ${pk.length === 0 ? 'no' : 'a composite'} primary key — the admin's view contract wants one column`);

    const fields: Field[] = [];
    const seen = new Set<string>();
    const build = (colName: string, col: (typeof cols)[number] | undefined, m: Row | undefined): Field => ({
      name: colName,
      sqlType: col ? (col.data_type === 'USER-DEFINED' || col.data_type === 'ARRAY' ? col.udt_name.replace(/^_/, '') + (col.data_type === 'ARRAY' ? '[]' : '') : col.data_type) : null,
      nullable: col ? col.is_nullable === 'YES' : true,
      hasDefault: !!col?.column_default,
      isPrimaryKey: pk.includes(colName),
      special: csv(m?.special),
      interface: str(m?.interface),
      options: json(m?.options),
      display: str(m?.display),
      displayOptions: json(m?.display_options),
      note: str(m?.note),
      required: bool(m?.required),
      hidden: bool(m?.hidden),
      readonly: bool(m?.readonly),
      metadataMissing: !!col && !m,
    });
    // Metadata order first (that is the order the Directus form showed), then catalog leftovers.
    for (const m of metas) {
      const f = String(m.field);
      seen.add(f);
      fields.push(build(f, cols.find((c) => c.column_name === f), m));
    }
    for (const c of cols) {
      if (seen.has(c.column_name)) continue;
      fields.push(build(c.column_name, c, undefined));
    }
    collections.push({
      name,
      kind: hasTable ? 'table' : 'folder',
      note: str(meta?.note),
      display: convertDisplayTemplate(str(meta?.display_template)),
      archiveField: str(meta?.archive_field),
      archiveValue: str(meta?.archive_value),
      sortField: str(meta?.sort_field),
      singleton: bool(meta?.singleton),
      hidden: bool(meta?.hidden),
      primaryKey: pk.length === 1 ? pk[0]! : null,
      fields,
    });
  }

  const relations: Relation[] = (await rows(db, `select many_collection, many_field, one_collection, one_field, junction_field, one_allowed_collections from directus_relations order by id`)).map((r) => ({
    table: String(r.many_collection),
    column: String(r.many_field),
    references: str(r.one_collection),
    inboundField: str(r.one_field),
    junctionPartner: str(r.junction_field),
    anyCollections: r.one_allowed_collections ? csv(r.one_allowed_collections) : null,
  }));
  for (const r of relations) {
    if (!r.references && r.anyCollections) warnings.push(`${r.table}.${r.column} is a many-to-any relation — there is no FK equivalent; it needs a design decision`);
  }

  // Roles, policies, permissions, access.
  const policyRows = await rows(db, `select id, name, admin_access, app_access from directus_policies order by name`);
  const permRows = await rows(db, `select collection, action, permissions, validation, presets, fields, policy from directus_permissions order by policy, collection, action`);
  const policies: Policy[] = policyRows.map((p) => ({
    id: String(p.id),
    name: String(p.name),
    adminAccess: bool(p.admin_access),
    appAccess: bool(p.app_access),
    permissions: permRows
      .filter((x) => x.policy === p.id)
      .map(
        (x): Permission => ({
          collection: String(x.collection),
          action: String(x.action),
          filter: json(x.permissions),
          fields: x.fields === null || x.fields === undefined ? null : csv(x.fields),
          validation: json(x.validation),
          presets: json(x.presets),
        }),
      ),
  }));
  const accessRows = await rows(db, `select role, "user", policy from directus_access order by sort nulls last, id`);
  const roleRows = await rows(db, `select r.id, r.name, r.description, r.parent, (select count(*) from directus_users u where u.role = r.id) as user_count from directus_roles r order by r.name`);
  const roles: Role[] = roleRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    description: str(r.description),
    parent: str(r.parent),
    policyIds: accessRows.filter((a) => a.role === r.id).map((a) => String(a.policy)),
    userCount: Number(r.user_count),
  }));
  const userPolicies = accessRows.filter((a) => a.user).map((a) => ({ userId: String(a.user), policyId: String(a.policy) }));
  const publicPolicyIds = accessRows.filter((a) => !a.role && !a.user).map((a) => String(a.policy));
  if (userPolicies.length) warnings.push(`${userPolicies.length} policy attachment(s) go directly to a user, not a role — Allodium grants are per role; give those users a role`);
  for (const r of roles) if (r.parent) warnings.push(`role "${r.name}" inherits from a parent role — flatten the inheritance into explicit grants`);

  const flowRows = await rows(db, `select id, name, status, trigger, options from directus_flows order by name`);
  const opRows = await rows(db, `select flow, key, name, type, options from directus_operations order by flow, position_y, position_x`);
  const flows: Flow[] = flowRows.map((f) => ({
    id: String(f.id),
    name: String(f.name),
    status: String(f.status),
    trigger: str(f.trigger),
    options: json(f.options),
    operations: opRows.filter((o) => o.flow === f.id).map((o) => ({ key: String(o.key), name: str(o.name), type: String(o.type), options: json(o.options) })),
  }));
  const active = flows.filter((f) => f.status === 'active');
  if (active.length) warnings.push(`${active.length} active flow(s) hold logic that lives outside the schema: ${active.map((f) => `"${f.name}"`).join(', ')} — each needs a home in code before the container stops`);

  const u = (await rows(db, `select count(*)::int as total,
       count(*) filter (where password like '$argon2%')::int as argon2,
       count(*) filter (where password is not null and password not like '$argon2%')::int as other,
       count(*) filter (where password is null)::int as none,
       count(*) filter (where tfa_secret is not null)::int as mfa
     from directus_users`))[0]!;
  const byStatus: Record<string, number> = {};
  for (const r of await rows(db, `select status, count(*)::int as n from directus_users group by status`)) byStatus[String(r.status)] = Number(r.n);
  const byProvider: Record<string, number> = {};
  for (const r of await rows(db, `select provider, count(*)::int as n from directus_users group by provider`)) byProvider[String(r.provider)] = Number(r.n);
  if (Number(u.other) > 0) warnings.push(`${u.other} user(s) carry a non-argon2 password hash — they will need a reset`);

  const f = (await rows(db, `select count(*)::int as total, coalesce(sum(filesize),0)::bigint as bytes from directus_files`))[0]!;
  const byStorage: Record<string, number> = {};
  for (const r of await rows(db, `select storage, count(*)::int as n from directus_files group by storage`)) byStorage[String(r.storage)] = Number(r.n);
  const referencedBy = relations.filter((r) => r.references === 'directus_files' && !r.table.startsWith(SYSTEM_PREFIX)).map((r) => ({ table: r.table, column: r.column }));
  for (const [storage, n] of Object.entries(byStorage)) if (storage !== 'local') warnings.push(`${n} file(s) live in the "${storage}" storage location — copy them from that bucket, not the uploads directory`);

  return {
    takenAt: new Date().toISOString(),
    directus: { lastMigration, systemTables, systemDependencies },
    collections,
    relations,
    roles,
    policies,
    userPolicies,
    publicPolicyIds,
    flows,
    users: { total: Number(u.total), byStatus, byProvider, withArgon2Hash: Number(u.argon2), withOtherHash: Number(u.other), withoutPassword: Number(u.none), withMfa: Number(u.mfa) },
    files: { total: Number(f.total), byStorage, totalBytes: Number(f.bytes), referencedBy },
    warnings,
  };
}
