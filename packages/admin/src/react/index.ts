/**
 * @allodium/admin/react — the two client layers.
 *
 * Layer 2 (hooks) is all data and behavior with no markup. Layer 3 (components) is
 * correct, accessible, entirely unstyled markup built on those hooks. Enter at
 * whichever level a screen needs; they are the same system, not alternatives.
 */

export { useAdminView, useAdminList, useAdminForm, uploadFile, type AdminClientConfig, type UseAdminListResult, type UseAdminFormResult } from './hooks.js';
export { AdminForm, AdminList, AdminRelated } from './components.js';
export type { ResolvedView, ResolvedField, ResolvedRelated } from '../server/resolver.js';
