/**
 * Wire-shape helpers: Drizzle rows → the snake_case / ISO-timestamp JSON contract most
 * REST APIs (and every headless-CMS migration) need to preserve byte-for-byte.
 *
 * Timestamp background — node-postgres hands string-mode timestamp columns back as raw
 * pg text, which is NOT ISO 8601:
 *   naive     'YYYY-MM-DD HH:mm:ss[.fff]'
 *   tz-aware  'YYYY-MM-DD HH:mm:ss[.fff]+HH[:MM]'   ← note the possible BARE-HOUR offset
 * The bare-hour offset ('+00') is the classic production bug: `new Date()` on it is
 * Invalid, and `.toISOString()` then throws — typically AFTER the row committed, so the
 * API 500s while the write sticks. Every helper here pads it before parsing. Extracted
 * from a deployment where this exact bug shipped twice because the normalizer had been
 * hand-copied per module; import these instead of copying.
 */

import { getTableColumns, type Table } from 'drizzle-orm';

/**
 * Anchored full-match of the pg text timestamp forms above, so ordinary text columns
 * can never be caught by accident.
 */
const PG_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?)?$/;

/**
 * timestamptz pg text → full ISO-Z ('2026-06-03T21:50:07.457Z'), the JSON.stringify(Date)
 * shape. Pads bare-hour offsets before parsing; if the value still doesn't parse it is
 * returned untouched (never throw on the read path). Null-safe.
 */
export const pgTimestamptzToIso = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const iso = v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? v : d.toISOString();
};

/**
 * Naive (zoneless) pg text → ISO 'T' form with fractional seconds stripped
 * ('2026-01-13 15:42:00.665' → '2026-01-13T15:42:00'). Whole seconds is what
 * JSON-era CMS backends emitted for naive columns; keep the contract. Null-safe.
 */
export const pgNaiveToIso = (v: string | null | undefined): string | null =>
  v == null ? null : v.replace(/\.\d+$/, '').replace(' ', 'T');

/**
 * General single-value normalizer used by {@link toWireRow}: full-match detection, then
 * tz-aware values → full ISO-Z, naive values → space→T swap (fraction kept — no zone
 * math on zoneless data). Non-timestamp strings pass through untouched.
 */
export const normalizePgTimestamp = (v: string): string => {
  const m = PG_TS.exec(v);
  if (!m) return v;
  if (m[2]) {
    const iso = v.replace(' ', 'T') + (m[3] ? '' : ':00');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? v : d.toISOString();
  }
  return v.replace(' ', 'T');
};

/**
 * Map a Drizzle row (camelCase properties) back to raw column-name keys (snake_case),
 * normalizing timestamps along the way — for endpoints that return entire rows.
 * Field-listed endpoints should keep explicit per-module mappers (they document the
 * contract); this is for the full-row cases.
 */
export function toWireRow<T extends Table>(table: T, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [prop, col] of Object.entries(getTableColumns(table))) {
    let v = row[prop];
    // Date objects (date-mode columns) → ISO; pg text (string-mode columns) → normalized.
    if (v instanceof Date) v = v.toISOString();
    else if (typeof v === 'string') v = normalizePgTimestamp(v);
    out[(col as { name: string }).name] = v;
  }
  return out;
}

export function toWireRows<T extends Table>(
  table: T,
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((r) => toWireRow(table, r));
}
