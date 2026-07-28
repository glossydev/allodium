/**
 * @allodium/admin — the two-lane admin kit.
 *
 * Thesis: your Drizzle schema already knows every table, column type, relation, and
 * secret. An admin surface should be GENERATED from that — never defined again in a
 * second config language that can drift.
 *
 * 0.1.x ships the foundation, extracted from the reference deployment's developer
 * console: the schema-driven table registry (runtime metadata + FK graph + secret-column
 * masking). The generated-UI lane — list views, detail forms, relation pickers on top of
 * this registry — is the package's second half and lands in a later minor.
 */

export {
  createTableRegistry,
  type TableRegistry,
  type RegisteredTable,
  type RegistryColumn,
} from './registry.js';
