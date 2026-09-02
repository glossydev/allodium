import type { NextRequest } from 'next/server';
import { createAdminRoutes, createFileViewStore } from '@allodium/admin/server';
import { getViewResolver } from '@/lib/admin-runtime';
import { viewsDir } from '@/lib/views';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/<view>/… — the admin runtime, served by the PACKAGE.
 *
 * This used to be five hand-written handlers, and a deployed dashboard would
 * have needed a sixth copy of each. Now the console mounts the same
 * createAdminRoutes a deployment mounts: if the preview works here, it works
 * there, because it is the same code — which was the point of the console
 * rendering the run lane in the first place.
 *
 * The console is 'unrestricted' by design (loopback-pinned, unauthenticated,
 * super_admin's lane), so the actor below is a label for the audit line, not a
 * gate. A deployment passes a real actorFor and a resolver built with a real
 * policy, and nothing else about this file changes.
 */

/** Who the console runs as. Named so the audit log says so, not so anything is checked. */
const CONSOLE_ACTOR = Object.freeze({ userId: null, roles: ['super_admin'], claims: {}, surface: 'console' });

function routes() {
  const g = globalThis as { __allodiumAdminRoutes?: ReturnType<typeof createAdminRoutes> };
  g.__allodiumAdminRoutes ??= createAdminRoutes({
    resolver: getViewResolver(),
    views: createFileViewStore({
      dir: viewsDir(),
      onProblem: (name, message) => console.warn(`[console] ${name}.view.json skipped: ${message}`),
    }),
    actorFor: async () => CONSOLE_ACTOR,
    // The same audit lines the hand-written handlers printed, from one place.
    onWrite: ({ action, table, id }) => console.log(`[admin] ${action.toUpperCase()} ${table}${id !== undefined ? ` ${String(id)}` : ''}`),
  });
  return g.__allodiumAdminRoutes;
}

type Ctx = { params: Promise<{ path: string[] }> };

const dispatch = async (request: NextRequest, ctx: Ctx) => routes().handle(request, (await ctx.params).path);

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
