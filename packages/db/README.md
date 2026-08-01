# @allodium/db

The data-layer seam: one pool, honest money, and a wire boundary that doesn't corrupt
your timestamps.

Small on purpose. Every function here exists because its absence caused a bug in
production — most of them twice.

```bash
npm install @allodium/db
npm install pg drizzle-orm     # peers
```

Requires Node 20+ and PostgreSQL.

## The pool

```ts
import { createDb, singleton } from '@allodium/db';
import * as schema from './schema';

export const { db, pool, close } = singleton('db', () => createDb(schema, { max: 10 }));
```

`singleton` exists for Next.js dev, where hot reload re-evaluates modules and a plain
`createDb` leaks a new pool on every save until Postgres refuses connections. In
production it is a plain call.

`close()` belongs in your process signal handlers.

## Money

```ts
import { money, numeric } from '@allodium/db';

money(19.999)            // 20    — 2dp, rounded at the boundary
numeric('45.00')         // 45    — Postgres NUMERIC arrives as a string
```

Postgres `NUMERIC` comes back from the driver as a **string**, because it cannot fit in
a JS float without losing precision. Use `numeric()` in your query mappers so route code
never sees `"45.00"` and never accidentally does `"45.00" + 5`.

## The wire boundary

```ts
import { toWireRow, toWireRows } from '@allodium/db';

return Response.json({ order: toWireRow(orders, row) });
```

`toWireRow` maps a Drizzle row to its SQL column names and normalizes timestamps to ISO
strings. The normalizers are also exported directly:

| | |
|---|---|
| `pgTimestamptzToIso` | `timestamptz` text → ISO. Pads bare-hour offsets (`+00` → `+00:00`), which `new Date()` parses inconsistently across runtimes, and guards `isNaN` rather than emitting `"Invalid Date"`. |
| `pgNaiveToIso` | `timestamp` (no zone) → ISO, fraction stripped. |
| `normalizePgTimestamp` | Picks the right one. |

**This is the bug-class the package exists for.** Hand-rolled timestamp handling shipped
broken twice in the reference deployment — once producing `Invalid Date` in an API
response, once shifting every timestamp by the server's offset. The fix is three lines
and belongs in one place.

## Unique-violation detection

```ts
import { isUniqueViolation } from '@allodium/db';

try {
  await db.insert(users).values({ email });
} catch (e) {
  if (isUniqueViolation(e, 'users_email_key')) return { error: 'That email is taken' };
  throw e;
}
```

**Walks the cause chain.** Drizzle wraps the `pg` `DatabaseError`, so the naive
`e.code === '23505'` check silently never fires and you return a 500 for what should be
a friendly message. Optionally match a constraint name so "email taken" and "username
taken" stay distinguishable.

## Design notes

**Peer dependencies.** `pg` and `drizzle-orm` are peers, never bundled — you control the
versions, and there is no chance of two copies of the driver disagreeing about pool
state.

**No environment reads.** `createDb` takes `connectionString` explicitly (falling back to
`DATABASE_URL` only if you omit it). The rest of the toolkit follows the same rule.

## License

MIT. No CLA.
