/**
 * OpenID sign-in, driven as a browser and a provider would drive it — with the
 * provider played by a fake fetch and a key pair generated here, so every
 * check runs with no network and no database.
 *
 * What has to hold: the flow is bound to the browser that started it (state,
 * nonce); the identity token's SIGNATURE is verified against the provider's
 * published keys, and so are issuer, audience, expiry and nonce; an
 * unverified email, an unknown identity and an inactive user are all refused
 * without a session; and a good token signs the user in with the app's own
 * session cookies.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createSessionCookies } from '../dist/index.js';
import { createOidcLogin, GOOGLE_ISSUER } from '../dist/oidc.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('oidc sign-in');

/* ------------------------------ the provider ------------------------------ */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims, { key = privateKey, kid = KID, alg = 'RS256' } = {}) => {
  const data = `${b64({ alg, kid, typ: 'JWT' })}.${b64(claims)}`;
  const sig = createSign('RSA-SHA256').update(data).sign(key).toString('base64url');
  return `${data}.${sig}`;
};
const CLIENT = 'client-123.apps.googleusercontent.com';
const now = () => Math.floor(Date.now() / 1000);
const claimsFor = (nonce, extra = {}) => ({ iss: GOOGLE_ISSUER, sub: 'sub-ada', aud: CLIENT, exp: now() + 300, iat: now(), nonce, email: 'ada@example.com', email_verified: true, name: 'Ada', ...extra });

// What the next token exchange will hand back, set per case.
let nextIdToken = null;
let exchanges = [];
let jwksFetches = 0;
const fakeFetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/.well-known/openid-configuration')) {
    return new Response(JSON.stringify({ authorization_endpoint: 'https://provider.test/auth', token_endpoint: 'https://provider.test/token', jwks_uri: 'https://provider.test/jwks' }), { status: 200 });
  }
  if (u === 'https://provider.test/jwks') {
    jwksFetches++;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }
  if (u === 'https://provider.test/token') {
    exchanges.push(Object.fromEntries(new URLSearchParams(init.body)));
    if (nextIdToken === 'FAIL') return new Response('nope', { status: 400 });
    return new Response(JSON.stringify({ id_token: nextIdToken, access_token: 'x' }), { status: 200 });
  }
  throw new Error('unexpected fetch ' + u);
};

/* -------------------------------- the app -------------------------------- */
const minted = [];
const sessions = { mint: async (args) => { minted.push(args); return { accessToken: 'at_1', refreshToken: 'rt_1', expires: 60_000 }; } };
const cookies = createSessionCookies({ names: { access: 'at', refresh: 'rt', expires: 'exp' }, maxAgeSec: 3600, secure: false });
const users = { 'sub-ada': { id: 'u-ada', status: 'active' }, 'sub-sus': { id: 'u-sus', status: 'suspended' } };
const events = [];
const make = (extra = {}) =>
  createOidcLogin({
    issuer: GOOGLE_ISSUER,
    clientId: CLIENT,
    clientSecret: () => 's3cret',
    redirectUri: 'http://app.test/api/auth/google/callback',
    stateSecret: 'state-secret',
    authParams: { prompt: 'select_account' },
    onIdentity: async (claims) => users[claims.sub] ?? null,
    sessions,
    cookies,
    origin: 'site',
    successRedirect: (u) => `/welcome/${u.id}`,
    failureRedirect: '/login',
    fetch: fakeFetch,
    onEvent: (e) => events.push(e),
    ...extra,
  });
const login = make();

const setCookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean));
const cookieHeader = (res, names) => setCookies(res).map((c) => c.split(';')[0]).filter((c) => names.some((n) => c.startsWith(n + '='))).join('; ');

/* --------------------------------- start --------------------------------- */
const started = await login.start(new Request('http://app.test/api/auth/google'));
ok('start redirects', started.status === 302);
const to = new URL(started.headers.get('location'));
ok('...to the provider', to.origin + to.pathname === 'https://provider.test/auth');
ok('...with the right parameters', to.searchParams.get('client_id') === CLIENT && to.searchParams.get('redirect_uri') === 'http://app.test/api/auth/google/callback' && to.searchParams.get('scope') === 'openid email profile' && to.searchParams.get('response_type') === 'code');
ok('...and the extra ones', to.searchParams.get('prompt') === 'select_account');
const state = to.searchParams.get('state');
const nonce = to.searchParams.get('nonce');
ok('...carrying a state and a nonce', !!state && !!nonce && state !== nonce);
const stateCookie = setCookies(started).find((c) => c.startsWith('oidc_state='));
ok('...and a state cookie', !!stateCookie);
ok('...that is HttpOnly and SameSite=Lax', /HttpOnly/.test(stateCookie) && /SameSite=Lax/.test(stateCookie));
ok('...and not Secure on an http redirect URI', !/Secure/.test(stateCookie));
ok('...and does not contain the state in the clear', !stateCookie.includes(state));
const jar = cookieHeader(started, ['oidc_state']);
const cb = (q, cookie = jar) => login.callback(new Request(`http://app.test/api/auth/google/callback?${new URLSearchParams(q)}`, { headers: cookie ? { cookie } : {} }));

/* ------------------------------- happy path ------------------------------- */
nextIdToken = sign(claimsFor(nonce));
const good = await cb({ code: 'code-1', state });
ok('a good callback signs in', good.status === 302 && good.headers.get('location') === '/welcome/u-ada', `${good.status} ${good.headers.get('location')}`);
ok('...minting a session for the user on this surface', minted.length === 1 && minted[0].userId === 'u-ada' && minted[0].origin === 'site');
ok('...setting the session cookies', cookieHeader(good, ['at', 'rt']).includes('at=at_1') && cookieHeader(good, ['at', 'rt']).includes('rt=rt_1'));
ok('...and clearing the state cookie', setCookies(good).some((c) => c.startsWith('oidc_state=;') && /Max-Age=0/.test(c)));
ok('the exchange sent the code and the secret', exchanges[0]?.code === 'code-1' && exchanges[0]?.client_secret === 's3cret' && exchanges[0]?.grant_type === 'authorization_code');
ok('the keys were fetched once', jwksFetches === 1);
ok('an event says who signed in', events.some((e) => e.type === 'signed-in' && e.userId === 'u-ada' && e.sub === 'sub-ada'));

/* --------------------------------- state ---------------------------------- */
const fresh = async () => {
  const s = await login.start(new Request('http://app.test/api/auth/google'));
  const u = new URL(s.headers.get('location'));
  return { state: u.searchParams.get('state'), nonce: u.searchParams.get('nonce'), jar: cookieHeader(s, ['oidc_state']) };
};
const refused = async (q, cookie, reason) => {
  const before = minted.length;
  const r = await cb(q, cookie);
  const loc = r.headers.get('location') ?? '';
  const got = new URL(loc, 'http://app.test').searchParams.get('error');
  return r.status === 302 && got === reason && minted.length === before;
};
{
  const f = await fresh();
  nextIdToken = sign(claimsFor(f.nonce));
  ok('a callback with no state cookie is refused', await refused({ code: 'c', state: f.state }, '', 'state'));
  ok('a callback whose state does not match the cookie is refused', await refused({ code: 'c', state: 'forged' }, f.jar, 'state'));
  ok("a callback with another flow's cookie is refused", await refused({ code: 'c', state: f.state }, jar, 'state'));
  ok('a provider error is refused as provider', await refused({ error: 'access_denied', state: f.state }, f.jar, 'provider'));
}

/* ------------------------------ the token ------------------------------ */
const tokenCase = async (name, mutate, reason = 'token') => {
  const f = await fresh();
  nextIdToken = mutate(f.nonce);
  ok(name, await refused({ code: 'c', state: f.state }, f.jar, reason));
};
await tokenCase('a token signed by another key is refused', (n) => sign(claimsFor(n), { key: rogue.privateKey }));
await tokenCase('a token with an unknown key id is refused', (n) => sign(claimsFor(n), { kid: 'key-9' }));
await tokenCase('a tampered payload is refused', (n) => { const t = sign(claimsFor(n)); const [h, , s] = t.split('.'); return `${h}.${b64(claimsFor(n, { sub: 'sub-mallory' }))}.${s}`; });
await tokenCase('an expired token is refused', (n) => sign(claimsFor(n, { exp: now() - 120 })));
await tokenCase('a token for another audience is refused', (n) => sign(claimsFor(n, { aud: 'someone-else' })));
await tokenCase('a token from another issuer is refused', (n) => sign(claimsFor(n, { iss: 'https://evil.test' })));
await tokenCase('a token with the wrong nonce is refused', () => sign(claimsFor('another-nonce')));
await tokenCase('a token with no nonce is refused', (n) => sign(claimsFor(n, { nonce: undefined })));
await tokenCase('an alg of none is refused', (n) => { const data = `${b64({ alg: 'none' })}.${b64(claimsFor(n))}`; return `${data}.`; });
await tokenCase('an unverified email is refused', (n) => sign(claimsFor(n, { email_verified: false })), 'unverified-email');
await tokenCase('an identity the app does not know is refused', (n) => sign(claimsFor(n, { sub: 'sub-nobody' })), 'not-registered');
await tokenCase('a user who may not sign in is refused', (n) => sign(claimsFor(n, { sub: 'sub-sus' })), 'inactive');
await tokenCase('a failed exchange is refused', () => 'FAIL', 'exchange');
ok('no refusal minted a session', minted.length === 1);
ok('refusals are reported with their reason', events.filter((e) => e.type === 'refused').length >= 13);
ok("the issuer's short form is accepted", await (async () => { const f = await fresh(); nextIdToken = sign(claimsFor(f.nonce, { iss: 'accounts.google.com' })); const r = await cb({ code: 'c', state: f.state }, f.jar); return r.headers.get('location') === '/welcome/u-ada'; })());
ok('an audience list containing the client is accepted', await (async () => { const f = await fresh(); nextIdToken = sign(claimsFor(f.nonce, { aud: ['other', CLIENT] })); const r = await cb({ code: 'c', state: f.state }, f.jar); return r.headers.get('location') === '/welcome/u-ada'; })());
const jwksBefore = jwksFetches;
await tokenCase('an unknown key id refetches the keys once', (n) => sign(claimsFor(n), { kid: 'rotated' }));
ok('...and only once', jwksFetches === jwksBefore + 1, `${jwksFetches - jwksBefore}`);

/* ----------------------------- verifyIdToken ----------------------------- */
const claims = await login.verifyIdToken(sign(claimsFor('n1')), 'n1');
ok('verifyIdToken returns the claims', claims.sub === 'sub-ada' && claims.email === 'ada@example.com');
ok('...and can be used without a nonce', (await login.verifyIdToken(sign(claimsFor(undefined)))).sub === 'sub-ada');
let threw = '';
try { await login.verifyIdToken(sign(claimsFor('n1'), { key: rogue.privateKey }), 'n1'); } catch (e) { threw = e.message; }
ok('...and throws with the reason', threw === 'bad signature', threw);

/* ---------------------------- configuration ----------------------------- */
const secure = make({ redirectUri: 'https://app.test/cb' });
ok('the state cookie is Secure on an https redirect URI', /Secure/.test(setCookies(await secure.start(new Request('https://app.test/x'))).find((c) => c.startsWith('oidc_state=')) ?? ''));
const lax = make({ requireVerifiedEmail: false });
{
  const s = await lax.start(new Request('http://app.test/x')); const u = new URL(s.headers.get('location'));
  nextIdToken = sign(claimsFor(u.searchParams.get('nonce'), { email_verified: undefined }));
  const r = await lax.callback(new Request(`http://app.test/api/auth/google/callback?code=c&state=${u.searchParams.get('state')}`, { headers: { cookie: cookieHeader(s, ['oidc_state']) } }));
  ok('requireVerifiedEmail:false accepts a token without the claim', r.headers.get('location') === '/welcome/u-ada');
}
const explicit = make({ endpoints: { authorization: 'https://provider.test/auth', token: 'https://provider.test/token', jwks: 'https://provider.test/jwks' } });
ok('explicit endpoints skip discovery', (await explicit.start(new Request('http://app.test/x'))).status === 302);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
