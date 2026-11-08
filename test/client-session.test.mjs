import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
    LOGGED_OUT_PATH, LOGIN_USER_KEY, SESSION_EXPIRED_PATH, clearKakeiboStorage, handleAppLocked, handleSessionExpired, handleUnauthorized,
    logout, rememberLoginUser, unauthorizedError,
} from '../lib/client-session.ts';

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
        // loggedOut=1: /login does not start Face ID by itself right after a logout
        assert.deepEqual(visited, [LOGGED_OUT_PATH]);
        assert.equal(LOGGED_OUT_PATH, '/login?loggedOut=1');
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
    assert.match(page, /\/api\/auth\/login\/verify/);
    // the app lock's idle clock restarts with the login (else the next screen would lock at once)
    assert.match(page, /rememberLoginUser\(storage, data\.userId\);\s*markAppActive\(storage\);\s*window\.location\.assign/);
    // the lock screen keeps the cache: only reason=session clears it
    assert.match(page, /if \(sessionEnded\) clearKakeiboStorage\(\);/);
    assert.match(page, /isLockedLanding\(searchParams\)/);
});

test('the invite registration restarts the app lock\'s idle clock', () => {
    const page = fs.readFileSync(new URL('../app/invite/page.tsx', import.meta.url), 'utf8');
    assert.match(page, /rememberLoginUser\(storage, result\.data\.userId\);\s*markAppActive\(storage\);/);
});

// ---------------------------------------------------------------- app lock: 401 Locked keeps the cache

const lockedLocation = (visited, pathname = '/yuki/calendar', search = '?month=2026-11') => ({ assign: url => visited.push(url), pathname, search });

test('a 401 Locked opens the lock screen for the current screen and keeps the cache; other 401s clear it', () => {
    const storage = memoryStorage(cached());
    const visited = [];
    handleAppLocked({ location: lockedLocation(visited) });
    assert.deepEqual(visited, ['/login?returnTo=%2Fyuki%2Fcalendar%3Fmonth%3D2026-11&reason=locked']);
    assert.equal(storage.keys().length, 5);

    handleUnauthorized('Locked', { storage, location: lockedLocation(visited, '/', '') });
    assert.equal(storage.keys().length, 5, 'Locked: same user, the cache stays');
    assert.equal(visited[1], '/login?returnTo=%2F&reason=locked');

    for (const error of ['Unauthorized', '', undefined, 'locked']) {
        const s = memoryStorage(cached());
        const v = [];
        handleUnauthorized(error, { storage: s, location: lockedLocation(v) });
        assert.deepEqual(s.keys(), ['other_app_key'], String(error));
        assert.deepEqual(v, ['/login?reason=session'], String(error));
    }
    handleAppLocked({ location: undefined }); // no browser: no throw
});

test('unauthorizedError reads the error word of a 401 body and never throws', async () => {
    assert.equal(await unauthorizedError(Response.json({ error: 'Locked' }, { status: 401 })), 'Locked');
    assert.equal(await unauthorizedError(Response.json({ error: 'Unauthorized' }, { status: 401 })), 'Unauthorized');
    assert.equal(await unauthorizedError(new Response('not json', { status: 401 })), '');
    assert.equal(await unauthorizedError(Response.json([1], { status: 401 })), '');
    assert.equal(await unauthorizedError({}), '', 'a stub without clone()');
    // the body is still readable by the caller
    const res = Response.json({ error: 'Locked' }, { status: 401 });
    await unauthorizedError(res);
    assert.deepEqual(await res.json(), { error: 'Locked' });
});

function withLockedBrowser(t, entries) {
    const storage = memoryStorage(entries);
    const visited = [];
    t.mock.property(globalThis, 'localStorage', storage);
    t.mock.property(globalThis, 'location', lockedLocation(visited));
    return { storage, visited };
}

test('fetchExpenses on 401 Locked keeps the cache, opens the lock screen and still fails', async (t) => {
    if (!('localStorage' in globalThis)) globalThis.localStorage = undefined;
    if (!('location' in globalThis)) globalThis.location = undefined;
    const { storage, visited } = withLockedBrowser(t, cached());
    const { fetchExpenses } = await import('../lib/api.ts');
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Locked' }, { status: 401 }));
    await assert.rejects(fetchExpenses('yuki'));
    assert.equal(storage.keys().length, 5);
    assert.deepEqual(visited, ['/login?returnTo=%2Fyuki%2Fcalendar%3Fmonth%3D2026-11&reason=locked']);
});

test('postWrite on 401 Locked keeps the cache, opens the lock screen and rejects (nothing was written)', async (t) => {
    if (!('localStorage' in globalThis)) globalThis.localStorage = undefined;
    if (!('location' in globalThis)) globalThis.location = undefined;
    const { storage, visited } = withLockedBrowser(t, cached());
    const { postWrite } = await import('../lib/write-queue.ts');
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Locked' }, { status: 401 }));
    await assert.rejects(postWrite({ action: 'addTransaction', source: 'yuki' }), /Locked/);
    assert.equal(storage.keys().length, 5);
    assert.deepEqual(visited, ['/login?returnTo=%2Fyuki%2Fcalendar%3Fmonth%3D2026-11&reason=locked']);
});

test('the settings screens treat 401 Locked like the lock (cache kept) and 401 Unauthorized like an ended session', () => {
    for (const file of ['app/settings/passkeys/page.tsx', 'app/settings/line/page.tsx']) {
        const page = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.match(page, /isSessionFailure\(result\)/, file);
        assert.match(page, /handleUnauthorized\(result\.data\.error\)/, file);
        assert.doesNotMatch(page, /handleSessionExpired\(\)/, file);
    }
});

test('the invite page records the new user (clearing another user\'s cache) and removes the token from the address bar', () => {
    const page = fs.readFileSync(new URL('../app/invite/page.tsx', import.meta.url), 'utf8');
    assert.match(page, /rememberLoginUser\(/);
    assert.match(page, /history\.replaceState\(null, '', '\/invite'\)/);
    assert.doesNotMatch(page, /console\./, 'the token is never logged');
});

test('in an in-app browser the invite token stays in the URL (needed by "Open in Safari"); elsewhere it is removed at once', () => {
    const page = fs.readFileSync(new URL('../app/invite/page.tsx', import.meta.url), 'utf8');
    // every replaceState on arrival is behind the decision
    assert.match(page, /if \(shouldClearInviteFragment\(navigator\.userAgent\)\) window\.history\.replaceState\(null, '', '\/invite'\);/);
    const onArrival = page.slice(page.indexOf('useEffect(() => {'), page.indexOf('}, []);'));
    assert.ok(onArrival.includes('shouldClearInviteFragment'));
    assert.doesNotMatch(onArrival, /^\s*window\.history\.replaceState\(null, '', '\/invite'\);\s*$/m, 'no unconditional replaceState on arrival');
    // after the registration the (consumed) token is dropped everywhere
    assert.match(page, /tokenRef\.current = null;[\s\S]{0,120}window\.history\.replaceState\(null, '', '\/invite'\);/);
    assert.match(page, /INVITE_MISSING_TOKEN_MESSAGE/);
    assert.match(page, /INVITE_IN_APP_BROWSER_NOTICE/);
});

test('/login has no password form any more (passkey only)', () => {
    const page = fs.readFileSync(new URL('../app/login/page.tsx', import.meta.url), 'utf8');
    const form = fs.readFileSync(new URL('../app/login/LoginForm.tsx', import.meta.url), 'utf8');
    for (const source of [page, form]) {
        assert.doesNotMatch(source, /type="password"|passwordEnabled|isPasswordLoginEnabled|\/api\/auth\/verify|パスワードでログイン|移行期間/);
    }
    assert.match(form, /顔認証でログイン/);
});

test('/settings/passkeys has no password bootstrap any more', () => {
    const page = fs.readFileSync(new URL('../app/settings/passkeys/page.tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(page, /type="password"|bootstrap|\/api\/auth\/passkeys\/add\/bootstrap/);
});
