import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideAccess, homePath, isLockExemptPath, isPublicPath, postLoginPath, refreshesActivity, safeReturnTo, sourceChoices, switchSourceHref } from '../lib/access.ts';
import { tabFromPathname } from '../lib/sources.ts';

// Synthetic sessions (as readSession returns them: home source first)
const admin = { userId: 'u_admin_synthetic', epoch: 0, sources: ['main', 'yahoo'], homeSource: 'main', amr: 'pk' };
const yuki = { userId: 'u_member_synthetic', epoch: 0, sources: ['yuki', 'main'], homeSource: 'yuki', amr: 'pk' };

const decide = (session, pathname, search = '', active = true) => decideAccess({ pathname, search, session, active });
const show = d => (d.kind === 'redirect' ? `-> ${d.location}` : d.kind === 'login' ? `login(${d.returnTo})` : d.kind === 'locked' ? `locked(${d.returnTo})` : d.kind);

// design §8.3: screens (API sources are checked by the proxy, see expenses-proxy.test.mjs)
const PAGE_TABLE = [
    // path,                 admin,         yuki,           logged out
    ['/', 'allow', 'allow', 'login(/)'],
    ['/statistics', 'allow', 'allow', 'login(/statistics)'],
    ['/calendar', 'allow', 'allow', 'login(/calendar)'],
    ['/manage', 'allow', 'allow', 'login(/manage)'],
    ['/yahoo', 'allow', '-> /yuki', 'login(/yahoo)'],
    ['/yahoo/statistics', 'allow', '-> /yuki', 'login(/yahoo/statistics)'],
    ['/yahoo/manage', 'allow', '-> /yuki', 'login(/yahoo/manage)'],
    ['/yuki', '-> /', 'allow', 'login(/yuki)'],
    ['/yuki/calendar', '-> /', 'allow', 'login(/yuki/calendar)'],
    ['/yuki/manage', '-> /', 'allow', 'login(/yuki/manage)'],
    // does not exist: logged-in users get Next's 404 (main is allowed), others the login page
    ['/admin/users', 'allow', 'allow', 'login(/admin/users)'],
    // look-alikes of public paths stay protected
    ['/loginX', 'allow', 'allow', 'login(/loginX)'],
    ['/login/x', 'allow', 'allow', 'login(/login/x)'],
    ['/invites', 'allow', 'allow', 'login(/invites)'],
    ['/yukiX', 'allow', 'allow', 'login(/yukiX)'],
    ['/image.png.html', 'allow', 'allow', 'login(/image.png.html)'],
];

test('screens: each user reaches only their sources; others go home; logged out goes to /login', () => {
    for (const [path, adminExpected, yukiExpected, anonExpected] of PAGE_TABLE) {
        assert.equal(show(decide(admin, path)), adminExpected, `admin ${path}`);
        assert.equal(show(decide(yuki, path)), yukiExpected, `yuki ${path}`);
        assert.equal(show(decide(null, path)), anonExpected, `anonymous ${path}`);
    }
});

test('the login redirect keeps the query in returnTo', () => {
    assert.deepEqual(decide(null, '/yuki/calendar', '?x=1'), { kind: 'login', returnTo: '/yuki/calendar?x=1' });
});

test('protected APIs need a session (401); their source checks are the proxy\'s', () => {
    for (const path of ['/api/expenses', '/api/auth/session', '/api/auth/logout', '/api/auth/passkeys', '/api/auth/passkeys/add/options', '/api/auth/line-link', '/api/admin/users', '/api/auth/registerX', '/api/auth/login']) {
        assert.equal(decide(null, path).kind, 'unauthorized', path);
        assert.equal(decide(admin, path).kind, 'allow', path);
        assert.equal(decide(yuki, path).kind, 'allow', path);
    }
});

test('public paths are reachable without a session; look-alikes are not public', () => {
    const publicPaths = [
        '/login', '/invite',
        '/api/auth/verify',
        '/api/auth/register/options', '/api/auth/register/verify',
        '/api/auth/login/options', '/api/auth/login/verify',
        '/api/line/webhook',
        '/manifest.webmanifest', '/yahoo-manifest.json', '/yuki-manifest.json',
        '/image.png', '/icon.png', '/apple-icon.png', '/favicon.ico',
        '/_next/static/chunks/x.js', '/_next/image',
    ];
    for (const path of publicPaths) {
        assert.equal(isPublicPath(path), true, path);
        assert.equal(decide(null, path).kind, 'allow', path);
    }
    for (const path of ['/', '/loginX', '/login/', '/login/x', '/invite/x', '/api/auth/verifyX', '/api/auth/register', '/api/auth/loginX/options', '/api/line/webhookX', '/api/line/webhook/x', '/yuki-manifest.jsonX', '/api/auth/session', '/api/auth/logout', '/_nextX/static']) {
        assert.equal(isPublicPath(path), false, path);
    }
});

test('a password session reaches the middleware as null (readSession) and is sent to /login', () => {
    // readSession always returns null for it (test/session.test.mjs); every path then behaves as logged out
    for (const [path, , , anonExpected] of PAGE_TABLE) assert.equal(show(decide(null, path)), anonExpected);
});

// ---------------------------------------------------------------- app lock (§3.12)

test('app lock: a valid session without the active cookie is locked on every protected screen and API, before the source check', () => {
    for (const [path, , , anonExpected] of PAGE_TABLE) {
        for (const session of [admin, yuki]) {
            assert.equal(show(decide(session, path, '', false)), `locked(${path})`, `${session.userId} ${path}`);
        }
        // no session: still the session login (the lock needs a session first)
        assert.equal(show(decide(null, path, '', false)), anonExpected);
    }
    assert.deepEqual(decide(yuki, '/yuki/calendar', '?month=2026-11', false), { kind: 'locked', returnTo: '/yuki/calendar?month=2026-11' });
    // a screen of another source is locked too (nothing is revealed before Face ID)
    assert.equal(show(decide(yuki, '/yahoo', '', false)), 'locked(/yahoo)');
    for (const path of ['/settings/passkeys', '/settings/line']) assert.equal(show(decide(yuki, path, '', false)), `locked(${path})`);
    for (const path of ['/api/expenses', '/api/auth/session', '/api/auth/passkeys/list', '/api/auth/passkeys/add/options', '/api/auth/logout/all', '/api/auth/line-link/status']) {
        assert.equal(decide(admin, path, '', false).kind, 'lockedApi', path);
        assert.equal(decide(null, path, '', false).kind, 'unauthorized', path);
    }
});

test('app lock: public paths are never locked; logging out of this device works while locked', () => {
    for (const path of ['/login', '/invite', '/api/auth/verify', '/api/auth/login/options', '/api/auth/login/verify', '/api/auth/register/verify', '/api/line/webhook', '/manifest.webmanifest', '/yuki-manifest.json', '/icon.png', '/apple-icon.png', '/favicon.ico', '/_next/static/x.js']) {
        assert.equal(decide(admin, path, '', false).kind, 'allow', path);
        assert.equal(refreshesActivity(path), false, `${path} does not slide the lock window`);
    }
    assert.equal(isLockExemptPath('/api/auth/logout'), true);
    assert.equal(decide(admin, '/api/auth/logout', '', false).kind, 'allow');
    assert.equal(refreshesActivity('/api/auth/logout'), false);
    for (const path of ['/api/auth/logout/all', '/api/auth/logoutX', '/logout']) assert.equal(isLockExemptPath(path), false, path);
    for (const path of ['/', '/yuki/calendar', '/settings/passkeys', '/api/expenses', '/api/auth/session']) assert.equal(refreshesActivity(path), true, path);
});

test('account screens (/settings/*) are open to any session, whatever its sources, and protected without one', () => {
    const yukiOnly = { userId: 'u_other_synthetic', epoch: 0, sources: ['yuki'], homeSource: 'yuki', amr: 'pk' };
    for (const session of [admin, yuki, yukiOnly]) {
        assert.equal(show(decide(session, '/settings/passkeys')), 'allow');
        assert.equal(safeReturnTo('/settings/passkeys', session.sources), '/settings/passkeys');
    }
    assert.equal(show(decide(null, '/settings/passkeys')), 'login(/settings/passkeys)');
    assert.equal(isPublicPath('/settings/passkeys'), false);
    // look-alikes are still screens of main
    assert.equal(show(decide(yukiOnly, '/settingsX')), '-> /yuki');
});

test('home paths: admin -> /, Yuki -> /yuki', () => {
    assert.equal(homePath(admin), '/');
    assert.equal(homePath(yuki), '/yuki');
});

test('returnTo accepts only same-origin relative paths of an allowed source', () => {
    const accepted = [
        ['/', admin, '/'],
        ['/statistics', yuki, '/statistics'],
        ['/yahoo/calendar?month=1', admin, '/yahoo/calendar?month=1'],
        ['/yuki/manage', yuki, '/yuki/manage'],
    ];
    for (const [value, session, expected] of accepted) assert.equal(safeReturnTo(value, session.sources), expected, value);
    const rejected = [
        ['//evil.example', admin], ['/\\evil.example', admin], ['\\\\evil.example', admin],
        ['https://evil.example/', admin], ['http:/evil.example', admin], ['javascript:alert(1)', admin],
        ['evil', admin], ['', admin], [null, admin], [undefined, admin], [42, admin],
        ['/\t/evil.example', admin], ['/\n/evil.example', admin], ['/\u0000/x', admin],
        ['/yahoo', yuki], ['/yahoo/statistics', yuki], ['/yuki', admin],
        ['/login', admin], ['/api/expenses', admin], ['/' + 'a'.repeat(2048), admin],
    ];
    for (const [value, session] of rejected) assert.equal(safeReturnTo(value, session.sources), null, JSON.stringify(value));
});

test('after login: a valid returnTo, else the home of the user', () => {
    assert.equal(postLoginPath(undefined, admin), '/');
    assert.equal(postLoginPath(undefined, yuki), '/yuki');
    assert.equal(postLoginPath('/yahoo', yuki), '/yuki');
    assert.equal(postLoginPath('//evil.example', yuki), '/yuki');
    assert.equal(postLoginPath('/calendar', yuki), '/calendar');
    assert.equal(postLoginPath('/yuki', admin), '/');
    assert.equal(postLoginPath('/yahoo/manage', admin), '/yahoo/manage');
});

// ---------------------------------------------------------------- kakeibo switcher (§4.1)

test('the switcher is shown for two or more sources, home first, with registry labels', () => {
    assert.deepEqual(sourceChoices(yuki.sources), [{ id: 'yuki', label: 'Yuki' }, { id: 'main', label: '家庭用' }]);
    assert.deepEqual(sourceChoices(admin.sources), [{ id: 'main', label: '家庭用' }, { id: 'yahoo', label: '個人用' }]);
    assert.deepEqual(sourceChoices(['yuki']), [{ id: 'yuki', label: 'Yuki' }], 'one source: the caller hides the switcher');
    assert.deepEqual(sourceChoices(['main', 'other']), [{ id: 'main', label: '家庭用' }]);
});

test('switching keeps the tab', () => {
    const cases = [
        ['/', 'yuki', '/yuki'],
        ['/calendar', 'yuki', '/yuki/calendar'],
        ['/yuki/calendar', 'main', '/calendar'],
        ['/yuki/statistics', 'main', '/statistics'],
        ['/yahoo/manage', 'main', '/manage'],
        ['/manage', 'yahoo', '/yahoo/manage'],
        ['/yuki', 'main', '/'],
        ['/unknown', 'yuki', '/yuki'],
    ];
    for (const [from, to, expected] of cases) assert.equal(switchSourceHref(from, to), expected, `${from} -> ${to}`);
    assert.equal(tabFromPathname('/yuki/calendar'), 'calendar');
    assert.equal(tabFromPathname('/calendarX'), 'home');
});

// ---------------------------------------------------------------- middleware.ts itself

test('middleware: login redirect with reason=session (deleting an invalid cookie), home redirect, API 401', async () => {
    const { randomBytes } = await import('node:crypto');
    const { NextRequest } = await import('next/server.js');
    const { createSession } = await import('../lib/session.ts');
    const { loadRoute } = await import('./helpers/load-route.mjs');
    const secret = randomBytes(32).toString('hex');
    const { createActiveToken } = await import('../lib/active-session.ts');
    const mw = await loadRoute('middleware.ts', { env: { SESSION_SECRET: secret } });
    const yukiUser = { userId: 'u_member_synthetic', epoch: 0, sources: ['yuki', 'main'], homeSource: 'yuki' };
    const yukiActive = await createActiveToken(secret, yukiUser);
    // a valid session is sent with its active cookie (an unlocked device)
    const run = (path, cookie) => mw.middleware(new NextRequest(`http://localhost${path}`, {
        headers: cookie ? { cookie: `kakeibo_session=${cookie}${cookie === 'forged' ? '' : `; kakeibo_active=${yukiActive}`}` } : {},
    }));

    const anonymous = await run('/yuki/calendar?x=1');
    assert.equal(anonymous.status, 307);
    const location = new URL(anonymous.headers.get('location'));
    assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('returnTo'), '/yuki/calendar?x=1');
    assert.equal(location.searchParams.get('reason'), 'session');
    assert.equal(anonymous.headers.get('set-cookie'), null, 'no cookie, nothing to delete');

    const invalid = await run('/', 'forged');
    assert.equal(invalid.status, 307);
    assert.match(invalid.headers.get('set-cookie'), /kakeibo_session=;/);

    const yukiCookie = await createSession(secret, { ...yukiUser, amr: 'pk' });
    const forbidden = await run('/yahoo/manage', yukiCookie);
    assert.equal(forbidden.status, 307);
    assert.equal(new URL(forbidden.headers.get('location')).pathname, '/yuki');
    assert.doesNotMatch(forbidden.headers.get('set-cookie') ?? '', /kakeibo_session=/, 'the session is kept');
    assert.equal((await run('/yuki', yukiCookie)).headers.get('x-middleware-next'), '1');
    assert.equal((await run('/login')).headers.get('x-middleware-next'), '1');

    const api = await run('/api/expenses?source=main', 'forged');
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: 'Unauthorized' });
});

test('middleware app lock: locked screens go to /login?reason=locked keeping the session; locked APIs get 401 Locked; passing requests slide the window', async () => {
    const { randomBytes } = await import('node:crypto');
    const { NextRequest } = await import('next/server.js');
    const { createSession } = await import('../lib/session.ts');
    const { ACTIVE_TTL_SECONDS, createActiveToken, isActiveTokenValid } = await import('../lib/active-session.ts');
    const { loadRoute } = await import('./helpers/load-route.mjs');
    const secret = randomBytes(32).toString('hex');
    const mw = await loadRoute('middleware.ts', { env: { SESSION_SECRET: secret, NODE_ENV: 'production' } });
    const user = { userId: 'u_member_synthetic', epoch: 3, sources: ['yuki', 'main'], homeSource: 'yuki' };
    const session = await createSession(secret, { ...user, amr: 'pk' });
    const run = (path, cookies, headers = {}) => mw.middleware(new NextRequest(`http://localhost${path}`, {
        headers: { cookie: Object.entries(cookies).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
    }));
    const setCookies = res => Object.fromEntries(res.headers.getSetCookie().map(line => {
        const [pair, ...attrs] = line.split(';');
        const i = pair.indexOf('=');
        return [pair.slice(0, i).trim(), { value: decodeURIComponent(pair.slice(i + 1)), attrs: attrs.join(';') }];
    }));

    // idle too long (no / expired / other user / other epoch / tampered / another key's active cookie)
    const now = Date.now();
    const lockedCookies = {
        none: undefined,
        expired: await createActiveToken(secret, user, now - (ACTIVE_TTL_SECONDS + 1) * 1000),
        otherUser: await createActiveToken(secret, { ...user, userId: 'u_admin_synthetic' }),
        oldEpoch: await createActiveToken(secret, { ...user, epoch: 2 }),
        tampered: `${await createActiveToken(secret, user)}0`,
        otherKey: await createActiveToken(randomBytes(32).toString('hex'), user),
    };
    for (const [label, active] of Object.entries(lockedCookies)) {
        const screen = await run('/yuki/calendar?month=2026-11', { kakeibo_session: session, kakeibo_active: active });
        assert.equal(screen.status, 307, label);
        const location = new URL(screen.headers.get('location'));
        assert.equal(location.pathname, '/login', label);
        assert.equal(location.searchParams.get('reason'), 'locked', label);
        assert.equal(location.searchParams.get('returnTo'), '/yuki/calendar?month=2026-11', label);
        const cookies = setCookies(screen);
        assert.equal(cookies.kakeibo_session, undefined, `${label}: the session is kept`);
        if (active !== undefined) assert.equal(cookies.kakeibo_active.value, '', `${label}: the stale active cookie is deleted`);

        const api = await run('/api/expenses?source=yuki', { kakeibo_session: session, kakeibo_active: active });
        assert.equal(api.status, 401, label);
        assert.deepEqual(await api.json(), { error: 'Locked' }, label);
        assert.equal(api.headers.get('cache-control'), 'no-store');
        assert.equal(setCookies(api).kakeibo_session, undefined, `${label}: the API keeps the session too`);
    }

    // active: allowed, and the window slides (a fresh token for this session, HttpOnly, Strict, Secure)
    for (const path of ['/yuki', '/settings/passkeys', '/api/expenses?source=yuki', '/api/auth/session']) {
        const res = await run(path, { kakeibo_session: session, kakeibo_active: await createActiveToken(secret, user, now - 20 * 60 * 1000) });
        assert.equal(res.headers.get('x-middleware-next'), '1', path);
        const refreshed = setCookies(res).kakeibo_active;
        assert.ok(refreshed && await isActiveTokenValid(refreshed.value, secret, user), path);
        for (const attr of [/HttpOnly/i, /SameSite=strict/i, /Secure/i, /Path=\//i, new RegExp(`Max-Age=${ACTIVE_TTL_SECONDS}`)]) assert.match(refreshed.attrs, attr, path);
    }
    // a link prefetch passes but does not count as a use
    const prefetch = await run('/yuki', { kakeibo_session: session, kakeibo_active: await createActiveToken(secret, user) }, { 'next-router-prefetch': '1' });
    assert.equal(prefetch.headers.get('x-middleware-next'), '1');
    assert.equal(setCookies(prefetch).kakeibo_active, undefined);

    // public paths: no lock, no slide; opening /login ends the active state
    const login = await run('/login?reason=locked', { kakeibo_session: session, kakeibo_active: await createActiveToken(secret, user) });
    assert.equal(login.headers.get('x-middleware-next'), '1');
    assert.equal(setCookies(login).kakeibo_active.value, '');
    assert.equal(setCookies(login).kakeibo_session, undefined);
    for (const path of ['/invite', '/manifest.webmanifest', '/api/line/webhook']) {
        const res = await run(path, { kakeibo_session: session });
        assert.equal(res.headers.get('x-middleware-next'), '1', path);
        assert.deepEqual(res.headers.getSetCookie(), [], path);
    }
    // logout of this device works while locked and does not slide
    const logout = await run('/api/auth/logout', { kakeibo_session: session });
    assert.equal(logout.headers.get('x-middleware-next'), '1');
    assert.deepEqual(logout.headers.getSetCookie(), []);

    // an invalid session: the session login (cache cleared there), both cookies deleted
    const invalid = await run('/yuki', { kakeibo_session: 'forged', kakeibo_active: await createActiveToken(secret, user) });
    assert.equal(new URL(invalid.headers.get('location')).searchParams.get('reason'), 'session');
    assert.equal(setCookies(invalid).kakeibo_session.value, '');
    assert.equal(setCookies(invalid).kakeibo_active.value, '');
});

test('middleware matcher runs on every path but Next build assets (no prefix exclusions such as "login")', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');
    const matcher = /matcher:\s*\[\s*'([^']+)'/.exec(source)[1];
    assert.equal(matcher, '/((?!_next/static|_next/image).*)');
});

test('every icon referenced by manifests and layouts is public (iOS fetches them without cookies)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'app/manifest.ts',
    ...fs.readdirSync(join(root, 'public')).filter(f => f.endsWith('-manifest.json')).map(f => `public/${f}`),
    ...['app/layout.tsx', ...fs.readdirSync(join(root, 'app'), { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => `app/${d.name}/layout.tsx`)]
      .filter(f => fs.existsSync(join(root, f))),
  ];
  const paths = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(join(root, file), 'utf8').matchAll(/["'](\/[^"'?#]+\.(?:png|ico|svg|jpg|webp))["']/g)) {
      paths.add(match[1]);
    }
  }
  assert.ok(paths.has('/psyduck.png') && paths.has('/image.png'), [...paths].join(','));
  for (const path of paths) assert.equal(isPublicPath(path), true, `${path} must be public`);
});
