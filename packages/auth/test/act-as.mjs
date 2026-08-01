/**
 * @allodium/auth — "act as" security battery.
 *
 * Every check here corresponds to a property the feature is supposed to have, or a
 * gotcha the reference implementation hit in production. They are written as tests
 * rather than prose because the failure mode for all of them is silent: an act-as
 * that leaks authority still LOOKS like it works.
 *
 * Pure unit tests — no database needed. Run from the repo root:
 *   node packages/auth/test/act-as.mjs
 */
import { createActAs } from '../dist/index.js';

let pass = 0;
const failures = [];
const ok = (name, cond) => {
  if (cond) pass++;
  else failures.push(name);
};

const SECRET = 'test-secret-not-a-real-one';

// A tiny user directory: one superadmin, one support agent, two members.
const USERS = {
  boss: { id: 'boss', role: 'super_admin' },
  support: { id: 'support', role: 'support' },
  ada: { id: 'ada', role: 'member' },
  grace: { id: 'grace', role: 'member' },
};
const load = async (id) => USERS[id] ?? null;
const userId = (u) => u.id;

/** Default wiring: superadmins may act; support may act but read-only. */
const make = (over = {}) =>
  createActAs({
    secret: SECRET,
    enabled: () => true,
    isDevelopment: () => true,
    canActAs: (u) => u.role === 'super_admin' || u.role === 'support',
    mode: (u) => (u.role === 'super_admin' ? 'full' : 'readonly'),
    loadUser: load,
    userId,
    ...over,
  });

/* ---------------- property 1: the real session is never replaced ------------- */
{
  const a = make();
  const started = await a.start(USERS.boss, 'ada');
  ok('start succeeds for an authorized actor', started.ok);
  const st = await a.resolve(USERS.boss, started.ticket);
  ok('effective identity is the target', st.user.id === 'ada');
  ok('real identity is still the actor', st.real.id === 'boss');
  ok('state reports it is acting', st.acting === true);
  // Stopping is just dropping the ticket — nothing server-side to undo.
  const stopped = await a.resolve(USERS.boss, null);
  ok('dropping the ticket restores the actor', stopped.user.id === 'boss' && stopped.acting === false);
}

/* ------- property 2: authority re-checked every request, from the session ---- */
{
  // Ticket minted while authorized...
  const authorized = make();
  const { ticket } = await authorized.start(USERS.boss, 'ada');

  // ...then the actor is demoted. Same valid ticket, no authority.
  const demoted = make({ canActAs: () => false });
  const st = await demoted.resolve(USERS.boss, ticket);
  ok('demotion kills an in-flight impersonation', st.acting === false && st.user.id === 'boss');
  ok('demotion is reported, not silent', st.refusal === 'not-authorized');
}

/* ------- property 3: signed, and bound to the actor -------------------------- */
{
  const a = make();
  const { ticket } = await a.start(USERS.boss, 'ada');

  // Forgery: tamper with the payload, keep the signature.
  const [payload, sig] = ticket.split('.');
  const evil = Buffer.from(JSON.stringify({ t: 'grace', a: 'boss', m: 'f', e: 9e9 }), 'utf8').toString('base64url');
  const forged = `${evil}.${sig}`;
  const f = await a.resolve(USERS.boss, forged);
  ok('a tampered ticket is refused', f.acting === false && f.refusal === 'invalid-ticket');

  // Theft: a member replays the superadmin's genuine cookie in their own browser.
  const stolen = await a.resolve(USERS.ada, ticket);
  ok('a stolen ticket is inert for another user', stolen.acting === false);
  ok('theft is reported as an actor mismatch', stolen.refusal === 'actor-mismatch');
  ok('the thief remains themselves', stolen.user.id === 'ada');

  // Wrong secret entirely.
  const other = make({ secret: 'a-different-secret' });
  const w = await other.resolve(USERS.boss, ticket);
  ok('a ticket signed with another key is refused', w.refusal === 'invalid-ticket');
}

/* ------- property 4: no escalation by construction --------------------------- */
{
  const a = make();
  const denied = await a.start(USERS.ada, 'grace');
  ok('an unauthorized user cannot start', !denied.ok && denied.refusal === 'not-authorized');

  // Even a hand-made ticket naming a valid pair does nothing without authority.
  const fake = make({ canActAs: (u) => u.id === 'ada' }); // ada CAN act here
  const { ticket } = await fake.start(USERS.ada, 'grace');
  const real = make(); // ...but not in the real wiring
  const st = await real.resolve(USERS.ada, ticket);
  ok('a ticket cannot confer authority the actor lacks', st.acting === false);
}

/* ------- property 5: never silent -------------------------------------------- */
{
  const a = make();
  const { ticket } = await a.start(USERS.boss, 'ada');
  const st = await a.resolve(USERS.boss, ticket);
  ok('state exposes the target for a banner', st.target?.id === 'ada');
  ok('state exposes the real user for a banner', st.real?.id === 'boss');
  ok('state exposes the mode for a banner', st.mode === 'full');
}

/* ---------------- staff are not impersonable by default ---------------------- */
{
  const a = make();
  const r = await a.start(USERS.boss, 'support');
  ok('impersonating another staff account is blocked by default', !r.ok && r.refusal === 'target-blocked');

  const permissive = make({ canBeTarget: () => true });
  const r2 = await permissive.start(USERS.boss, 'support');
  ok('...but it is configurable', r2.ok === true);
}

/* ---------------- read-only mode --------------------------------------------- */
{
  const a = make();
  const sup = await a.start(USERS.support, 'ada');
  ok('support gets a read-only ticket', sup.ok && sup.mode === 'readonly');
  const st = await a.resolve(USERS.support, sup.ticket);
  ok('read-only state is reported', st.mode === 'readonly');
  ok('GET is allowed while read-only', a.blocksWrite(st, 'GET') === false);
  ok('POST is blocked while read-only', a.blocksWrite(st, 'POST') === true);
  ok('DELETE is blocked while read-only', a.blocksWrite(st, 'DELETE') === true);

  const boss = await a.start(USERS.boss, 'ada');
  const bst = await a.resolve(USERS.boss, boss.ticket);
  ok('full mode permits writes', a.blocksWrite(bst, 'POST') === false);
  ok('not acting at all permits writes', a.blocksWrite(await a.resolve(USERS.boss, null), 'POST') === false);
}

/* ---------------- the master switch ------------------------------------------ */
{
  const on = make();
  const { ticket } = await on.start(USERS.boss, 'ada');

  // Off must end in-flight sessions, not merely prevent new ones.
  const off = make({ enabled: () => false });
  const st = await off.resolve(USERS.boss, ticket);
  ok('disabling ends impersonations already in flight', st.acting === false && st.refusal === 'disabled');
  const s = await off.start(USERS.boss, 'ada');
  ok('disabling prevents new impersonations', !s.ok && s.refusal === 'disabled');

  // Unset: on in development, off in production.
  const dev = make({ enabled: () => undefined, isDevelopment: () => true });
  ok('unset means ON in development', dev.enabled() === true);
  const prod = make({ enabled: () => undefined, isDevelopment: () => false });
  ok('unset means OFF in production', prod.enabled() === false);
  const unknown = createActAs({ secret: SECRET, canActAs: () => true, loadUser: load, userId });
  ok('unset with no dev signal means OFF', unknown.enabled() === false);
  ok('an explicit string switch is honoured', make({ enabled: () => 'true' }).enabled() === true);
  ok('a falsy string switch is honoured', make({ enabled: () => '0' }).enabled() === false);
}

/* ---------------- expiry ------------------------------------------------------ */
{
  const a = make({ ttlMs: -1000 }); // already expired
  const { ticket } = await a.start(USERS.boss, 'ada');
  const st = await a.resolve(USERS.boss, ticket);
  ok('an expired ticket is refused', st.acting === false && st.refusal === 'expired');
}

/* ---------------- edges ------------------------------------------------------- */
{
  const a = make();
  ok('acting as yourself is refused', !(await a.start(USERS.boss, 'boss')).ok);
  ok('a missing target is refused', (await a.start(USERS.boss, 'nobody')).refusal === 'target-missing');

  const noSession = await a.resolve(null, 'anything');
  ok('a ticket with no session does nothing', noSession.acting === false && noSession.refusal === 'no-session');

  const { ticket } = await a.start(USERS.boss, 'ada');
  delete USERS.gone;
  const vanished = make({ loadUser: async (id) => (id === 'ada' ? null : USERS[id] ?? null) });
  const st = await vanished.resolve(USERS.boss, ticket);
  ok('a deleted target ends the impersonation', st.acting === false && st.refusal === 'target-missing');
}

/* ---------------- auditing ---------------------------------------------------- */
{
  const events = [];
  const a = make({ onAudit: (e) => events.push(e) });
  const { ticket } = await a.start(USERS.boss, 'ada');
  await a.resolve(USERS.boss, ticket);
  await a.resolve(USERS.ada, ticket); // theft attempt
  ok('start is audited', events.some((e) => e.type === 'start' && e.targetId === 'ada'));
  ok('each active request is audited', events.some((e) => e.type === 'active'));
  ok('refusals are audited', events.some((e) => e.type === 'refused' && e.refusal === 'actor-mismatch'));

  // Auditing must never break the request it describes.
  const boom = make({ onAudit: () => { throw new Error('audit sink down'); } });
  const r = await boom.start(USERS.boss, 'ada');
  ok('a failing audit sink does not break the feature', r.ok === true);
}

console.log(`\nact-as battery: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL:', f);
  process.exit(1);
}
