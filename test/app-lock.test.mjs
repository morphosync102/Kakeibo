import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
    ACTIVE_TTL_MS, APP_LOCK_IDLE_MS, APP_LOCK_PING_INTERVAL_MS, LAST_ACTIVE_KEY, isIdleExpired, lockedLoginPath, markAppActive,
    readLastActive, shouldPing, visibilityAction,
} from '../lib/app-lock.ts';
import { ACTIVE_COOKIE, ACTIVE_TTL_SECONDS, activeCookieOptions, createActiveToken, isActiveTokenValid } from '../lib/active-session.ts';
import { createSession, readSession } from '../lib/session.ts';
import { createChallengeToken, newChallenge, readChallengeToken } from '../lib/webauthn-challenge.ts';
import { clearKakeiboStorage } from '../lib/client-session.ts';

// App lock (design §3.12). Synthetic values only.
const secret = randomBytes(32).toString('hex');
const now = 1_800_000_000_000;
const MIN = 60 * 1000;
const user = { userId: 'u_member_synthetic', epoch: 2 };

function memoryStorage(entries = {}) {
    const map = new Map(Object.entries(entries));
    return {
        get length() { return map.size; },
        key: i => [...map.keys()][i] ?? null,
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: k => { map.delete(k); },
    };
}

// ---------------------------------------------------------------- the timings

test('the lock is 30 minutes; the server window outlasts the client by one ping interval', () => {
    assert.equal(APP_LOCK_IDLE_MS, 30 * MIN);
    assert.equal(APP_LOCK_PING_INTERVAL_MS, MIN);
    assert.equal(ACTIVE_TTL_MS, APP_LOCK_IDLE_MS + APP_LOCK_PING_INTERVAL_MS);
    assert.equal(ACTIVE_TTL_SECONDS, 31 * 60);
});

test('the lock time is defined in one place (lib/app-lock.ts) and only derived elsewhere', () => {
    const root = new URL('../', import.meta.url);
    const files = ['middleware.ts'];
    const walk = dir => {
        for (const entry of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
        }
    };
    for (const dir of ['app', 'lib', 'components', 'hooks']) if (fs.existsSync(new URL(dir, root))) walk(dir);
    const defining = files.filter(f => /APP_LOCK_IDLE_MS\s*=/.test(fs.readFileSync(new URL(f, root), 'utf8')));
    assert.deepEqual(defining, ['lib/app-lock.ts']);
    for (const file of ['lib/active-session.ts', 'components/AppLockGuard.tsx', 'middleware.ts']) {
        assert.doesNotMatch(fs.readFileSync(new URL(file, root), 'utf8'), /30 \* 60|1800|31 \* 60|1860/, file);
    }
});

// ---------------------------------------------------------------- the server's active cookie

test('an active token is accepted only for its own session subject until it expires (sliding 31 minutes)', async () => {
    const token = await createActiveToken(secret, user, now);
    assert.match(token, /^a1\.\d+\.u_member_synthetic\.2\.[a-f0-9]{64}$/);
    assert.equal(await isActiveTokenValid(token, secret, user, now), true);
    assert.equal(await isActiveTokenValid(token, secret, user, now + ACTIVE_TTL_MS - 1000), true);
    assert.equal(await isActiveTokenValid(token, secret, user, now + ACTIVE_TTL_MS), false, 'expired');
    // bound to userId and epoch (another user, or the same user after "log out everywhere")
    assert.equal(await isActiveTokenValid(token, secret, { ...user, userId: 'u_admin_synthetic' }, now), false);
    assert.equal(await isActiveTokenValid(token, secret, { ...user, epoch: 3 }, now), false);
    // a later refresh moves the deadline
    const refreshed = await createActiveToken(secret, user, now + 20 * MIN);
    assert.equal(await isActiveTokenValid(refreshed, secret, user, now + 45 * MIN), true);
});

test('tampered, future-dated, foreign-key and malformed active tokens are refused', async () => {
    const token = await createActiveToken(secret, user, now);
    const parts = token.split('.');
    const derived = createHmac('sha256', Buffer.from(secret, 'hex')).update('kakeibo/app-lock-active/v1').digest();
    const resign = (p, key = derived) => {
        const payload = p.slice(0, -1).join('.');
        return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
    };
    const cases = {
        expiryMoved: parts.map((x, i) => (i === 1 ? String(Number(x) + 600) : x)).join('.'),
        userChanged: parts.map((x, i) => (i === 2 ? 'u_admin_synthetic' : x)).join('.'),
        epochChanged: parts.map((x, i) => (i === 3 ? '3' : x)).join('.'),
        signatureFlipped: `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`,
        // correctly signed, but further ahead than a fresh token can be
        farFuture: resign(parts.map((x, i) => (i === 1 ? String(Number(x) + 3600) : x))),
        // signed with the raw SESSION_SECRET (the session key) instead of the derived one
        sessionKey: resign(parts, Buffer.from(secret, 'hex')),
        otherSecret: await createActiveToken(randomBytes(32).toString('hex'), user, now),
        extra: `${token}.x`, prefixed: `x${token}`, v2: token.replace(/^a1/, 'a2'), empty: '', long: 'a'.repeat(300),
    };
    assert.equal(await isActiveTokenValid(resign(parts), secret, user, now), true, 'the re-signing helper itself is sound');
    for (const [label, value] of Object.entries(cases)) assert.equal(await isActiveTokenValid(value, secret, user, now), false, label);
    for (const value of [undefined, null, 42, {}]) assert.equal(await isActiveTokenValid(value, secret, user, now), false, String(value));
    for (const key of [undefined, '', 'short']) assert.equal(await isActiveTokenValid(token, key, user, now), false, String(key));
    await assert.rejects(createActiveToken('short', user, now));
    for (const bad of [{ ...user, userId: 'has.dot' }, { ...user, userId: '' }, { ...user, epoch: -1 }, { ...user, epoch: 1.5 }]) {
        await assert.rejects(createActiveToken(secret, bad, now), JSON.stringify(bad));
    }
});

test('active tokens, sessions and WebAuthn challenges are never interchangeable', async () => {
    const active = await createActiveToken(secret, user, now);
    assert.equal(await readSession(active, { SESSION_SECRET: secret }, now), null);
    assert.equal(await readChallengeToken(active, secret, { purposes: ['add', 'reauth', 'login', 'register'], binding: user.userId }, now), null);
    const session = await createSession(secret, { ...user, sources: ['yuki', 'main'], homeSource: 'yuki', amr: 'pk' }, now);
    const challenge = await createChallengeToken(secret, { purpose: 'add', challenge: newChallenge(), binding: user.userId }, now);
    for (const value of [session, challenge]) assert.equal(await isActiveTokenValid(value, secret, user, now), false);
});

test('the active cookie is HttpOnly, SameSite=Strict, Path=/, 31 minutes, Secure in production', () => {
    assert.equal(ACTIVE_COOKIE, 'kakeibo_active');
    assert.deepEqual(activeCookieOptions({ NODE_ENV: 'production' }), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 31 * 60, path: '/' });
    assert.equal(activeCookieOptions({ NODE_ENV: 'development' }).secure, false);
    assert.equal(activeCookieOptions({}, 0).maxAge, 0);
});

// ---------------------------------------------------------------- the client's clock

test('idle detection: locked strictly after 30 minutes since the last interaction; unknown is not idle', () => {
    assert.equal(isIdleExpired(now, now + 30 * MIN), false);
    assert.equal(isIdleExpired(now, now + 30 * MIN + 1), true);
    assert.equal(isIdleExpired(now, now + 5 * MIN), false);
    assert.equal(isIdleExpired(null, now), false);
});

test('returning to the app (visibilitychange): lock only when visible and idle for too long', () => {
    assert.equal(visibilityAction({ visible: true, lastActive: now, now: now + 31 * MIN }), 'lock');
    assert.equal(visibilityAction({ visible: true, lastActive: now, now: now + 29 * MIN }), 'none');
    assert.equal(visibilityAction({ visible: false, lastActive: now, now: now + 60 * MIN }), 'none', 'hidden: decide when it comes back');
    assert.equal(visibilityAction({ visible: true, lastActive: null, now }), 'none');
});

test('interactions ping the server at most once a minute', () => {
    assert.equal(shouldPing(null, now), true);
    assert.equal(shouldPing(now, now + 59 * 1000), false);
    assert.equal(shouldPing(now, now + MIN), true);
});

test('the last interaction is kept in localStorage under a kakeibo_ key (cleared with the cache on logout / user change)', () => {
    const storage = memoryStorage({ other: 'x' });
    assert.equal(readLastActive(storage), null);
    markAppActive(storage, now);
    assert.equal(storage.getItem(LAST_ACTIVE_KEY), String(now));
    assert.equal(readLastActive(storage), now);
    assert.ok(LAST_ACTIVE_KEY.startsWith('kakeibo_'));
    clearKakeiboStorage(storage);
    assert.equal(readLastActive(storage), null);
    for (const value of ['', 'abc', '-1', '1e9', '1'.repeat(20)]) assert.equal(readLastActive(memoryStorage({ [LAST_ACTIVE_KEY]: value })), null, value);
    // unavailable storage never throws
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(readLastActive(broken), null);
    markAppActive(broken, now);
    markAppActive(undefined, now);
    assert.equal(readLastActive(undefined), null);
});

test('the lock screen keeps the current screen as returnTo (validated again by the server after Face ID)', () => {
    assert.equal(lockedLoginPath('/yuki/calendar?month=2026-11'), '/login?returnTo=%2Fyuki%2Fcalendar%3Fmonth%3D2026-11&reason=locked');
    assert.equal(lockedLoginPath('/settings/passkeys'), '/login?returnTo=%2Fsettings%2Fpasskeys&reason=locked');
    for (const value of ['//evil.example', 'https://evil.example', '/login?reason=locked', '']) {
        assert.equal(lockedLoginPath(value), '/login?reason=locked', value);
    }
});

// ---------------------------------------------------------------- the guard component

test('AppLockGuard: mounted for every page, skips public paths, locks on return / first tap / timer, swallows that tap and waits for pending writes', () => {
    const layout = fs.readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    assert.match(layout, /<AppLockGuard \/>/);
    const guard = fs.readFileSync(new URL('../components/AppLockGuard.tsx', import.meta.url), 'utf8');
    assert.match(guard, /if \(!pathname \|\| isPublicPath\(pathname\)\) return;/);
    assert.match(guard, /document\.addEventListener\('visibilitychange', onVisible\)/);
    assert.match(guard, /window\.addEventListener\('pageshow', onVisible\)/);
    assert.match(guard, /setInterval\(onVisible, APP_LOCK_CHECK_INTERVAL_MS\)/);
    assert.match(guard, /\['pointerdown', 'keydown', 'click'\]/);
    assert.match(guard, /window\.addEventListener\(type, onInteraction, true\)/, 'capture phase: before React handlers');
    assert.match(guard, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*lock\(\);/);
    // pending writes finish before the screen changes
    assert.match(guard, /if \(getPendingWrites\(\) === 0\) \{\s*handleAppLocked\(\);/);
    assert.match(guard, /subscribePendingWrites\(pending => \{\s*if \(pending !== 0\) return;/);
    // the ping slides the server window and learns of a lock or an ended session
    assert.match(guard, /fetch\('\/api\/auth\/session', \{ cache: 'no-store' \}\)/);
    assert.match(guard, /if \(error === LOCKED_ERROR\) lock\(\);\s*else handleUnauthorized\(error\);/);
    // the guard never clears the cache itself
    assert.doesNotMatch(guard, /clearKakeiboStorage|handleSessionExpired\(\)/);
});
