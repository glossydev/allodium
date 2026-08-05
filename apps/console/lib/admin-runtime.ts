import 'server-only';
import { createViewResolver } from '@allodium/admin/server';
import { getDb } from './db';
import { maskPolicy } from './masking';

/**
 * The console mounts the admin runtime so a definition can be previewed against
 * real data while you author it — the build lane rendering the run lane.
 *
 * A deployed dashboard mounts exactly this same resolver; nothing here is
 * console-specific, which is the point. If the preview works, the dashboard works.
 */
export function getViewResolver() {
  const g = globalThis as { __allodiumViewResolver?: ReturnType<typeof createViewResolver> };
  // The same masking policy the rest of the console uses. Without this the admin
  // runtime would answer with a different idea of what is secret than the Content
  // silo two tabs away — and it is the runtime, not the console, that a deployed
  // dashboard will be running.
  g.__allodiumViewResolver ??= createViewResolver(getDb().pool, { masking: maskPolicy });
  return g.__allodiumViewResolver;
}
