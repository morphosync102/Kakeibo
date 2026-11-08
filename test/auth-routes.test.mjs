import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { createSession, readSession, SESSION_TTL_SECONDS } from '../lib/session.ts';
import { loadRoute, setCookieValue } from './helpers/load-route.mjs';

// Synthetic values only
const secret = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const DUMMY_KEY = 'dummy-gas-proxy-secret';
const DUMMY_AUTH_KEY = 'dummy-gas-auth-proxy-secret';
const ADMIN_USER = { userId: 'u_admin_synthetic', displayName: '管理者', role: 'admin', sources: ['main', 'yahoo'], homeSource: 'main', epoch: 4 };
const ENV = { SESSION_SECRET: secret, APP_PASSWORD: password, GAS_PROXY_SECRET: DUMMY_KEY, GAS_AUTH_PROXY_SECRET: DUMMY_AUTH_KEY, NODE_ENV: 'production' };

const loginRequest = (body) => new Request('http://localhost/api/auth/verify', { method: 'POST', body: JSON.stringify(body) });
const verifyRoute = (upstream = () => ({ success: true, user: ADMIN_USER }), env = {}) =>
    loadRoute('app/api/auth/verify/route.ts', { env: { ...ENV, ...env }, upstream });

// ---------------------------------------------------------------- /api/expenses without middleware

test('GET and POST reject missing, v1-style, forged and expired sessions without invoking GAS', async () => {
    const issued = Math.floor(Date.now() / 1000);
    const v1 = `v1.${issued}.${issued + SESSION_TTL_SECONDS}.${'a'.repeat(32)}.${'b'.repeat(64)}`;
    const expired = await createSession(secret, { ...ADMIN_USER, amr: 'pk' }, Date.now() - (SESSION_TTL_SECONDS + 1) * 1000);
    const valid = await createSession(secret, { ...ADMIN_USER, amr: 'pk' });
    for (const cookie of [undefined, 'authenticated', 'forged', v1, expired, valid + 'x']) {
        const route = await loadRoute('app/api/expenses/route.ts', { env: ENV, cookie });
        for (const res of [
            await route.GET(new Request('http://localhost/api/expenses?source=main')),
            await route.GET(new Request('http://localhost/api/expenses?fresh=1')),
            await route.POST(new Request('http://localhost/api/expenses', { method: 'POST', body: '{"action":"addTransaction","source":"main"}' })),
        ]) {
            assert.equal(res.status, 401, String(cookie));
        }
        assert.equal(route.calls.length, 0);
    }
    const missingKey = await loadRoute('app/api/expenses/route.ts', { env: { ...ENV, SESSION_SECRET: undefined }, cookie: valid });
    assert.equal((await missingKey.GET(new Request('http://localhost/api/expenses'))).status, 401);
    assert.equal(missingKey.calls.length, 0);
});

// ---------------------------------------------------------------- password login

test('the correct password issues a v2 admin session (amr=pwd) from authGetAdminUser with secure cookie attributes', async () => {
    const route = await verifyRoute();
    const response = await route.POST(loginRequest({ password }));
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=strict/i);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
    assert.deepEqual(await readSession(setCookieValue(response), ENV), { userId: ADMIN_USER.userId, epoch: 4, sources: ['main', 'yahoo'], homeSource: 'main', amr: 'pwd' });
    assert.deepEqual(await response.json(), { success: true, userId: ADMIN_USER.userId, redirectTo: '/' });
    assert.equal(response.headers.get('cache-control'), 'no-store');

    // the GAS call: authGetAdminUser with key and authKey, nothing from the client
    assert.equal(route.calls.length, 1);
    const [url, init] = route.calls[0];
    assert.equal(url, 'http://localhost/synthetic-upstream');
    assert.equal(init.method, 'POST');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(JSON.parse(init.body), { action: 'authGetAdminUser', key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY });
});

test('login validates returnTo against the session sources (redirectTo)', async () => {
    const route = await verifyRoute();
    for (const [returnTo, expected] of [['/yahoo/calendar', '/yahoo/calendar'], ['//evil.example', '/'], ['/yuki', '/'], ['https://evil.example', '/'], [42, '/']]) {
        const response = await route.POST(loginRequest({ password, returnTo }));
        assert.equal((await response.json()).redirectTo, expected, String(returnTo));
    }
});

test('a wrong or malformed password never calls GAS nor sets a cookie', async () => {
    const route = await verifyRoute();
    for (const body of [{ password: null }, { password: {} }, { password: randomBytes(12).toString('hex') }, { password: password + 'x' }, { password: password.slice(0, -1) }, { password: 'x'.repeat(2000) }, {}, null]) {
        const response = await route.POST(loginRequest(body));
        assert.ok(response.status === 400 || response.status === 401, JSON.stringify(body));
        assert.equal(response.headers.get('set-cookie'), null);
    }
    const garbage = await route.POST(new Request('http://localhost/api/auth/verify', { method: 'POST', body: 'not json' }));
    assert.equal(garbage.status, 400);
    assert.equal(route.calls.length, 0);
});

test('the password is compared in constant time (no ===/!== on the password)', () => {
    const source = fs.readFileSync(new URL('../app/api/auth/verify/route.ts', import.meta.url), 'utf8');
    assert.match(source, /constantTimeEqual\(/);
    assert.doesNotMatch(source, /APP_PASSWORD\s*[!=]==|[!=]==\s*(env\.|process\.env\.)?APP_PASSWORD|password\s*[!=]==\s*(env|process|correct|expected)/);
});

test('without APP_PASSWORD password login is disabled (404) and calls nothing', async () => {
    for (const value of [undefined, '']) {
        const route = await verifyRoute(undefined, { APP_PASSWORD: value });
        const response = await route.POST(loginRequest({ password: 'anything' }));
        assert.equal(response.status, 404);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(route.calls.length, 0);
    }
});

test('no session without a single valid admin row: GAS errors, 0 / several admins, failures and bad rows', async () => {
    const cases = [
        [() => ({ error: 'AdminNotFound' }), 500],
        [() => ({ error: 'AdminAmbiguous' }), 500],
        [() => ({ error: 'AuthUnavailable' }), 503],
        [() => ({ error: 'Unauthorized' }), 503],
        [() => ({ error: 'Busy' }), 503],
        [() => { throw new Error('connect failed'); }, 503],
        [() => ({}), 503],
        [() => [], 503],
        [() => ({ success: true }), 500],
        [() => ({ success: true, user: { ...ADMIN_USER, userId: 'bad id' } }), 500],
        [() => ({ success: true, user: { ...ADMIN_USER, epoch: -1 } }), 500],
        [() => ({ success: true, user: { ...ADMIN_USER, sources: ['main', 'other'] } }), 500],
        [() => ({ success: true, user: { ...ADMIN_USER, sources: [] } }), 500],
        [() => ({ success: true, user: { ...ADMIN_USER, homeSource: 'yuki' } }), 500],
        [() => ({ success: true, user: { ...ADMIN_USER, role: 'member' } }), 500],
    ];
    for (const [upstream, status] of cases) {
        const route = await verifyRoute(upstream);
        const response = await route.POST(loginRequest({ password }));
        assert.equal(response.status, status, String(upstream));
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(route.calls.length, 1);
    }
});

test('missing server configuration fails closed without calling GAS', async () => {
    for (const env of [{ SESSION_SECRET: undefined }, { SESSION_SECRET: 'short' }, { GAS_AUTH_PROXY_SECRET: undefined }, { GAS_API_URL: '' }]) {
        const route = await verifyRoute(undefined, env);
        const response = await route.POST(loginRequest({ password }));
        assert.ok(response.status >= 500, JSON.stringify(env));
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(route.calls.length, 0);
    }
});

test('login failures never log the password or secrets', async () => {
    const route = await verifyRoute(() => { throw new Error(`failed ${DUMMY_KEY} ${DUMMY_AUTH_KEY}`); });
    await route.POST(loginRequest({ password }));
    await route.POST(loginRequest({ password: password + 'x' }));
    assert.ok(route.logs.length > 0);
    for (const s of [password, DUMMY_KEY, DUMMY_AUTH_KEY]) assert.ok(route.logs.every(line => !line.includes(s)), route.logs.join(' | '));
});

// ---------------------------------------------------------------- session info and logout

test('/api/auth/session returns sources and the home source only, never secrets', async () => {
    const yuki = { userId: 'u_member_synthetic', epoch: 1, sources: ['main', 'yuki'], homeSource: 'yuki' };
    const route = await loadRoute('app/api/auth/session/route.ts', { env: ENV, cookie: await createSession(secret, { ...yuki, amr: 'pk' }) });
    const response = await route.GET(new Request('http://localhost/api/auth/session'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { sources: ['yuki', 'main'], homeSource: 'yuki' });

    for (const cookie of [undefined, 'forged']) {
        const anonymous = await loadRoute('app/api/auth/session/route.ts', { env: ENV, cookie });
        assert.equal((await anonymous.GET(new Request('http://localhost/api/auth/session'))).status, 401);
    }
    const pwdWithoutPassword = await loadRoute('app/api/auth/session/route.ts', { env: { ...ENV, APP_PASSWORD: undefined }, cookie: await createSession(secret, { ...yuki, amr: 'pwd' }) });
    assert.equal((await pwdWithoutPassword.GET(new Request('http://localhost/api/auth/session'))).status, 401);
});

test('logout deletes the session cookie', async () => {
    const route = await loadRoute('app/api/auth/logout/route.ts', { env: ENV, cookie: await createSession(secret, { ...ADMIN_USER, amr: 'pk' }) });
    const response = await route.POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));
    assert.equal(response.status, 200);
    assert.equal(setCookieValue(response), '');
    assert.match(response.headers.get('set-cookie'), /Path=\//);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
});
