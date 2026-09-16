/**
 * The datetime widget's zone handling, in a zone that is not UTC.
 *
 * The bug this guards: the wire's ISO string was sliced straight into a
 * datetime-local input (UTC digits shown as local) and the input's value was
 * parsed back as local — so in Los Angeles every edit moved by seven hours.
 * Node honours TZ at startup, so this re-runs itself under a fixed zone and
 * checks that an instant survives display → input → instant unchanged.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toLocalDateTimeInput, fromLocalDateTimeInput } from '../dist/react/datetime.js';

const ZONE = 'America/Los_Angeles';
if (process.env.TZ !== ZONE) {
  // Re-run in the zone the bug was reported from. Both PDT and PST cases run below.
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: ZONE }, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log(`datetime widget in ${ZONE}`);

// A summer instant (PDT, UTC-7) and a winter one (PST, UTC-8).
for (const [iso, local] of [
  ['2026-09-10T04:11:27.000Z', '2026-09-09T21:11'],
  ['2026-01-15T08:00:00.000Z', '2026-01-15T00:00'],
]) {
  ok(`${iso} displays as local ${local}`, toLocalDateTimeInput(iso) === local, toLocalDateTimeInput(iso));
  ok(`...and the untouched input goes back to the same instant`, fromLocalDateTimeInput(toLocalDateTimeInput(iso)) === iso.replace(':27.000', ':00.000'), String(fromLocalDateTimeInput(toLocalDateTimeInput(iso))));
}

// The regression in one line: what the old code showed for the same instant.
ok('the old display was wrong by the zone offset', '2026-09-10T04:11:27.000Z'.slice(0, 16) !== toLocalDateTimeInput('2026-09-10T04:11:27.000Z'));

// Round trip of an operator's edit: a local time typed in comes back as the
// instant it names in this zone.
ok('a typed local time becomes the right instant', fromLocalDateTimeInput('2026-07-04T12:30') === '2026-07-04T19:30:00.000Z', String(fromLocalDateTimeInput('2026-07-04T12:30')));
ok('a typed winter time uses the winter offset', fromLocalDateTimeInput('2026-12-25T12:30') === '2026-12-25T20:30:00.000Z');

// Values that carry no instant pass through rather than being "converted".
ok('the input\'s own zoneless form passes through', toLocalDateTimeInput('2026-07-04T12:30') === '2026-07-04T12:30');
ok('...with seconds trimmed', toLocalDateTimeInput('2026-07-04T12:30:15') === '2026-07-04T12:30');
ok('empty is empty', toLocalDateTimeInput('') === '' && toLocalDateTimeInput(null) === '' && toLocalDateTimeInput(undefined) === '');
ok('garbage is empty, not Invalid Date', toLocalDateTimeInput('not a date') === '');
ok('clearing the input stores null', fromLocalDateTimeInput('') === null);
ok('an unparseable input stores null', fromLocalDateTimeInput('nope') === null);

// pg's own text form for timestamptz, should it reach the client unnormalized.
ok('a pg-style timestamptz string is understood', toLocalDateTimeInput('2026-09-10T04:11:27+00:00') === '2026-09-09T21:11');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
