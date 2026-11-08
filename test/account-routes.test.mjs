import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { createSession } from '../lib/session.ts';
import { lineLinkableSources } from '../lib/sources.ts';
import { loadRoute } from './helpers/load-route.mjs';
import { createFakeGas } from './helpers/fake-gas-auth.mjs';

// U4 (own passkeys: list / revoke / log out everywhere) and the U5 LINE
// linking routes, against the in-memory GAS. Synthetic values only.
const secret = randomBytes(32).toString('hex');
const DUMMY_KEY = 'dummy-gas-proxy-secret';
const DUMMY_AUTH_KEY = 'dummy-gas-auth-proxy-secret';
const ENV = { SESSION_SECRET: secret, APP_PASSWORD: 'synthetic-password', GAS_PROXY_SECRET: DUMMY_KEY, GAS_AUTH_PROXY_SECRET: DUMMY_AUTH_KEY, NODE_ENV: 'production' };
const ADMIN = { userId: 'u_admin_synthetic', displayName: '管理者', role: 'admin', sources: ['main', 'yahoo'], homeSource: 'main', epoch: 2 };
const YUKI = { userId: 'u_member_synthetic', displayName: 'Yuki', role: 'member', sources: ['yuki', 'main'], homeSource: 'yuki', epoch: 0 };
const LINE_USER = `U${'0123456789abcdef'.repeat(2)}`;

const cred = (id, userId) => ({ credentialId: id, userId, publicKey: 'AAAA', counter: 0, label: 'iPhone', createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: '2026-11-02T00:00:00.000Z' });
const world = () => createFakeGas({
    authKey: DUMMY_AUTH_KEY,
    users: [ADMIN, YUKI],
    credentials: [cred('cred_yuki_1', YUKI.userId), cred('cred_yuki_2', YUKI.userId), cred('cred_admin_1', ADMIN.userId)],
});
const sessionOf = (user, amr = 'pk') => createSession(secret, { ...user, amr });

async function call(path, { body = {}, session, gas, env = {} } = {}) {
    const route = await loadRoute(`app/api/${path}/route.ts`, { env: { ...ENV, ...env }, cookie: session, upstream: (gas ?? world()).upstream });
    const res = await route.POST(new Request(`http://localhost/api/${path}`, { method: 'POST', body: JSON.stringify(body) }));
    const setCookie = res.headers.get('set-cookie') ?? '';
    return {
        status: res.status,
        json: await res.json(),
        sessionDeleted: /kakeibo_session=;/.test(setCookie) && /Max-Age=0/i.test(setCookie),
        setCookie,
        bodies: route.calls.map(([, init]) => JSON.parse(init.body)),
        logs: route.logs,
        cacheControl: res.headers.get('cache-control'),
    };
}

// ---------------------------------------------------------------- U4: own passkeys

test('the passkey list is the session user\'s own (actor from the session, client fields ignored), without public keys', async () => {
    const gas = world();
    const res = await call('auth/passkeys/list', { session: await sessionOf(YUKI), gas, body: { actorUserId: ADMIN.userId } });
    assert.equal(res.status, 200);
    assert.equal(res.cacheControl, 'no-store');
    assert.deepEqual(res.bodies, [{ action: 'authListCredentials', actorUserId: YUKI.userId, actorEpoch: 0, key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY }]);
    assert.deepEqual(res.json.credentials.map(c => c.credentialId), ['cred_yuki_1', 'cred_yuki_2']);
    assert.deepEqual(Object.keys(res.json.credentials[0]).sort(), ['createdAt', 'credentialId', 'label', 'lastUsedAt', 'synced']);
    assert.equal(res.json.credentials[0].synced, true);
});

test('revoking: only an own passkey; success ends every session including this one (cookie deleted)', async () => {
    const gas = world();
    const session = await sessionOf(YUKI);
    // another user's passkey: GAS finds nothing for this actor
    const foreign = await call('auth/passkeys/revoke', { session, gas, body: { credentialId: 'cred_admin_1', actorUserId: ADMIN.userId, actorEpoch: 2 } });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.error, 'CredentialNotFound');
    assert.equal(foreign.bodies[0].actorUserId, YUKI.userId, 'the actor always comes from the session');
    assert.equal(gas.state.credentials.get('cred_admin_1').revoked, false);
    assert.equal(foreign.sessionDeleted, false);

    const own = await call('auth/passkeys/revoke', { session, gas, body: { credentialId: 'cred_yuki_1' } });
    assert.equal(own.status, 200);
    assert.deepEqual(own.json, { success: true, loggedOut: true });
    assert.ok(own.sessionDeleted, 'this session ends too (epoch +1)');
    assert.deepEqual(own.bodies, [{ action: 'authRevokeCredential', actorUserId: YUKI.userId, actorEpoch: 0, credentialId: 'cred_yuki_1', key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY }]);
    assert.equal(gas.state.credentials.get('cred_yuki_1').revoked, true);

    // the old session (old epoch) is now revoked in GAS
    const stale = await call('auth/passkeys/revoke', { session, gas, body: { credentialId: 'cred_yuki_2' } });
    assert.equal(stale.status, 401);
    assert.ok(stale.sessionDeleted);
    assert.equal(gas.state.credentials.get('cred_yuki_2').revoked, false);

    for (const body of [{}, { credentialId: '' }, { credentialId: 'a/b' }, { credentialId: 42 }]) {
        const bad = await call('auth/passkeys/revoke', { session: await sessionOf({ ...YUKI, epoch: 1 }), gas, body });
        assert.equal(bad.status, 400, JSON.stringify(body));
        assert.deepEqual(bad.bodies, []);
    }
});

test('log out everywhere bumps the own epoch and deletes this session cookie', async () => {
    const gas = world();
    const res = await call('auth/logout/all', { session: await sessionOf(ADMIN), gas, body: { actorUserId: YUKI.userId } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { success: true, loggedOut: true });
    assert.ok(res.sessionDeleted);
    assert.deepEqual(res.bodies, [{ action: 'authBumpEpoch', actorUserId: ADMIN.userId, actorEpoch: 2, key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY }]);
    assert.equal(gas.state.users.get(ADMIN.userId).epoch, 3);
    assert.equal(gas.state.users.get(YUKI.userId).epoch, 0, 'nobody else is affected');
});

test('U4 / U5 routes need a valid session (401, no GAS) and keep the cookie on GAS failures', async () => {
    const paths = ['auth/passkeys/list', 'auth/passkeys/revoke', 'auth/logout/all', 'auth/line-link/code', 'auth/line-link/status', 'auth/line-link/confirm'];
    for (const path of paths) {
        for (const session of [undefined, 'forged', await sessionOf(ADMIN, 'pwd')]) {
            const env = session && session !== 'forged' ? { APP_PASSWORD: undefined } : {};
            const res = await call(path, { session, env, body: { credentialId: 'cred_yuki_1', decision: 'confirm' } });
            assert.equal(res.status, 401, path);
            assert.deepEqual(res.bodies, [], path);
        }
        const gas = world();
        for (const action of Object.keys(gas.state.override)) delete gas.state.override[action];
        for (const action of ['authListCredentials', 'authRevokeCredential', 'authBumpEpoch', 'authCreateLineLinkCode', 'authGetLineLinkCandidate', 'authConfirmLineLink']) {
            gas.state.override[action] = new Error(`down ${DUMMY_KEY} ${DUMMY_AUTH_KEY}`);
        }
        const down = await call(path, { session: await sessionOf(YUKI), gas, body: { credentialId: 'cred_yuki_1', decision: 'confirm' } });
        assert.equal(down.status, 503, path);
        assert.deepEqual(down.json, { error: 'Service Unavailable' }, path);
        assert.equal(down.sessionDeleted, false, path);
        for (const s of [DUMMY_KEY, DUMMY_AUTH_KEY]) assert.ok(down.logs.every(line => !line.includes(s)), path);
    }
});

// ---------------------------------------------------------------- U5: LINE linking screen APIs

test('only users with a lineOptional source may link (the admin gets 403 without GAS)', async () => {
    assert.deepEqual(lineLinkableSources(YUKI.sources), ['yuki']);
    assert.deepEqual(lineLinkableSources(ADMIN.sources), []);
    for (const path of ['auth/line-link/code', 'auth/line-link/status', 'auth/line-link/confirm']) {
        const res = await call(path, { session: await sessionOf(ADMIN), body: { decision: 'confirm' } });
        assert.equal(res.status, 403, path);
        assert.equal(res.json.error, 'NotAllowed');
        assert.deepEqual(res.bodies, []);
    }
});

test('link flow: code (shown once, not logged) -> candidate display name -> confirm sets the own destination only', async () => {
    const gas = world();
    const session = await sessionOf(YUKI);
    const issued = await call('auth/line-link/code', { session, gas, body: { actorUserId: ADMIN.userId, source: 'main' } });
    assert.equal(issued.status, 200);
    assert.equal(issued.cacheControl, 'no-store');
    assert.deepEqual(issued.json, { code: 'ABCDEFGH23', expiresAt: '2026-11-08T00:10:00.000Z' });
    // the browser cannot pick the user nor the source
    assert.deepEqual(issued.bodies, [{ action: 'authCreateLineLinkCode', actorUserId: YUKI.userId, actorEpoch: 0, key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY }]);
    assert.ok(issued.logs.every(line => !line.includes('ABCDEFGH23')));

    const pending = await call('auth/line-link/status', { session, gas });
    assert.deepEqual(pending.json, { status: 'pending', expiresAt: '2026-11-08T00:10:00.000Z' });

    // a LINE user sends the code (webhook -> GAS authLinkLine)
    gas.upstream([null, { body: JSON.stringify({ action: 'authLinkLine', code: 'ABCDEFGH23', lineUserId: LINE_USER, authKey: DUMMY_AUTH_KEY }) }]);
    const candidate = await call('auth/line-link/status', { session, gas });
    assert.deepEqual(candidate.json, { status: 'candidate', displayName: 'Synthetic Name', expiresAt: '2026-11-08T00:20:00.000Z' });
    assert.ok(!JSON.stringify(candidate.json).includes(LINE_USER), 'the LINE userId never reaches the browser');
    assert.ok(candidate.logs.every(line => !line.includes('Synthetic Name')));

    // the admin cannot confirm Yuki's candidate (their own actor has none / no linkable source)
    const other = await call('auth/line-link/confirm', { session: await sessionOf(ADMIN), gas, body: { decision: 'confirm' } });
    assert.equal(other.status, 403);
    assert.equal(gas.state.destinations[YUKI.userId], undefined);

    const confirmed = await call('auth/line-link/confirm', { session, gas, body: { decision: 'confirm', actorUserId: ADMIN.userId } });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.json, { success: true, decision: 'confirm' });
    assert.deepEqual(confirmed.bodies, [{ action: 'authConfirmLineLink', actorUserId: YUKI.userId, actorEpoch: 0, decision: 'confirm', key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY }]);
    assert.equal(gas.state.destinations[YUKI.userId], LINE_USER);

    // nothing left to confirm
    const again = await call('auth/line-link/confirm', { session, gas, body: { decision: 'confirm' } });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'NoCandidate');
});

test('cancel drops the candidate without setting a destination; bad decisions never reach GAS', async () => {
    const gas = world();
    const session = await sessionOf(YUKI);
    await call('auth/line-link/code', { session, gas });
    gas.upstream([null, { body: JSON.stringify({ action: 'authLinkLine', code: 'ABCDEFGH23', lineUserId: LINE_USER, authKey: DUMMY_AUTH_KEY }) }]);
    for (const decision of [undefined, 'yes', 'CONFIRM', 1]) {
        const bad = await call('auth/line-link/confirm', { session, gas, body: { decision } });
        assert.equal(bad.status, 400, String(decision));
        assert.deepEqual(bad.bodies, []);
    }
    const cancelled = await call('auth/line-link/confirm', { session, gas, body: { decision: 'cancel' } });
    assert.deepEqual(cancelled.json, { success: true, decision: 'cancel' });
    assert.equal(gas.state.destinations[YUKI.userId], undefined);
    assert.deepEqual((await call('auth/line-link/status', { session, gas })).json, { status: 'none' });
});

test('LINE link errors: SessionRevoked deletes the cookie, ProfileUnavailable / Forbidden are fixed words', async () => {
    const gas = world();
    const stale = await call('auth/line-link/code', { session: await sessionOf({ ...YUKI, epoch: 5 }), gas });
    assert.equal(stale.status, 401);
    assert.ok(stale.sessionDeleted);
    gas.state.override.authGetLineLinkCandidate = { error: 'ProfileUnavailable' };
    const profile = await call('auth/line-link/status', { session: await sessionOf(YUKI), gas });
    assert.equal(profile.status, 503);
    assert.equal(profile.json.error, 'ProfileUnavailable');
    gas.state.override.authCreateLineLinkCode = { error: 'Forbidden' };
    const forbidden = await call('auth/line-link/code', { session: await sessionOf(YUKI), gas });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error, 'NotAllowed');
    gas.state.override.authCreateLineLinkCode = { success: true, code: '=HYPERLINK', expiresAt: 'x' };
    const badCode = await call('auth/line-link/code', { session: await sessionOf(YUKI), gas });
    assert.equal(badCode.status, 503);
});

test('the account screens: revoke / log out everywhere clear the cache; the LINE link entry is shown only for lineOptional kakeibo', () => {
    const passkeys = fs.readFileSync(new URL('../app/settings/passkeys/page.tsx', import.meta.url), 'utf8');
    assert.match(passkeys, /\/api\/auth\/passkeys\/revoke/);
    assert.match(passkeys, /\/api\/auth\/logout\/all/);
    assert.match(passkeys, /void logout\(\)/, 'cache cleared and /login (lib/client-session logout)');
    const manage = fs.readFileSync(new URL('../components/ManageView.tsx', import.meta.url), 'utf8');
    assert.match(manage, /sourceInfo\.lineOptional && \(/);
    assert.match(manage, /href="\/settings\/line"/);
});
