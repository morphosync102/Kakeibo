import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { LOGIN_USER_KEY, SESSION_EXPIRED_PATH, clearKakeiboStorage, handleSessionExpired, logout, rememberLoginUser } from '../lib/client-session.ts';

// Map-backed Storage (the Web Storage API subset the module uses)
function memoryStorage(entries = {}) {
    const map = new Map(Object.entries(entries));
    return {
        get length() { return map.size; },
        key: i => [...map.keys()][i] ?? null,
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: k => { map.delete(k); },
        keys: () => [...map.keys()].sort(),
    };
}

const cached = () => ({
    kakeibo_expenses_cache: '[{"merchant":"synthetic"}]',
    kakeibo_expenses_cache_yahoo: '[]',
    kakeibo_expenses_cache_yuki: '[]',
    kakeibo_user: 'u_previous_synthetic',
    other_app_key: 'kept',
});

test('clearKakeiboStorage removes every kakeibo_ key and nothing else', () => {
    const storage = memoryStorage(cached());
    clearKakeiboStorage(storage);
    assert.deepEqual(storage.keys(), ['other_app_key']);
    clearKakeiboStorage(undefined); // no storage (server / blocked): no throw
    clearKakeiboStorage({ get length() { throw new Error('blocked'); } });
});

test('login: a different or unrecorded user clears the cache before being recorded; the same user keeps it', () => {
    const changed = memoryStorage(cached());
    rememberLoginUser(changed, 'u_next_synthetic');
    assert.deepEqual(changed.keys(), ['kakeibo_user', 'other_app_key']);
    assert.equal(changed.getItem(LOGIN_USER_KEY), 'u_next_synthetic');

    const { kakeibo_user: _omit, ...withoutUser } = cached();
    void _omit;
    const unrecorded = memoryStorage(withoutUser); // v1 / migration-period device
    rememberLoginUser(unrecorded, 'u_previous_synthetic');
    assert.deepEqual(unrecorded.keys(), ['kakeibo_user', 'other_app_key']);

    const same = memoryStorage(cached());
    rememberLoginUser(same, 'u_previous_synthetic');
    assert.deepEqual(same.keys(), memoryStorage(cached()).keys());
    assert.equal(LOGIN_USER_KEY, 'kakeibo_user');
});

test('an expired session clears the cache and goes to /login?reason=session', () => {
    const storage = memoryStorage(cached());
    const visited = [];
    handleSessionExpired({ storage, location: { assign: url => visited.push(url) } });
    assert.deepEqual(storage.keys(), ['other_app_key']);
    assert.deepEqual(visited, ['/login?reason=session']);
    assert.equal(SESSION_EXPIRED_PATH, '/login?reason=session');
});

test('logout deletes the cookie on the server, clears the cache and goes to /login even if the request fails', async () => {
    for (const fetchImpl of [async () => Response.json({ success: true }), async () => { throw new Error('offline'); }]) {
        const storage = memoryStorage(cached());
        const visited = [];
        const calls = [];
        await logout({ storage, location: { assign: url => visited.push(url) }, fetchImpl: async (...args) => { calls.push(args); return fetchImpl(); } });
        assert.equal(calls[0][0], '/api/auth/logout');
        assert.equal(calls[0][1].method, 'POST');
        assert.deepEqual(storage.keys(), ['other_app_key']);
        assert.deepEqual(visited, ['/login']);
    }
});

// fetchExpenses / postWrite use the browser globals
function withBrowserGlobals(t, entries) {
    const storage = memoryStorage(entries);
    const visited = [];
    t.mock.property(globalThis, 'localStorage', storage);
    t.mock.property(globalThis, 'location', { assign: url => visited.push(url) });
    return { storage, visited };
}

test('fetchExpenses on 401 clears the cache, goes to /login and still fails', async (t) => {
    if (!('localStorage' in globalThis)) globalThis.localStorage = undefined;
    if (!('location' in globalThis)) globalThis.location = undefined;
    const { storage, visited } = withBrowserGlobals(t, cached());
    const { fetchExpenses } = await import('../lib/api.ts');
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Unauthorized' }, { status: 401 }));
    await assert.rejects(fetchExpenses('main'));
    assert.deepEqual(storage.keys(), ['other_app_key']);
    assert.deepEqual(visited, ['/login?reason=session']);
});

test('fetchExpenses on 403 / 502 keeps the cache', async (t) => {
    if (!('localStorage' in globalThis)) globalThis.localStorage = undefined;
    if (!('location' in globalThis)) globalThis.location = undefined;
    const { storage, visited } = withBrowserGlobals(t, cached());
    const { fetchExpenses } = await import('../lib/api.ts');
    for (const status of [403, 502, 503]) {
        t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'x' }, { status }));
        await assert.rejects(fetchExpenses('main'));
    }
    assert.equal(storage.keys().length, 5);
    assert.deepEqual(visited, []);
});

test('postWrite on 401 clears the cache, goes to /login and rejects', async (t) => {
    if (!('localStorage' in globalThis)) globalThis.localStorage = undefined;
    if (!('location' in globalThis)) globalThis.location = undefined;
    const { storage, visited } = withBrowserGlobals(t, cached());
    const { postWrite } = await import('../lib/write-queue.ts');
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Unauthorized' }, { status: 401 }));
    await assert.rejects(postWrite({ action: 'addTransaction', source: 'main' }), /Unauthorized/);
    assert.deepEqual(storage.keys(), ['other_app_key']);
    assert.deepEqual(visited, ['/login?reason=session']);
});

test('the login page clears the cache for reason=session and records the user after a login', () => {
    const page = fs.readFileSync(new URL('../app/login/LoginForm.tsx', import.meta.url), 'utf8');
    assert.match(page, /searchParams\.get\('reason'\) === 'session'/);
    assert.match(page, /clearKakeiboStorage\(/);
    assert.match(page, /rememberLoginUser\(/);
    assert.doesNotMatch(page, /router\.push\(returnTo/, 'returnTo is validated by the server (redirectTo)');
    // both logins (password and passkey) go through the same housekeeping
    assert.match(page, /\/api\/auth\/login\/verify/);
    assert.match(page, /\/api\/auth\/verify/);
});

test('the invite page records the new user (clearing another user\'s cache) and removes the token from the address bar', () => {
    const page = fs.readFileSync(new URL('../app/invite/page.tsx', import.meta.url), 'utf8');
    assert.match(page, /rememberLoginUser\(/);
    assert.match(page, /history\.replaceState\(null, '', '\/invite'\)/);
    assert.doesNotMatch(page, /console\./, 'the token is never logged');
});

test('the password form of /login exists only while APP_PASSWORD is set (rendered per request)', () => {
    const page = fs.readFileSync(new URL('../app/login/page.tsx', import.meta.url), 'utf8');
    assert.match(page, /await connection\(\)/);
    assert.match(page, /isPasswordLoginEnabled\(process\.env\)/);
    const form = fs.readFileSync(new URL('../app/login/LoginForm.tsx', import.meta.url), 'utf8');
    assert.match(form, /\{passwordEnabled && \(/);
});
