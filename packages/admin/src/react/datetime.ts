/**
 * The datetime-local input and the wire disagree about time zones, and the
 * disagreement is silent.
 *
 * The wire carries an instant — an ISO string in UTC. The input wants and
 * gives back wall-clock time in the BROWSER'S zone, with no zone attached.
 * Slicing the ISO string into the input shows the UTC digits as if they were
 * local; parsing the input's value with `new Date` reads them as local. Round
 * one edit through that pair in Los Angeles and every timestamp moves by
 * seven hours, which nobody notices until published_at is tomorrow.
 *
 * So both directions go through the browser's zone explicitly: the instant is
 * rendered with the local getters, and the local value is parsed as local (the
 * one thing `new Date` does right with a zoneless string) and sent back as an
 * instant. A value that is already in the input's own zoneless form — the
 * operator's unsaved edit, or a `timestamp without time zone` column — is
 * passed through, because it has no instant to convert.
 */

const LOCAL_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** An instant (or anything Date can parse) → the browser-local `YYYY-MM-DDTHH:mm` an input wants. */
export function toLocalDateTimeInput(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value);
  if (LOCAL_FORM.test(s)) return s.slice(0, 16);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The input's browser-local value → the instant to store, as ISO UTC. Empty → null. */
export function fromLocalDateTimeInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
