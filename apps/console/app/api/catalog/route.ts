import { catalogForClient } from '@/lib/catalog';
import { ok, oops } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** GET /api/catalog — the JSON-safe live catalog every silo boots from. */
export async function GET() {
  try {
    return ok(await catalogForClient());
  } catch (e) {
    return oops(e);
  }
}
