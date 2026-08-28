/**
 * @allodium/admin/server — the runtime half that touches the database.
 *
 * Framework-free by design: it takes anything with a pg-shaped `query` method, so
 * it works with a pg Pool, a Client, or a proxy, in any HTTP framework. Mount the
 * handlers wherever your app puts routes; the package never assumes Next.js.
 */

export { createViewResolver, type ViewResolver, type ResolvedView, type ResolvedField, type ListResult } from './resolver.js';
export {
  createIntrospector,
  asJoinTable,
  qid,
  type Introspector,
  type Queryable,
  type TableMeta,
  type ColumnMeta,
} from './introspect.js';
export {
  createMaskPolicy,
  maskedInsertBlockers,
  MASK_PATTERN,
  type MaskPolicy,
  type MaskOptions,
  type MaskSpec,
} from './masking.js';
export {
  createFileViewStore,
  pickViewForTable,
  type ViewStore,
  type StoredView,
} from './views.js';
