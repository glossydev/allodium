# Allodium Developer Console — architecture & conventions

The **build-the-site lane**: a catalog-driven Postgres console. Dev harness for the
toolkit and the extraction source for `@allodium/admin`'s console kit. Dark, dense,
optimized for developers: find specific things fast AND expose lots of data to scan.

## v1 posture

- **Localhost dev tool, enforced — not assumed.** Port **3180**. No auth yet, so
  "local only" IS the security model and it is enforced in three places:
  `-H 127.0.0.1` in the dev/start scripts, a `middleware.ts` that 421s any request
  whose `Host` is not loopback (closing DNS rebinding, which loopback binding alone
  does not), and a same-origin + content-type gate on every mutation (closing
  drive-by CSRF, which loopback binding also does not).
  Auth arrives later via `@allodium/auth` factories when the console grows a hosted
  story. **Do not weaken these three without replacing them with real auth** —
  `/api/sql` and `/api/schema/ddl` are a full database surface.
  *(All three were added after a verification pass found the console answering on the
  LAN and accepting cross-origin `text/plain` POSTs that could drive `drop table`.)*
- **Catalog-driven, not registry-driven.** All schema knowledge comes from
  `pg_catalog`/`information_schema` at request time (`lib/catalog.ts`, 2s TTL), so a
  table created in the Schema silo is instantly browsable in Content. The Drizzle
  registry (`@allodium/admin`) re-enters when a consuming app exists — that's where
  drift detection comes back.
- **Raw writes.** DML here fires no app logic. That is the console's contract.

## Safety model (non-negotiable, see `lib/sql-utils.ts`)

1. Names reaching SQL either resolve in the live catalog (browse/DML) or pass
   `validateIdentifier` (DDL creating new names). Either way they get `qid()` quoting.
2. Values ONLY travel as bound parameters with `::casts` from the catalog's `udt_name`
   (`castExpr`). Never concatenate a value into SQL.
3. Masked columns (`lib/masking.ts` — substring pattern + **runtime** env overrides
   `CONSOLE_MASK_EXTRA` / `CONSOLE_MASK_EXEMPT`) are never selected, never editable,
   never filterable, never **sortable** (ordering by a secret leaks its collation
   order — the same oracle a filter would give), and never on the wire. Enforced
   server-side in `lib/dml.ts`; the PK fallback paths respect it too, and
   `catalogForClient` strips masked columns' DEFAULT expressions since a default can
   itself be the secret. The SQL silo redacts masked columns by result-field
   `tableID`/`columnID` rather than exempting itself from the doctrine.
4. DDL flows show their generated SQL (`SqlPreview`) before executing, and surface the
   verbatim pg error — **including DETAIL and HINT**, which carry the actionable part
   ("constraint X on table Y depends on…"). No mystery errors: that's the founding
   grievance. Execute is pinned to the previewed string via `confirmSql`; the server
   refuses (409) if a re-build differs, so a debounce race or concurrent schema change
   can never run something the user did not see.
5. The SQL silo is read-only through **three independent layers**, because the first
   alone was provably insufficient: (a) `lib/sql-guard.ts` allows one statement per
   run — multi-statement input could otherwise lead with
   `set transaction read write; … ; commit;` and persist a write before the rollback
   (verified exploitable); (b) read-only transaction + 10s timeout, rolled back
   unconditionally; (c) `CONSOLE_RO_DATABASE_URL` — a role holding only SELECT, since
   privileges survive anything the session can `SET`. Layer (c) is optional but the UI
   says so in the footer when it is missing.

## Framework (owned by the shell — silo agents do NOT edit these)

| File | Provides |
|---|---|
| `middleware.ts` | loopback Host pin, same-origin + content-type gate on mutations |
| `lib/db.ts` | `getDb()` — pool singleton; `getReadOnlyDb()` — SELECT-only pool for the SQL silo |
| `lib/sql-guard.ts` | `assertSingleStatement` — pg-aware statement-boundary scanner |
| `lib/catalog.ts` | `getCatalog/getTable/getRowCounts/catalogForClient/invalidateCatalog`, types |
| `lib/sql-utils.ts` | `qid, validateIdentifier, castExpr, pgErrorMessage` |
| `lib/dml.ts` | `selectRows/insertRow/updateRow/deleteRow` (+ `Filter`, ops) |
| `lib/masking.ts` | `isMaskedColumn` |
| `lib/api-helpers.ts` | `ok/bad/oops/jsonBody/parseFilterParams` |
| `ui/tokens.ts` | `tk.*` class tokens — compose from these, no raw colors |
| `ui/primitives.tsx` | `cellText/clip/NullMark/prettyBytes/fetchJson/SlideOver/Modal/ErrorBox/EmptyState/LoadingState/SqlPreview`, `PAGE_SIZE` |
| `app/layout.tsx`, `app/nav.tsx` | shell + silo nav |
| `app/api/catalog/route.ts` | GET `/api/catalog` → `CatalogForClient` |

## Silo ownership (route dirs + API dirs, one owner each)

| Silo | Owns |
|---|---|
| Schema | `app/schema/**`, `app/api/schema/**`, `lib/ddl.ts` |
| Content | `app/content/**`, `app/api/content/**` |
| Users | `app/users/**`, `app/api/users/**` |
| Roles & Permissions | `app/roles/**`, `app/api/roles/**` |
| Files | `app/files/**`, `app/api/files/**` |
| SQL + Admin Builder | `app/sql/**`, `app/api/sql/**`, `app/admin-builder/**` |

A silo needing a new shared helper adds it under its own dir and flags it for hoisting.

## Conventions

- **API shape**: 2xx → data; non-2xx → `{ error: string }`. Routes export
  `dynamic = 'force-dynamic'`.
- **Next 15**: route-handler `params` and page `searchParams` are Promises — await
  them. Client components using `useSearchParams` are rendered inside `<Suspense>`
  by a server `page.tsx`.
- **URL state**: grids/detail state live in the URL so views are shareable.
  Content deep-link convention: `/content?table=orders&sort=placed_at&dir=desc&f=col:op:val`
  (`f` repeatable; ops: eq neq contains gt gte lt lte null notnull). Other silos
  link INTO content with that URL shape (e.g. Users → user_roles rows).
- **Density**: sticky headers (`tk.th*`), compact rows, `NullMark` for NULL, mono for
  identifiers/values, counts in footers. Every grid gets sort + filter — scanning AND
  finding are both first-class.
- **Timestamps**: `lib/dml.ts` serializes timestamptz/timestamp/date to ISO text
  in SQL — don't re-parse on the client, just display.
- **Fetched rows carry their table.** Store `{table, rows, total}` together and render
  only when it matches the current selection. Keeping rows in a bare `rows` state let
  a table switch paint the previous table's rows under the new table's columns — and a
  click in that window bound the drawer to the wrong table, so Save/Delete hit a
  different physical row sharing a pk value.
- **Re-read a baseline after writing it.** A staged-edit view (the permission matrix)
  must refetch its saved baseline post-save; otherwise Discard restores pre-save state
  and the next Save silently reverts the database.
- **Re-sync drawer inputs on identity, not object.** Key the effect on `user.id`, not
  the whole row object — an unrelated refresh replaces the object and would wipe
  whatever the operator was typing.
