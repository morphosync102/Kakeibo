import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createSession, readSession } from '../lib/session.ts';
import { createChallengeToken, newChallenge, readChallengeToken } from '../lib/webauthn-challenge.ts';
import { loadRoute } from './helpers/load-route.mjs';
import { createSoftPasskey } from './helpers/soft-authenticator.mjs';
import { createFakeGas, sha256 } from './helpers/fake-gas-auth.mjs';

// Passkey routes driven by a software authenticator (real ES256 signatures and
// attestation objects; @simplewebauthn/server is not mocked) against an
// in-memory GAS that follows the auth contract. Synthetic values only.
const secret = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const DUMMY_KEY = 'dummy-gas-proxy-secret';
const DUMMY_AUTH_KEY = 'dummy-gas-auth-proxy-secret';
const RP_ID = 'kakeibo.example';
const ORIGIN = 'https://kakeibo.example';
const ENV = {
    SESSION_SECRET: secret, APP_PASSWORD: password, GAS_PROXY_SECRET: DUMMY_KEY, GAS_AUTH_PROXY_SECRET: DUMMY_AUTH_KEY,
    NODE_ENV: 'production', WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_ORIGIN: ORIGIN,
};
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const ADMIN = { userId: 'u_admin_synthetic', displayName: '管理者', role: 'admin', sources: ['main', 'yahoo'], homeSource: 'main', epoch: 2 };
const YUKI = { userId: 'u_member_synthetic', displayName: 'Yuki', role: 'member', sources: ['yuki', 'main'], homeSource: 'yuki', epoch: 0 };
const INVITE = randomBytes(32).toString('base64url');
const b64u = text => Buffer.from(text, 'utf8').toString('base64url');

const world = ({ credentials = [], invites = { [INVITE]: { userId: YUKI.userId } }, users = [ADMIN, YUKI] } = {}) =>
    createFakeGas({ authKey: DUMMY_AUTH_KEY, users, invites, credentials });
const stored = pk => ({ credentialId: pk.id, userId: pk.userId, publicKey: pk.cosePublicKey, counter: pk.counter, transports: ['internal'] });
const sessionOf = (user, amr = 'pk') => createSession(secret, { ...user, amr });

function parseSetCookies(response) {
    const map = new Map();
    for (const line of response.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const index = pair.indexOf('=');
        map.set(pair.slice(0, index).trim(), { value: decodeURIComponent(pair.slice(index + 1)), attrs: attrs.join(';') });
    }
    return map;
}

async function call(path, { body = {}, session, challenge, env = {}, gas, ua, host = 'kakeibo.example' } = {}) {
    const route = await loadRoute(`app/api/auth/${path}/route.ts`, {
        env: { ...ENV, ...env },
        cookie: session,
        cookies: { kakeibo_webauthn: challenge },
        upstream: (gas ?? world()).upstream,
    });
    const request = new Request(`https://${host}/api/auth/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(ua ? { 'user-agent': ua } : {}) },
    });
    const res = await route.POST(request);
    const cookies = parseSetCookies(res);
    return {
        status: res.status,
        json: await res.json(),
        cookies,
        challengeCookie: cookies.get('kakeibo_webauthn')?.value,
        sessionCookie: cookies.get('kakeibo_session')?.value,
        actions: route.calls.map(([, init]) => JSON.parse(init.body).action),
        bodies: route.calls.map(([, init]) => JSON.parse(init.body)),
        logs: route.logs,
        cacheControl: res.headers.get('cache-control'),
    };
}

const deleted = (result, name = 'kakeibo_webauthn') => {
    const c = result.cookies.get(name);
    return Boolean(c) && c.value === '' && /Max-Age=0/i.test(c.attrs);
};

// ---------------------------------------------------------------- invite registration

test('invite registration: options from authPeekInvite (hash only), then a verified passkey, a consumed invite and a pk session', async () => {
    const existing = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const gas = world({ credentials: [stored(existing)] });
    const opt = await call('register/options', { body: { token: INVITE }, gas });
    assert.equal(opt.status, 200);
    assert.equal(opt.cacheControl, 'no-store');
    assert.equal(opt.json.displayName, 'Yuki');
    const options = opt.json.options;
    assert.equal(options.rp.id, RP_ID);
    assert.equal(options.user.id, b64u(YUKI.userId), 'user.id (userHandle) is the userId');
    assert.deepEqual(options.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    assert.equal(options.attestation, 'none');
    assert.deepEqual(options.pubKeyCredParams.map(p => p.alg), [-7, -257]);
    assert.deepEqual(options.excludeCredentials.map(c => c.id), [existing.id], 'no second registration of the same device');
    // the GAS call carries the hash, never the token
    assert.deepEqual(opt.bodies, [{ action: 'authPeekInvite', tokenHash: sha256(INVITE), key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY }]);
    assert.ok(!JSON.stringify(opt.bodies).includes(INVITE));
    // the challenge cookie: register purpose, bound to the invite
    const cookie = opt.cookies.get('kakeibo_webauthn');
    for (const attr of [/HttpOnly/i, /Secure/i, /SameSite=strict/i, /Path=\/api\/auth(;|$)/i, /Max-Age=300/i]) assert.match(cookie.attrs, attr);
    assert.deepEqual(await readChallengeToken(cookie.value, secret, { purposes: ['register'], binding: sha256(INVITE) }), { purpose: 'register', challenge: options.challenge, binding: sha256(INVITE) });

    const pk = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const response = pk.register({ challenge: options.challenge, origin: ORIGIN });
    const ver = await call('register/verify', { body: { token: INVITE, response }, challenge: cookie.value, gas, ua: IPHONE_UA });
    assert.equal(ver.status, 200);
    assert.deepEqual(ver.json, { success: true, userId: YUKI.userId, redirectTo: '/yuki' });
    assert.ok(deleted(ver), 'the challenge cookie is deleted');
    assert.deepEqual(await readSession(ver.sessionCookie, ENV), { userId: YUKI.userId, epoch: 0, sources: ['yuki', 'main'], homeSource: 'yuki', amr: 'pk' });
    assert.deepEqual(ver.bodies, [{
        action: 'authConsumeInviteAndAddCredential', tokenHash: sha256(INVITE), challengeHash: sha256(options.challenge),
        credential: { credentialId: pk.id, publicKey: pk.cosePublicKey, counter: 0, transports: ['internal', 'hybrid'], deviceType: 'multiDevice', backedUp: true, label: 'iPhone' },
        key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY,
    }]);
    assert.equal(gas.state.invites.get(sha256(INVITE)).used, true);

    // the same invite again: consumed (one-time), no session
    const again = await call('register/verify', { body: { token: INVITE, response }, challenge: cookie.value, gas });
    assert.equal(again.status, 410);
    assert.equal(again.json.error, 'InviteInvalid');
    assert.equal(again.sessionCookie, undefined);
});

test('register/verify rejects a missing, foreign, expired or wrong-purpose challenge and bad responses before GAS', async () => {
    const gas = world();
    const opt = await call('register/options', { body: { token: INVITE }, gas });
    const challenge = opt.json.options.challenge;
    const pk = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const good = pk.register({ challenge, origin: ORIGIN });
    const otherInvite = await createChallengeToken(secret, { purpose: 'register', challenge, binding: sha256('another-synthetic-invite-token-000000') });
    const expired = await createChallengeToken(secret, { purpose: 'register', challenge, binding: sha256(INVITE) }, Date.now() - 301_000);
    const loginPurpose = await createChallengeToken(secret, { purpose: 'login', challenge, binding: '-' });
    for (const [label, cookie, expected] of [
        ['no cookie', undefined, 'ChallengeInvalid'], ['other invite', otherInvite, 'ChallengeInvalid'],
        ['expired', expired, 'ChallengeInvalid'], ['login purpose', loginPurpose, 'ChallengeInvalid'], ['garbage', 'x', 'ChallengeInvalid'],
    ]) {
        const res = await call('register/verify', { body: { token: INVITE, response: good }, challenge: cookie, gas });
        assert.equal(res.status, 400, label);
        assert.equal(res.json.error, expected, label);
        assert.deepEqual(res.actions, [], label);
        assert.equal(res.sessionCookie, undefined, label);
        if (cookie !== undefined) assert.ok(deleted(res), label);
    }
    for (const [label, response] of [
        ['wrong origin', pk.register({ challenge, origin: 'https://evil.example' })],
        ['wrong rpID', pk.register({ challenge, origin: ORIGIN, rpIdOverride: 'evil.example' })],
        ['no user verification', pk.register({ challenge, origin: ORIGIN, uv: false })],
        ['other challenge', pk.register({ challenge: newChallenge(), origin: ORIGIN })],
        ['assertion type', pk.register({ challenge, origin: ORIGIN, type: 'webauthn.get' })],
    ]) {
        const res = await call('register/verify', { body: { token: INVITE, response }, challenge: opt.challengeCookie, gas });
        assert.equal(res.status, 400, label);
        assert.equal(res.json.error, 'VerificationFailed', label);
        assert.deepEqual(res.actions, [], label);
        assert.ok(deleted(res), label);
    }
    for (const body of [{ token: INVITE }, { token: INVITE, response: { id: 'x' } }, { response: good }, { token: 'bad.token', response: good }]) {
        const res = await call('register/verify', { body, challenge: opt.challengeCookie, gas });
        assert.ok(res.status === 400 || res.status === 410, JSON.stringify(body));
        assert.deepEqual(res.actions, []);
    }
    assert.equal(gas.state.invites.get(sha256(INVITE)).used, false, 'nothing consumed');
});

test('register/options: invalid invites, GAS failures and the Host header', async () => {
    const unknown = await call('register/options', { body: { token: randomBytes(32).toString('base64url') } });
    assert.equal(unknown.status, 410);
    assert.equal(unknown.challengeCookie, undefined);
    const malformed = await call('register/options', { body: { token: 'short' } });
    assert.equal(malformed.status, 410);
    assert.deepEqual(malformed.actions, []);
    const gas = world();
    gas.state.override.authPeekInvite = new Error(`down ${DUMMY_KEY} ${DUMMY_AUTH_KEY}`);
    const down = await call('register/options', { body: { token: INVITE }, gas });
    assert.equal(down.status, 503);
    assert.deepEqual(down.json, { error: 'Service Unavailable' });
    for (const s of [DUMMY_KEY, DUMMY_AUTH_KEY, INVITE]) assert.ok(down.logs.every(line => !line.includes(s)));
    // RP ID from WEBAUTHN_RP_ID even when the request names another host
    const evilHost = await call('register/options', { body: { token: INVITE }, host: 'evil.example' });
    assert.equal(evilHost.json.options.rp.id, RP_ID);
});

test('every passkey route fails closed (503, no GAS, no cookie) without WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET', async () => {
    const session = await sessionOf(ADMIN);
    for (const env of [{ WEBAUTHN_RP_ID: undefined }, { WEBAUTHN_ORIGIN: undefined }, { WEBAUTHN_ORIGIN: 'http://kakeibo.example' }, { SESSION_SECRET: undefined }]) {
        for (const path of ['register/options', 'register/verify', 'login/options', 'login/verify', 'passkeys/add/options', 'passkeys/add/reauth', 'passkeys/add/bootstrap', 'passkeys/add/verify']) {
            const res = await call(path, { body: { token: INVITE, password }, session, env });
            assert.equal(res.status, 503, `${path} ${JSON.stringify(env)}`);
            assert.deepEqual(res.actions, [], path);
            assert.equal(res.sessionCookie === undefined || res.sessionCookie === '', true, path);
            assert.ok(res.challengeCookie === undefined || res.challengeCookie === '', path);
        }
    }
});

// ---------------------------------------------------------------- login

async function loginOptions(gas) {
    const opt = await call('login/options', { gas });
    return { opt, challenge: opt.json.options.challenge, cookie: opt.challengeCookie };
}

test('passkey login: no GAS for options, then authGetCredential -> verify -> authRecordCredentialUse -> pk session', async () => {
    const pk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId, counter: 5, synced: false });
    const gas = world({ credentials: [stored(pk)] });
    const { opt, challenge, cookie } = await loginOptions(gas);
    assert.equal(opt.status, 200);
    assert.deepEqual(opt.actions, [], 'options need no GAS round trip');
    assert.equal(opt.json.options.rpId, RP_ID);
    assert.equal(opt.json.options.userVerification, 'required');
    assert.ok(!opt.json.options.allowCredentials || opt.json.options.allowCredentials.length === 0, 'discoverable: no allowCredentials');
    assert.match(opt.cookies.get('kakeibo_webauthn').attrs, /Path=\/api\/auth/i);

    const response = pk.assert({ challenge, origin: ORIGIN, step: 1 });
    const ver = await call('login/verify', { body: { response, returnTo: '/yahoo/calendar' }, challenge: cookie, gas });
    assert.equal(ver.status, 200);
    assert.deepEqual(ver.json, { success: true, userId: ADMIN.userId, redirectTo: '/yahoo/calendar' });
    assert.ok(deleted(ver));
    assert.deepEqual(await readSession(ver.sessionCookie, ENV), { userId: ADMIN.userId, epoch: 2, sources: ['main', 'yahoo'], homeSource: 'main', amr: 'pk' });
    assert.match(ver.cookies.get('kakeibo_session').attrs, /HttpOnly/i);
    assert.deepEqual(ver.bodies.map(b => ({ ...b, key: undefined, authKey: undefined })), [
        { action: 'authGetCredential', credentialId: pk.id, key: undefined, authKey: undefined },
        { action: 'authRecordCredentialUse', credentialId: pk.id, counter: 6, challengeHash: sha256(challenge), key: undefined, authKey: undefined },
    ]);
    assert.ok(ver.bodies.every(b => b.authKey === DUMMY_AUTH_KEY && b.key === DUMMY_KEY));
    assert.equal(gas.state.credentials.get(pk.id).counter, 6);
    // a session cookie survives APP_PASSWORD removal (amr=pk)
    assert.ok(await readSession(ver.sessionCookie, { SESSION_SECRET: secret }));
});

test('a used challenge is refused (ChallengeReused): replaying the same assertion and cookie gives no session', async () => {
    const pk = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId }); // synced: counter stays 0
    const gas = world({ credentials: [stored(pk)] });
    const { challenge, cookie } = await loginOptions(gas);
    const response = pk.assert({ challenge, origin: ORIGIN });
    const first = await call('login/verify', { body: { response }, challenge: cookie, gas });
    assert.equal(first.status, 200);
    assert.equal(first.json.redirectTo, '/yuki');
    const replay = await call('login/verify', { body: { response }, challenge: cookie, gas });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, 'ChallengeInvalid');
    assert.equal(replay.sessionCookie, undefined);
    assert.ok(deleted(replay));
});

test('a counter that does not increase is refused (cloned authenticator) and not recorded', async () => {
    const pk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId, counter: 10, synced: false });
    const gas = world({ credentials: [stored(pk)] });
    for (const counterOverride of [3, 10]) {
        const { challenge, cookie } = await loginOptions(gas);
        const res = await call('login/verify', { body: { response: pk.assert({ challenge, origin: ORIGIN, counterOverride }) }, challenge: cookie, gas });
        assert.equal(res.status, 401, String(counterOverride));
        assert.equal(res.json.error, 'VerificationFailed');
        assert.equal(res.sessionCookie, undefined);
        assert.deepEqual(res.actions, ['authGetCredential']);
    }
    assert.equal(gas.state.credentials.get(pk.id).counter, 10);
});

test('the userHandle must name the passkey owner (no login as someone else with my passkey)', async () => {
    const yukiPk = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const gas = world({ credentials: [stored(yukiPk)] });
    for (const [label, userHandle, actions] of [
        ['handle of another user', ADMIN.userId, ['authGetCredential']],
        ['no handle', null, []],
        ['not a userId', 'not a user id!', []],
    ]) {
        const { challenge, cookie } = await loginOptions(gas);
        const res = await call('login/verify', { body: { response: yukiPk.assert({ challenge, origin: ORIGIN, userHandle }) }, challenge: cookie, gas });
        assert.equal(res.status, 401, label);
        assert.equal(res.json.error, 'VerificationFailed', label);
        assert.equal(res.sessionCookie, undefined, label);
        assert.deepEqual(res.actions, actions, label);
    }
});

test('login refuses revoked passkeys, foreign keys, wrong origin / rpID and missing user verification', async () => {
    const pk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const attacker = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    attacker.id = pk.id; // claims the victim's credential id, signs with its own key
    const gas = world({ credentials: [stored(pk)] });
    for (const [label, make] of [
        ['foreign key', c => attacker.assert({ challenge: c, origin: ORIGIN })],
        ['wrong origin', c => pk.assert({ challenge: c, origin: 'https://evil.example' })],
        ['wrong rpID', c => pk.assert({ challenge: c, origin: ORIGIN, rpIdOverride: 'evil.example' })],
        ['no user verification', c => pk.assert({ challenge: c, origin: ORIGIN, uv: false })],
        ['other challenge', () => pk.assert({ challenge: newChallenge(), origin: ORIGIN })],
        ['registration type', c => pk.assert({ challenge: c, origin: ORIGIN, type: 'webauthn.create' })],
    ]) {
        const { challenge, cookie } = await loginOptions(gas);
        const res = await call('login/verify', { body: { response: make(challenge) }, challenge: cookie, gas });
        assert.equal(res.status, 401, label);
        assert.equal(res.sessionCookie, undefined, label);
        assert.deepEqual(res.actions, ['authGetCredential'], label);
    }
    gas.state.credentials.get(pk.id).revoked = true;
    const { challenge, cookie } = await loginOptions(gas);
    const revoked = await call('login/verify', { body: { response: pk.assert({ challenge, origin: ORIGIN }) }, challenge: cookie, gas });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.error, 'VerificationFailed');
});

test('login refuses missing, expired and other-purpose challenges without calling GAS', async () => {
    const pk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const gas = world({ credentials: [stored(pk)] });
    const challenge = newChallenge();
    const response = pk.assert({ challenge, origin: ORIGIN });
    for (const [label, cookie] of [
        ['none', undefined],
        ['expired', await createChallengeToken(secret, { purpose: 'login', challenge, binding: '-' }, Date.now() - 301_000)],
        ['reauth purpose', await createChallengeToken(secret, { purpose: 'reauth', challenge, binding: ADMIN.userId })],
        ['add purpose', await createChallengeToken(secret, { purpose: 'add', challenge, binding: ADMIN.userId })],
        ['register purpose', await createChallengeToken(secret, { purpose: 'register', challenge, binding: sha256(INVITE) })],
        ['session token', await sessionOf(ADMIN)],
    ]) {
        const res = await call('login/verify', { body: { response }, challenge: cookie, gas });
        assert.equal(res.status, 400, label);
        assert.equal(res.json.error, 'ChallengeInvalid', label);
        assert.deepEqual(res.actions, [], label);
        assert.equal(res.sessionCookie, undefined, label);
    }
});

test('a failed use record (Busy) does not fail the login; returnTo is validated against the sources', async () => {
    const pk = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const gas = world({ credentials: [stored(pk)] });
    for (const [returnTo, expected] of [['/yahoo', '/yuki'], ['//evil.example', '/yuki'], ['/calendar', '/calendar'], ['/settings/passkeys', '/settings/passkeys']]) {
        gas.state.override.authRecordCredentialUse = { error: 'Busy' };
        const { challenge, cookie } = await loginOptions(gas);
        const res = await call('login/verify', { body: { response: pk.assert({ challenge, origin: ORIGIN }), returnTo }, challenge: cookie, gas });
        assert.equal(res.status, 200, returnTo);
        assert.equal(res.json.redirectTo, expected, returnTo);
        assert.ok(res.logs.some(line => line.includes('authRecordCredentialUse failed (Busy)')));
        assert.ok(res.logs.every(line => !line.includes(challenge)));
    }
});

// ---------------------------------------------------------------- adding a passkey

async function reauthFlow({ gas, session, pk, user }) {
    const opt = await call('passkeys/add/options', { session, gas });
    assert.equal(opt.status, 200);
    assert.equal(opt.json.mode, 'reauth');
    const reauth = await call('passkeys/add/reauth', {
        body: { response: pk.assert({ challenge: opt.json.options.challenge, origin: ORIGIN, userHandle: user.userId }) },
        session, challenge: opt.challengeCookie, gas,
    });
    return { opt, reauth };
}

test('adding a passkey: re-authentication with an existing passkey, then a NEW challenge for the registration (purpose add)', async () => {
    const pk1 = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const gas = world({ credentials: [stored(pk1)] });
    const session = await sessionOf(YUKI);
    const { opt, reauth } = await reauthFlow({ gas, session, pk: pk1, user: YUKI });
    assert.deepEqual(opt.json.options.allowCredentials.map(c => c.id), [pk1.id], 'only the user\'s own passkeys');
    assert.equal(opt.json.options.userVerification, 'required');
    assert.ok(await readChallengeToken(opt.challengeCookie, secret, { purposes: ['reauth'], binding: YUKI.userId }));
    assert.deepEqual(opt.bodies, [{ action: 'authListCredentials', actorUserId: YUKI.userId, actorEpoch: 0, key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY }]);

    assert.equal(reauth.status, 200);
    assert.deepEqual(reauth.actions, ['authGetCredential', 'authRecordCredentialUse', 'authListCredentials']);
    const regOptions = reauth.json.options;
    assert.notEqual(regOptions.challenge, opt.json.options.challenge, 'a new challenge');
    assert.equal(regOptions.user.id, b64u(YUKI.userId));
    assert.equal(regOptions.user.name, 'Yuki');
    assert.deepEqual(regOptions.excludeCredentials.map(c => c.id), [pk1.id]);
    assert.deepEqual(await readChallengeToken(reauth.challengeCookie, secret, { purposes: ['add'], binding: YUKI.userId }), { purpose: 'add', challenge: regOptions.challenge, binding: YUKI.userId });

    const pk2 = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const ver = await call('passkeys/add/verify', { body: { response: pk2.register({ challenge: regOptions.challenge, origin: ORIGIN }) }, session, challenge: reauth.challengeCookie, gas });
    assert.equal(ver.status, 200);
    assert.deepEqual(ver.json, { success: true, credentialCount: 2 });
    assert.ok(deleted(ver));
    const add = ver.bodies[0];
    assert.equal(add.action, 'authAddCredential');
    assert.equal(add.actorUserId, YUKI.userId);
    assert.equal(add.actorEpoch, 0);
    assert.equal(add.challengeHash, sha256(regOptions.challenge));
    assert.equal(add.bootstrap, undefined);
    assert.equal(add.credential.credentialId, pk2.id);
    assert.equal(gas.state.credentials.get(pk2.id).userId, YUKI.userId);
    assert.equal((await readSession(ver.sessionCookie, ENV)).amr, 'pk');
});

test('a password session that re-authenticates with a passkey becomes a passkey session', async () => {
    const pk1 = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const gas = world({ credentials: [stored(pk1)] });
    const session = await sessionOf(ADMIN, 'pwd');
    const { reauth } = await reauthFlow({ gas, session, pk: pk1, user: ADMIN });
    const pk2 = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const ver = await call('passkeys/add/verify', { body: { response: pk2.register({ challenge: reauth.json.options.challenge, origin: ORIGIN }) }, session, challenge: reauth.challengeCookie, gas });
    assert.equal(ver.status, 200);
    assert.deepEqual(await readSession(ver.sessionCookie, { SESSION_SECRET: secret }), { userId: ADMIN.userId, epoch: 2, sources: ['main', 'yahoo'], homeSource: 'main', amr: 'pk' });
});

test('re-authentication with another user\'s passkey is refused, even with a valid signature', async () => {
    const adminPk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const yukiPk = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const gas = world({ credentials: [stored(adminPk), stored(yukiPk)] });
    const session = await sessionOf(YUKI);
    for (const [label, userHandle, actions] of [['admin handle', ADMIN.userId, []], ['forged handle', YUKI.userId, ['authGetCredential']]]) {
        const opt = await call('passkeys/add/options', { session, gas });
        const res = await call('passkeys/add/reauth', {
            body: { response: adminPk.assert({ challenge: opt.json.options.challenge, origin: ORIGIN, userHandle }) },
            session, challenge: opt.challengeCookie, gas,
        });
        assert.equal(res.status, 401, label);
        assert.equal(res.json.error, 'VerificationFailed', label);
        assert.deepEqual(res.actions, actions, label);
        assert.ok(deleted(res), label);
        assert.equal(res.json.options, undefined);
    }
});

test('no passkey is added without the re-authentication challenge (reauth / login / foreign / expired cookies)', async () => {
    const pk1 = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const gas = world({ credentials: [stored(pk1)] });
    const session = await sessionOf(YUKI);
    const opt = await call('passkeys/add/options', { session, gas });
    const reauthChallenge = opt.json.options.challenge;
    const pk2 = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const signedOverReauth = pk2.register({ challenge: reauthChallenge, origin: ORIGIN });
    for (const [label, cookie] of [
        ['no cookie', undefined],
        ['the reauth cookie itself', opt.challengeCookie],
        ['login cookie', await createChallengeToken(secret, { purpose: 'login', challenge: reauthChallenge, binding: '-' })],
        ['add cookie of another user', await createChallengeToken(secret, { purpose: 'add', challenge: reauthChallenge, binding: ADMIN.userId })],
        ['expired add cookie', await createChallengeToken(secret, { purpose: 'add', challenge: reauthChallenge, binding: YUKI.userId }, Date.now() - 301_000)],
    ]) {
        const res = await call('passkeys/add/verify', { body: { response: signedOverReauth }, session, challenge: cookie, gas });
        assert.equal(res.status, 400, label);
        assert.equal(res.json.error, 'ChallengeInvalid', label);
        assert.deepEqual(res.actions, [], label);
    }
    // a valid add cookie, but the registration was made for another challenge
    const { reauth } = await reauthFlow({ gas, session, pk: pk1, user: YUKI });
    const res = await call('passkeys/add/verify', { body: { response: signedOverReauth }, session, challenge: reauth.challengeCookie, gas });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'VerificationFailed');
    assert.deepEqual(res.actions, []);
    assert.equal(gas.state.credentials.has(pk2.id), false);
});

test('the passkey add routes need a valid session (401, no GAS)', async () => {
    for (const path of ['passkeys/add/options', 'passkeys/add/reauth', 'passkeys/add/bootstrap', 'passkeys/add/verify']) {
        for (const session of [undefined, 'forged', await sessionOf(ADMIN, 'pwd')]) {
            const env = session && session !== 'forged' ? { APP_PASSWORD: undefined } : {};
            const res = await call(path, { body: { password }, session, env });
            assert.ok(res.status === 401 || (path === 'passkeys/add/bootstrap' && res.status === 404), `${path} ${String(session).slice(0, 8)}`);
            assert.deepEqual(res.actions, [], path);
        }
    }
});

test('a revoked session (GAS SessionRevoked) gets 401 and its cookie deleted', async () => {
    const pk1 = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const gas = world({ credentials: [stored(pk1)] });
    const stale = await sessionOf({ ...YUKI, epoch: 7 });
    const res = await call('passkeys/add/options', { session: stale, gas });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'Unauthorized');
    assert.ok(deleted(res, 'kakeibo_session'));
});

// ---------------------------------------------------------------- bootstrap

test('bootstrap: the admin without passkeys re-enters APP_PASSWORD; the add is flagged bootstrap and the session stays as it was', async () => {
    const gas = world();
    const session = await sessionOf(ADMIN, 'pwd');
    const opt = await call('passkeys/add/options', { session, gas });
    assert.deepEqual(opt.json, { mode: 'bootstrap' });
    assert.equal(opt.challengeCookie, undefined);

    const wrong = await call('passkeys/add/bootstrap', { body: { password: `${password}x` }, session, gas });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'Incorrect password');
    assert.deepEqual(wrong.actions, []);
    assert.equal(wrong.challengeCookie, undefined);

    const boot = await call('passkeys/add/bootstrap', { body: { password }, session, gas });
    assert.equal(boot.status, 200);
    assert.deepEqual(boot.actions, ['authListCredentials']);
    assert.deepEqual(boot.json.options.excludeCredentials, []);
    assert.equal(boot.json.options.user.id, b64u(ADMIN.userId));
    assert.ok(await readChallengeToken(boot.challengeCookie, secret, { purposes: ['bootstrap'], binding: ADMIN.userId }));
    assert.ok(JSON.stringify(boot.bodies).indexOf(password) === -1, 'the password never goes to GAS');

    const pk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const ver = await call('passkeys/add/verify', { body: { response: pk.register({ challenge: boot.json.options.challenge, origin: ORIGIN }) }, session, challenge: boot.challengeCookie, gas });
    assert.equal(ver.status, 200);
    assert.deepEqual(ver.json, { success: true, credentialCount: 1 });
    assert.equal(ver.bodies[0].bootstrap, true);
    assert.equal(ver.sessionCookie, undefined, 'a bootstrap does not upgrade the session');

    // from now on: re-authentication with the passkey, never the password
    const again = await call('passkeys/add/bootstrap', { body: { password }, session, gas });
    assert.equal(again.status, 403);
    assert.equal(again.json.error, 'NotAllowed');
    assert.equal(again.challengeCookie, undefined);
    assert.equal((await call('passkeys/add/options', { session, gas })).json.mode, 'reauth');
});

test('bootstrap is refused for members (GAS), after APP_PASSWORD is removed, and its challenge is not a passkey re-authentication', async () => {
    // a member without passkeys: Next.js lets the password through, GAS refuses the bootstrap
    const gas = world();
    const yukiSession = await sessionOf(YUKI, 'pwd');
    const boot = await call('passkeys/add/bootstrap', { body: { password }, session: yukiSession, gas });
    assert.equal(boot.status, 200);
    const pk = createSoftPasskey({ rpID: RP_ID, userId: YUKI.userId });
    const ver = await call('passkeys/add/verify', { body: { response: pk.register({ challenge: boot.json.options.challenge, origin: ORIGIN }) }, session: yukiSession, challenge: boot.challengeCookie, gas });
    assert.equal(ver.status, 403);
    assert.equal(ver.json.error, 'NotAllowed');
    assert.equal(gas.state.credentials.size, 0);

    // without APP_PASSWORD there is no bootstrap
    const noPassword = { APP_PASSWORD: undefined };
    const pkSession = await sessionOf(ADMIN, 'pk');
    const options = await call('passkeys/add/options', { session: pkSession, gas, env: noPassword });
    assert.equal(options.status, 403);
    assert.equal(options.json.error, 'NotAllowed');
    const route = await call('passkeys/add/bootstrap', { body: { password }, session: pkSession, gas, env: noPassword });
    assert.equal(route.status, 404);
    assert.deepEqual(route.actions, []);
    const challenge = newChallenge();
    const lateCookie = await createChallengeToken(secret, { purpose: 'bootstrap', challenge, binding: ADMIN.userId });
    const adminPk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const late = await call('passkeys/add/verify', { body: { response: adminPk.register({ challenge, origin: ORIGIN }) }, session: pkSession, challenge: lateCookie, gas, env: noPassword });
    assert.equal(late.status, 403);
    assert.deepEqual(late.actions, []);

    // the bootstrap challenge cannot stand in for a passkey re-authentication
    const reauth = await call('passkeys/add/reauth', { body: { response: adminPk.assert({ challenge, origin: ORIGIN }) }, session: pkSession, challenge: lateCookie, gas });
    assert.equal(reauth.status, 400);
    assert.equal(reauth.json.error, 'ChallengeInvalid');
});

test('responses and logs never carry challenges, tokens, passwords or GAS secrets', async () => {
    const pk = createSoftPasskey({ rpID: RP_ID, userId: ADMIN.userId });
    const gas = world({ credentials: [stored(pk)] });
    const secrets = [DUMMY_KEY, DUMMY_AUTH_KEY, password, INVITE, secret];
    const results = [];
    // a transport error that echoes the GAS secrets (they are redacted)
    for (const action of ['authGetCredential', 'authPeekInvite', 'authListCredentials']) gas.state.override[action] = new Error(`boom ${DUMMY_KEY} ${DUMMY_AUTH_KEY}`);
    const { challenge, cookie } = await loginOptions(gas);
    results.push(await call('login/verify', { body: { response: pk.assert({ challenge, origin: ORIGIN }) }, challenge: cookie, gas }));
    results.push(await call('register/options', { body: { token: INVITE }, gas }));
    results.push(await call('passkeys/add/bootstrap', { body: { password }, session: await sessionOf(ADMIN, 'pwd'), gas }));
    for (const res of results) {
        assert.equal(res.status, 503);
        assert.deepEqual(res.json, { error: 'Service Unavailable' });
        for (const s of [...secrets, challenge]) {
            assert.ok(res.logs.every(line => !line.includes(s)), res.logs.join(' | '));
        }
    }
});
