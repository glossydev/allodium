/**
 * Passkeys, driven as a browser and an authenticator would drive them — with
 * the authenticator played by a P-256 key pair generated here and the
 * attestation and assertion built by hand, so every ceremony runs offline.
 *
 * What has to hold: a registration is bound to the signed-in user whose
 * challenge it answers; a sign-in verifies the assertion against the stored
 * public key, the challenge this browser was handed, the origin and the
 * relying party; the user handle must name the credential's owner; the
 * signature counter must advance; and every refusal short of "your account
 * may not sign in" answers the same way without a session.
 *
 * The in-memory store runs without a database. With DATABASE_URL the default
 * store is exercised against seed 009 as well.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createSessionCookies } from '../dist/index.js';
import { createPasskeys, createPasskeyStore } from '../dist/passkeys.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('passkeys');

/* ------------------------------- minimal CBOR ------------------------------ */
const hdr = (major, n) => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
};
const cbor = (v) => {
  if (v instanceof Uint8Array) return Buffer.concat([hdr(2, v.length), Buffer.from(v)]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([hdr(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? hdr(0, v) : hdr(1, -1 - v);
  if (Array.isArray(v)) return Buffer.concat([hdr(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([hdr(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error('cbor: unsupported ' + typeof v);
};

/* ----------------------------- the authenticator ---------------------------- */
const RP = 'app.test';
const ORIGIN = 'https://app.test';
const sha256 = (b) => createHash('sha256').update(b).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');
const makeAuthenticator = (userId) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(32);
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  let counter = 0;
  const flags = (uv, at) => (0x01 | (uv ? 0x04 : 0) | (at ? 0x40 : 0));
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return {
    id: b64(credId),
    register(challenge, { origin = ORIGIN, rpId = RP, uv = true } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const credIdLen = Buffer.alloc(2); credIdLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags(uv, true)]), u32(0), Buffer.alloc(16), credIdLen, credId, cbor(cose)]);
      const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ['internal'] }, clientExtensionResults: {} };
    },
    get counter() { return counter; },
    assert(challenge, { origin = ORIGIN, rpId = RP, uv = true, counterOverride, userHandle = userId, withHandle = true } = {}) {
      // A real authenticator advances its counter on every assertion, refused or not.
      const c = counterOverride ?? ++counter;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags(uv, false)]), u32(c)]);
      const signature = createSign('SHA256').update(authData).update(sha256(clientData)).sign(privateKey);
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), ...(withHandle ? { userHandle: b64(Buffer.from(userHandle, 'utf8')) } : {}) }, clientExtensionResults: {} };
    },
  };
};

/* --------------------------------- the app --------------------------------- */
const memory = () => {
  const rows = new Map();
  let n = 0;
  return {
    rows,
    async credentialsFor(userId) { return [...rows.values()].filter((r) => r.userId === userId); },
    async findByCredentialId(id) { return [...rows.values()].find((r) => r.credentialId === id) ?? null; },
    async save(r) { const id = `pk${++n}`; rows.set(id, { ...r, id, createdAt: new Date().toISOString(), lastUsedAt: null }); return { id }; },
    async touch(id, counter) { const r = rows.get(id); if (r) { r.counter = counter; r.lastUsedAt = new Date().toISOString(); } },
    async remove(id, userId) { const r = rows.get(id); if (!r || r.userId !== userId) return false; rows.delete(id); return true; },
  };
};
const users = { 'u-ada': { id: 'u-ada', status: 'active' }, 'u-bob': { id: 'u-bob', status: 'active' }, 'u-sus': { id: 'u-sus', status: 'suspended' } };
const minted = [];
const events = [];
const store = memory();
const cookies = createSessionCookies({ names: { access: 'at', refresh: 'rt', expires: 'exp' }, maxAgeSec: 3600, secure: false });
const passkeys = createPasskeys({
  rpID: RP, rpName: 'App', origin: ORIGIN,
  challengeSecret: () => 'challenge-secret',
  store,
  currentUser: async (req) => { const who = req.headers.get('x-user'); return who && users[who] ? { id: who, name: `${who}@example.com` } : null; },
  findUserById: async (id) => users[id] ?? null,
  sessions: { mint: async (a) => { minted.push(a); return { accessToken: 'at_1', refreshToken: 'rt_1', expires: 60_000 }; } },
  cookies, sessionOrigin: 'passkey',
  allowOrigins: ['http://localhost:3191'],
  onEvent: (e) => events.push(e),
});
const setCookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean));
const cookieOf = (res, name) => setCookies(res).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));
const post = (path, { body, user, cookie, headers = {} } = {}) =>
  new Request(`http://app.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path, user) => new Request(`http://app.test${path}`, { headers: user ? { 'x-user': user } : {} });

/* ------------------------------ registration ------------------------------ */
ok('registerOptions needs a signed-in user', (await passkeys.registerOptions(post('/register-options'))).status === 401);
const regOpts = await passkeys.registerOptions(post('/register-options', { user: 'u-ada' }));
ok('registerOptions answers for a signed-in user', regOpts.status === 200, String(regOpts.status));
const reg = await regOpts.json();
ok('...with the relying party and the user', reg.rp?.id === RP && reg.rp?.name === 'App' && reg.user?.name === 'u-ada@example.com' && typeof reg.challenge === 'string');
ok('...asking for no attestation', reg.attestation === 'none');
ok('...with no credentials to exclude yet', (reg.excludeCredentials ?? []).length === 0);
const regCookie = cookieOf(regOpts, 'webauthn_challenge');
ok('...and a challenge cookie that is HttpOnly', !!regCookie && /HttpOnly/.test(setCookies(regOpts)[0]) && /SameSite=Lax/.test(setCookies(regOpts)[0]));
ok('...which does not carry the challenge in the clear', !regCookie.includes(reg.challenge));

const ada = makeAuthenticator('u-ada');
ok('registerVerify needs a signed-in user', (await passkeys.registerVerify(post('/register-verify', { body: { response: ada.register(reg.challenge) }, cookie: regCookie }))).status === 401);
ok('registerVerify with no challenge cookie is 400', (await passkeys.registerVerify(post('/register-verify', { body: { response: ada.register(reg.challenge) }, user: 'u-ada' }))).status === 400);
ok("another user cannot use ada's challenge", (await passkeys.registerVerify(post('/register-verify', { body: { response: ada.register(reg.challenge) }, user: 'u-bob', cookie: regCookie }))).status === 400);
ok('an attestation for another origin is refused', (await passkeys.registerVerify(post('/register-verify', { body: { response: ada.register(reg.challenge, { origin: 'https://evil.test' }) }, user: 'u-ada', cookie: regCookie }))).status === 400);
ok('an attestation for another relying party is refused', (await passkeys.registerVerify(post('/register-verify', { body: { response: ada.register(reg.challenge, { rpId: 'evil.test' }) }, user: 'u-ada', cookie: regCookie }))).status === 400);
ok('an attestation to a different challenge is refused', (await passkeys.registerVerify(post('/register-verify', { body: { response: ada.register(b64(randomBytes(32))) }, user: 'u-ada', cookie: regCookie }))).status === 400);
const made = await passkeys.registerVerify(post('/register-verify', { body: { response: ada.register(reg.challenge), label: '  MacBook  ' }, user: 'u-ada', cookie: regCookie }));
const madeBody = await made.json();
ok('a good attestation registers', made.status === 201, `${made.status} ${JSON.stringify(madeBody)}`);
ok('...returning the id and the trimmed label', typeof madeBody.id === 'string' && madeBody.label === 'MacBook' && JSON.stringify(madeBody.transports) === '["internal"]');
ok('...clearing the challenge cookie', setCookies(made).some((c) => c.startsWith('webauthn_challenge=;') && /Max-Age=0/.test(c)));
const stored = store.rows.get(madeBody.id);
ok('...storing the credential for the user', stored?.userId === 'u-ada' && stored.credentialId === ada.id && stored.counter === 0);
ok('...with the public key as base64url', typeof stored?.publicKey === 'string' && /^[A-Za-z0-9_-]+$/.test(stored.publicKey));
ok('an event says who registered', events.some((e) => e.type === 'registered' && e.userId === 'u-ada'));
const again = await (await passkeys.registerOptions(post('/register-options', { user: 'u-ada' }))).json();
ok('the next registration excludes the credential already held', again.excludeCredentials?.some((c) => c.id === ada.id));

/* --------------------------------- sign-in --------------------------------- */
const loginOpts = await passkeys.loginOptions(post('/login-options'));
const login = await loginOpts.json();
ok('loginOptions is public', loginOpts.status === 200);
ok('...usernameless, with user verification required', (login.allowCredentials ?? []).length === 0 && login.userVerification === 'required' && login.rpId === RP);
const loginCookie = cookieOf(loginOpts, 'webauthn_challenge');
const verify = (response, cookie = loginCookie, extra = {}) => passkeys.loginVerify(post('/login-verify', { body: { response }, cookie, ...extra }));
const fresh = async () => { const r = await passkeys.loginOptions(post('/login-options')); return { challenge: (await r.json()).challenge, cookie: cookieOf(r, 'webauthn_challenge') }; };

ok('a sign-in with no challenge cookie is 400', (await verify(ada.assert(login.challenge), null)).status === 400);
ok("a sign-in with a registration cookie is 400 (wrong purpose)", (await verify(ada.assert(login.challenge), regCookie)).status === 400);
{
  const bob = makeAuthenticator('u-bob');
  const f = await fresh();
  ok('an unknown credential is refused', (await verify(bob.assert(f.challenge), f.cookie)).status === 401);
}
{ const f = await fresh(); ok('an assertion for another origin is refused', (await verify(ada.assert(f.challenge, { origin: 'https://evil.test' }), f.cookie)).status === 401); }
{ const f = await fresh(); ok('an assertion to a different challenge is refused', (await verify(ada.assert(b64(randomBytes(32))), f.cookie)).status === 401); }
{ const f = await fresh(); ok('an assertion without user verification is refused', (await verify(ada.assert(f.challenge, { uv: false }), f.cookie)).status === 401); }
{ const f = await fresh(); ok('an assertion naming another user is refused', (await verify(ada.assert(f.challenge, { userHandle: 'u-bob' }), f.cookie)).status === 401); }
ok('no refusal minted a session', minted.length === 0);
{
  const f = await fresh();
  const good = await verify(ada.assert(f.challenge), f.cookie);
  const gb = await good.json();
  ok('a good assertion signs in', good.status === 200, `${good.status} ${JSON.stringify(gb)}`);
  ok('...minting a session on the passkey origin', minted.length === 1 && minted[0].userId === 'u-ada' && minted[0].origin === 'passkey');
  ok('...setting the session cookies', !!cookieOf(good, 'at') && !!cookieOf(good, 'rt'));
  ok('...clearing the challenge cookie', setCookies(good).some((c) => c.startsWith('webauthn_challenge=;')));
  ok('...returning the public user', gb.user?.id === 'u-ada' && typeof gb.expires === 'number');
  ok('...advancing the stored counter to the authenticator\'s', store.rows.get(madeBody.id).counter === ada.counter && ada.counter > 1 && store.rows.get(madeBody.id).lastUsedAt !== null, `${store.rows.get(madeBody.id).counter} vs ${ada.counter}`);
  // The browser was told to drop the cookie; a client that kept it and re-signed
  // the same challenge must still be refused.
  const reused = await verify(ada.assert(f.challenge), f.cookie);
  ok('the challenge is single use even if the cookie is kept', reused.status === 400, String(reused.status));
  ok('...and no second session was minted', minted.length === 1);
}
{
  const f = await fresh();
  ok('a replayed counter is refused (a cloned key)', (await verify(ada.assert(f.challenge, { counterOverride: 1 }), f.cookie)).status === 401);
  ok('...and did not sign in', minted.length === 1);
}
{
  const f = await fresh();
  ok('an assertion without a user handle still works (the credential names the owner)', (await verify(ada.assert(f.challenge, { withHandle: false }), f.cookie)).status === 200);
}
{
  // A suspended user's key verifies, and is told why they are refused.
  const sus = makeAuthenticator('u-sus');
  const r = await passkeys.registerOptions(post('/register-options', { user: 'u-sus' }));
  const o = await r.json();
  await passkeys.registerVerify(post('/register-verify', { body: { response: sus.register(o.challenge) }, user: 'u-sus', cookie: cookieOf(r, 'webauthn_challenge') }));
  const f = await fresh();
  const refusedSus = await verify(sus.assert(f.challenge), f.cookie);
  ok('an inactive account is refused as inactive', refusedSus.status === 403 && (await refusedSus.json()).status === 'suspended');
}
{ const f = await fresh(); ok('a cross-site sign-in is refused', (await verify(ada.assert(f.challenge), f.cookie, { headers: { origin: 'http://evil.test' } })).status === 403); }
{ const f = await fresh(); ok('an allowlisted origin passes', (await verify(ada.assert(f.challenge), f.cookie, { headers: { origin: 'http://localhost:3191' } })).status === 200); }

/* ------------------------------ list and remove ----------------------------- */
ok('list needs a signed-in user', (await passkeys.list(get('/credentials'))).status === 401);
const listed = await (await passkeys.list(get('/credentials', 'u-ada'))).json();
ok("list shows the user's passkeys", listed.passkeys?.length === 1 && listed.passkeys[0].label === 'MacBook');
ok('...never the public key', !('publicKey' in listed.passkeys[0]) && !('credentialId' in listed.passkeys[0]));
ok("bob cannot remove ada's passkey", (await passkeys.remove(post('/credentials/x', { user: 'u-bob' }), madeBody.id)).status === 404);
ok('ada removes her own', (await passkeys.remove(post('/credentials/x', { user: 'u-ada' }), madeBody.id)).status === 200);
ok('...and it is gone', (await (await passkeys.list(get('/credentials', 'u-ada'))).json()).passkeys.length === 0);
{ const f = await fresh(); ok('a removed credential cannot sign in', (await verify(ada.assert(f.challenge), f.cookie)).status === 401); }
ok('preflight is 204', passkeys.preflight(new Request('http://app.test/x', { method: 'OPTIONS' })).status === 204);

/* ------------------------------ the default store ----------------------------- */
if (process.env.DATABASE_URL) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const dbStore = createPasskeyStore(pool);
    const [{ id: userId }] = (await pool.query("select id from users where status = 'active' limit 1")).rows;
    const saved = await dbStore.save({ userId, credentialId: b64(randomBytes(16)), publicKey: b64(randomBytes(32)), counter: 0, transports: ['internal', 'hybrid'], label: 'db test', backedUp: true, deviceType: 'multiDevice' });
    const found = await dbStore.findByCredentialId((await dbStore.credentialsFor(userId)).find((r) => r.id === saved.id).credentialId);
    ok('the default store saves and finds a credential', found?.id === saved.id && found.label === 'db test' && found.counter === 0 && JSON.stringify(found.transports) === '["internal","hybrid"]' && found.backedUp === true);
    await dbStore.touch(saved.id, 7);
    const touched = (await dbStore.credentialsFor(userId)).find((r) => r.id === saved.id);
    ok('...touches the counter and last_used_at', touched.counter === 7 && touched.lastUsedAt !== null);
    ok("...refuses another user's removal", (await dbStore.remove(saved.id, '00000000-0000-0000-0000-000000000000')) === false);
    ok('...and removes the owner\'s', (await dbStore.remove(saved.id, userId)) === true && (await dbStore.findByCredentialId(found.credentialId)) === null);
  } finally {
    await pool.end();
  }
} else {
  console.log('  (default store checks skipped — no DATABASE_URL)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
