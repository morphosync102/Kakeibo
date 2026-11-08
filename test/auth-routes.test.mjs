import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createSession, SESSION_TTL_SECONDS } from '../lib/session.ts';
import { loadRoute, setCookieValue } from './helpers/load-route.mjs';
import { legacyPasswordSession } from './helpers/legacy-session.mjs';

// Synthetic values only
const secret = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const DUMMY_KEY = 'dummy-gas-proxy-secret';
const DUMMY_AUTH_KEY = 'dummy-gas-auth-proxy-secret';
const ADMIN_USER = { userId: 'u_admin_synthetic', displayName: '管理者', role: 'admin', sources: ['main', 'yahoo'], homeSource: 'main', epoch: 4 };
// APP_PASSWORD may still be set on Vercel (the user keeps it): it must change nothing
const ENV = { SESSION_SECRET: secret, APP_PASSWORD: password, GAS_PROXY_SECRET: DUMMY_KEY, GAS_AUTH_PROXY_SECRET: DUMMY_AUTH_KEY, NODE_ENV: 'production' };

const loginRequest = (body, method = 'POST') => new Request('http://localhost/api/auth/verify', { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
const verifyRoute = (env = {}) =>
    loadRoute('app/api/auth/verify/route.ts', { env: { ...ENV, ...env }, upstream: () => ({ success: true, user: ADMIN_USER }) });

// ---------------------------------------------------------------- /api/expenses without middleware

test('GET and POST reject missing, v1-style, forged, expired and password sessions without invoking GAS', async () => {
    const issued = Math.floor(Date.now() / 1000);
    const v1 = `v1.${issued}.${issued + SESSION_TTL_SECONDS}.${'a'.repeat(32)}.${'b'.repeat(64)}`;
    const expired = await createSession(secret, { ...ADMIN_USER, amr: 'pk' }, Date.now() - (SESSION_TTL_SECONDS + 1) * 1000);
    const valid = await createSession(secret, { ...ADMIN_USER, amr: 'pk' });
    const pwd = legacyPasswordSession(secret, ADMIN_USER);
    for (const cookie of [undefined, 'authenticated', 'forged', v1, expired, valid + 'x', pwd]) {
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

// ---------------------------------------------------------------- the removed password login (U6)

test('/api/auth/verify always answers 404: even the correct APP_PASSWORD issues nothing and calls nothing', async () => {
    for (const env of [{}, { APP_PASSWORD: undefined }, { APP_PASSWORD: '' }]) {
        const route = await verifyRoute(env);
        for (const request of [
            loginRequest({ password }),
            loginRequest({ password, returnTo: '/yahoo' }),
            loginRequest({ password: 'wrong' }),
            loginRequest(null),
            new Request('http://localhost/api/auth/verify', { method: 'POST', body: 'not json' }),
        ]) {
            const response = await route.POST(request);
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { error: 'Not Found' });
            assert.equal(response.headers.get('set-cookie'), null);
            assert.equal(response.headers.get('cache-control'), 'no-store');
        }
        assert.equal((await route.GET(loginRequest(undefined, 'GET'))).status, 404);
        assert.equal(route.calls.length, 0, 'never GAS (authGetAdminUser)');
        assert.deepEqual(route.logs, []);
    }
});

test('the passkey-add bootstrap (password re-entry) route is gone', () => {
    assert.equal(fs.existsSync(new URL('../app/api/auth/passkeys/add/bootstrap/route.ts', import.meta.url)), false);
});

test('no application code reads APP_PASSWORD or compares a password any more', () => {
    const root = new URL('../', import.meta.url);
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
        }
    };
    for (const dir of ['app', 'lib', 'components', 'hooks']) if (fs.existsSync(new URL(dir, root))) walk(dir);
    files.push('middleware.ts');
    assert.ok(files.length > 20);
    for (const file of files) {
        const source = fs.readFileSync(new URL(file, root), 'utf8');
        assert.doesNotMatch(source, /APP_PASSWORD|isPasswordLoginEnabled|authGetAdminUser|constantTimeEqual\(password/, file);
    }
});

// ---------------------------------------------------------------- session info and logout

test('/api/auth/session returns sources and the home source only, never secrets', async () => {
    const yuki = { userId: 'u_member_synthetic', epoch: 1, sources: ['main', 'yuki'], homeSource: 'yuki' };
    const route = await loadRoute('app/api/auth/session/route.ts', { env: ENV, cookie: await createSession(secret, { ...yuki, amr: 'pk' }) });
    const response = await route.GET(new Request('http://localhost/api/auth/session'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { sources: ['yuki', 'main'], homeSource: 'yuki' });

    for (const cookie of [undefined, 'forged', legacyPasswordSession(secret, yuki)]) {
        const anonymous = await loadRoute('app/api/auth/session/route.ts', { env: ENV, cookie });
        assert.equal((await anonymous.GET(new Request('http://localhost/api/auth/session'))).status, 401);
    }
});

test('logout deletes the session cookie and the app lock\'s active cookie', async () => {
    const route = await loadRoute('app/api/auth/logout/route.ts', { env: ENV, cookie: await createSession(secret, { ...ADMIN_USER, amr: 'pk' }) });
    const response = await route.POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));
    assert.equal(response.status, 200);
    assert.equal(setCookieValue(response), '');
    const lines = response.headers.getSetCookie();
    for (const name of ['kakeibo_session', 'kakeibo_active']) {
        const line = lines.find(l => l.startsWith(`${name}=`));
        assert.ok(line, name);
        assert.match(line, /^[^=]+=;/, name);
        assert.match(line, /Path=\//, name);
        assert.match(line, /Max-Age=0|Expires=Thu, 01 Jan 1970/i, name);
    }
});
