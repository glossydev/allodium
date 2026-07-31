import 'server-only';
import { createViewResolver } from '@allodium/admin/server';
import { getDb } from './db';

/**
 * The console mounts the admin runtime so a definition can be previewed against
 * real data while you author it — the build lane rendering the run lane.
 *
 * A deployed dashboard mounts exactly this same resolver; nothing here is
 * console-specific, which is the point. If the preview works, the dashboard works.
 */
export function getViewResolver() {
  const g = globalThis as { __allodiumViewResolver?: ReturnType<typeof createViewResolver> };
  g.__allodiumViewResolver ??= createViewResolver(getDb().pool);
  return g.__allodiumViewResolver;
}
