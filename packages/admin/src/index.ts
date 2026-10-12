/**
 * @allodium/admin — the two-lane admin kit.
 *
 * Thesis: your Drizzle schema already knows every table, column type, relation, and
 * secret. An admin surface should be GENERATED from that — never defined again in a
 * second config language that can drift.
 *
 * This root entry is the Drizzle-side foundation: the schema-driven table registry
 * (runtime metadata + FK graph + secret-column masking). The generated-UI lane —
 * the view format (`./view`), the resolver and route handlers (`./server`), and the
 * React hooks and components (`./react`) — ships from 0.2 on under its own entry
 * points, so a project that only wants the registry imports only the registry.
 */

export {
  createTableRegistry,
  type TableRegistry,
  type RegisteredTable,
  type RegistryColumn,
} from './registry.js';
