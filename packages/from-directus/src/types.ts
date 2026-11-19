/**
 * The inventory — everything the migrator reads out of a Directus database before
 * it proposes anything.
 *
 * Every shape here is a plain-data snapshot of the `directus_*` system tables plus
 * the catalog: the planners downstream work from this object alone, so an inventory
 * can be saved as JSON, diffed between runs, and reviewed by a human or an agent
 * before any SQL is generated.
 */

/** The minimal database handle: node-postgres's `Pool`/`Client` shape, or anything with the same `query`. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** One of your collections — a table Directus managed, with the metadata it kept beside it. */
export interface Collection {
  name: string;
  /** `table` has a real table behind it; `folder` is a grouping node in the Directus sidebar with no storage. */
  kind: 'table' | 'folder';
  note: string | null;
  /** Directus `{{col}}` template, converted to the `{col}` form the admin's `display` uses. */
  display: string | null;
  archiveField: string | null;
  archiveValue: string | null;
  sortField: string | null;
  singleton: boolean;
  hidden: boolean;
  primaryKey: string | null;
  fields: Field[];
}

export interface Field {
  name: string;
  /** Column type from the catalog; null for an alias field (m2m/o2m) that has no column. */
  sqlType: string | null;
  nullable: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
  /** Directus `special` flags: m2o, o2m, m2m, file, files, cast-json, uuid, date-created, user-created… */
  special: string[];
  interface: string | null;
  /** The `interface`'s options; `choices` is the one the planners read. */
  options: Record<string, unknown> | null;
  display: string | null;
  displayOptions: Record<string, unknown> | null;
  note: string | null;
  required: boolean;
  hidden: boolean;
  readonly: boolean;
  /** True when the catalog has the column but `directus_fields` had no row for it. */
  metadataMissing: boolean;
}

/** `directus_relations`, one row per FK or alias, verbatim but with the Directus naming decoded. */
export interface Relation {
  /** The table holding the foreign key (Directus: many_collection). */
  table: string;
  /** The FK column (many_field). */
  column: string;
  /** The referenced table (one_collection); null for a many-to-any relation. */
  references: string | null;
  /** Alias field on the referenced table that shows the inbound rows (one_field), if any. */
  inboundField: string | null;
  /** On a junction table: the OTHER FK column of the pair (junction_field). Present only for m2m. */
  junctionPartner: string | null;
  /** For many-to-any: the collections the row may point at. */
  anyCollections: string[] | null;
}

export interface Policy {
  id: string;
  name: string;
  adminAccess: boolean;
  appAccess: boolean;
  permissions: Permission[];
}

export interface Permission {
  collection: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'share' | string;
  /** The Directus filter object; `{}` or null means every row. */
  filter: Record<string, unknown> | null;
  /** Field allow-list; `['*']` means every field. */
  fields: string[] | null;
  validation: Record<string, unknown> | null;
  presets: Record<string, unknown> | null;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  parent: string | null;
  policyIds: string[];
  userCount: number;
}

export interface Flow {
  id: string;
  name: string;
  status: string;
  trigger: string | null;
  options: Record<string, unknown> | null;
  operations: { key: string; name: string | null; type: string; options: Record<string, unknown> | null }[];
}

export interface Inventory {
  /** When the inventory was taken, ISO 8601. */
  takenAt: string;
  /** Directus schema version markers: latest migration name, so a later run can tell the instance moved. */
  directus: {
    lastMigration: string | null;
    systemTables: string[];
    /** FK edges between system tables (child → parent), so the decommission can order its drops from the real graph. */
    systemDependencies: { table: string; references: string }[];
  };
  collections: Collection[];
  relations: Relation[];
  roles: Role[];
  policies: Policy[];
  /** Policies attached directly to a user (`directus_access.user`) rather than through a role. */
  userPolicies: { userId: string; policyId: string }[];
  /** The policy attached to the anonymous row of `directus_access` (no role, no user). */
  publicPolicyIds: string[];
  flows: Flow[];
  users: {
    total: number;
    byStatus: Record<string, number>;
    byProvider: Record<string, number>;
    /** Rows whose password column holds an argon2 hash — the ones that port without a reset. */
    withArgon2Hash: number;
    /** Rows with a password that is NOT argon2 (should be zero on any Directus >= 9). */
    withOtherHash: number;
    withoutPassword: number;
    withMfa: number;
  };
  files: {
    total: number;
    byStorage: Record<string, number>;
    totalBytes: number;
    /** FK columns on your tables that reference directus_files. */
    referencedBy: { table: string; column: string }[];
  };
  /** Things worth a human's attention before planning. */
  warnings: string[];
}

/* ------------------------------ plans ------------------------------ */

/** A `.view.json` draft — the admin's view contract, as data. Validate with `@allodium/admin/view`. */
export type ViewDraft = Record<string, unknown> & { table: string };

export interface ViewsPlan {
  views: { file: string; definition: ViewDraft }[];
  /** `COMMENT ON` statements carrying field and collection notes into the schema. */
  commentsSql: string;
  notes: string[];
}

/** Allodium's row-filter predicate (the shape `role_permissions.row_filter` stores). */
export interface Predicate {
  column: string;
  op?: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'startsWith' | 'endsWith' | 'in' | 'isNull' | 'notNull';
  value?: string | number | boolean | null | (string | number | boolean | null)[];
}

export interface GrantRow {
  roleKey: string;
  table: string;
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
  /** Null means every row. Per action in Directus; Allodium has one filter per grant, so see `perAction`. */
  rowFilter: Predicate[] | null;
  /** The per-action filters Directus had, when they differ — the reviewer decides. */
  perAction?: Partial<Record<'create' | 'read' | 'update' | 'delete', Predicate[] | null>>;
}

export interface GrantsPlan {
  roles: { key: string; label: string; description: string | null; admin: boolean; directusRoleId: string | null }[];
  grants: GrantRow[];
  /** Permissions that could not be expressed and were left OUT (fail closed) — each needs a decision. */
  unexpressible: { roleKey: string; table: string; action: string; reason: string; filter: unknown }[];
  /** `insert … on conflict` statements for roles and role_permissions. */
  sql: string;
  notes: string[];
}

export interface DecommissionPlan {
  /** One transaction: renames, column maps, role rows, explicit drops. Review before running. */
  sql: string;
  /** Tables the transaction drops, explicitly — never a blind cascade. */
  drops: string[];
  notes: string[];
}

export interface FileManifestEntry {
  id: string;
  storage: string;
  diskName: string | null;
  filename: string;
  mimeType: string | null;
  bytes: number | null;
}
