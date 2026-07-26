/**
 * @allodium/admin — the headline module (planned; lands after the data/auth/storage kits
 * are battle-tested in production).
 *
 * Thesis: your Drizzle schema already knows every table, column type, relation, and enum.
 * A CMS admin should be GENERATED from that — list views, detail forms, relation pickers,
 * enum selects — rather than defined again in a second config language (the Directus/
 * Payload pattern this project exists to avoid). Bring-your-own UI shell; a react-admin
 * dataProvider adapter is the likely first renderer.
 */

export const ADMIN_PACKAGE_STATUS = 'planned' as const;

export function version(): string {
  return '0.0.1';
}
