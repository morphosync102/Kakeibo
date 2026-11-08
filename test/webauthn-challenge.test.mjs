import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
    CHALLENGE_TTL_SECONDS, challengeCookieOptions, createChallengeToken, newChallenge, readChallengeToken, sha256Hex,
} from '../lib/webauthn-challenge.ts';
import { createSession, readSession } from '../lib/session.ts';
import { webauthnConfig } from '../lib/webauthn.ts';
import { apiErrorMessage, ceremonyErrorMessage, inviteTokenFromHash, isFresh, isInAppBrowser, safeRedirect } from '../lib/passkey-client.ts';
import { failureFromGas, inviteTokenFrom } from '../lib/passkey-flow.ts';

// Synthetic values only
const secret = randomBytes(32).toString('hex');
const now = 1_800_000_000_000;
const USER = 'u_member_synthetic';
const HASH = createHash('sha256').update('synthetic-invite').digest('hex');

const read = (token, purposes, binding, at = now, key = secret) => readChallengeToken(token, key, { purposes, binding }, at);

test('a challenge token round-trips purpose, challenge and binding', async () => {
    const challenge = newChallenge();
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(newChallenge(), challenge);
    for (const [purpose, binding] of [['register', HASH], ['login', '-'], ['reauth', USER], ['add', USER], ['bootstrap', USER]]) {
        const token = await createChallengeToken(secret, { purpose, challenge, binding }, now);
        assert.match(token, new RegExp(`^wa1\\.${purpose}\\.`));
        assert.deepEqual(await read(token, [purpose], binding), { purpose, challenge, binding });
    }
});

test('purpose and subject are fixed: another purpose or binding is rejected', async () => {
    const challenge = newChallenge();
    const reauth = await createChallengeToken(secret, { purpose: 'reauth', challenge, binding: USER }, now);
    assert.equal(await read(reauth, ['add', 'bootstrap'], USER), null, 'a reauth challenge is not a registration challenge');
    assert.equal(await read(reauth, ['login'], '-'), null);
    assert.equal(await read(reauth, ['reauth'], 'u_admin_synthetic'), null, 'bound to another user');
    const login = await createChallengeToken(secret, { purpose: 'login', challenge, binding: '-' }, now);
    assert.equal(await read(login, ['register'], HASH), null);
    const register = await createChallengeToken(secret, { purpose: 'register', challenge, binding: HASH }, now);
    assert.equal(await read(register, ['register'], 'f'.repeat(64)), null, 'bound to another invite');
});

test('expires after exactly 5 minutes; future issuance, tampering and other keys are rejected', async () => {
    const challenge = newChallenge();
    const token = await createChallengeToken(secret, { purpose: 'login', challenge, binding: '-' }, now);
    assert.ok(await read(token, ['login'], '-', now + CHALLENGE_TTL_SECONDS * 1000 - 1));
    assert.equal(await read(token, ['login'], '-', now + CHALLENGE_TTL_SECONDS * 1000), null);
    assert.equal(await read(await createChallengeToken(secret, { purpose: 'login', challenge, binding: '-' }, now + 120_000), ['login'], '-'), null);
    assert.equal(await read(token, ['login'], '-', now, randomBytes(32).toString('hex')), null);
    assert.equal(await readChallengeToken(token, undefined, { purposes: ['login'], binding: '-' }, now), null);

    const parts = token.split('.');
    const resignedWithSessionKey = (edit) => {
        const p = [...parts];
        edit(p);
        const payload = p.slice(0, -1).join('.');
        return `${payload}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(payload).digest('hex')}`;
    };
    // the raw SESSION_SECRET is not the challenge key
    assert.equal(await read(resignedWithSessionKey(() => {}), ['login'], '-'), null);
    for (const tampered of [
        parts.map((x, i) => (i === 1 ? 'register' : x)).join('.'),
        parts.map((x, i) => (i === 4 ? newChallenge() : x)).join('.'),
        parts.map((x, i) => (i === 3 ? String(Number(x) + 60) : x)).join('.'),
        `${token}0`, token.slice(0, -1), '', 'wa1', null, 42, `x${token}`, `${token}.x`,
    ]) {
        assert.equal(await read(tampered, ['login', 'register'], '-'), null, String(tampered));
    }
});

test('challenge tokens and session tokens are never interchangeable', async () => {
    const env = { SESSION_SECRET: secret, APP_PASSWORD: 'synthetic' };
    const challengeToken = await createChallengeToken(secret, { purpose: 'reauth', challenge: newChallenge(), binding: USER }, now);
    assert.equal(await readSession(challengeToken, env, now), null);
    const session = await createSession(secret, { userId: USER, epoch: 0, sources: ['yuki', 'main'], homeSource: 'yuki', amr: 'pk' }, now);
    for (const purposes of [['reauth'], ['add'], ['login'], ['register']]) assert.equal(await read(session, purposes, USER), null);
});

test('invalid claims are refused at creation', async () => {
    await assert.rejects(createChallengeToken(secret, { purpose: 'other', challenge: newChallenge(), binding: USER }, now));
    await assert.rejects(createChallengeToken(secret, { purpose: 'login', challenge: 'short', binding: '-' }, now));
    await assert.rejects(createChallengeToken(secret, { purpose: 'login', challenge: newChallenge(), binding: USER }, now));
    await assert.rejects(createChallengeToken(secret, { purpose: 'register', challenge: newChallenge(), binding: USER }, now));
    await assert.rejects(createChallengeToken(secret, { purpose: 'add', challenge: newChallenge(), binding: 'a.b' }, now));
    await assert.rejects(createChallengeToken('short', { purpose: 'login', challenge: newChallenge(), binding: '-' }, now));
});

test('the challenge cookie is HttpOnly, SameSite=Strict, /api/auth only, 5 minutes, Secure in production', () => {
    assert.deepEqual(challengeCookieOptions({ NODE_ENV: 'production' }), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 300, path: '/api/auth' });
    assert.equal(challengeCookieOptions({ NODE_ENV: 'development' }).secure, false);
    assert.equal(challengeCookieOptions({}, 0).maxAge, 0);
});

test('sha256Hex matches the GAS invite token hash (UTF-8 SHA-256, lowercase hex)', async () => {
    const token = randomBytes(32).toString('base64url');
    assert.equal(await sha256Hex(token), createHash('sha256').update(token, 'utf8').digest('hex'));
});

test('RP ID and origin come only from WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN and must agree', () => {
    assert.deepEqual(webauthnConfig({ WEBAUTHN_RP_ID: 'kakeibo.example', WEBAUTHN_ORIGIN: 'https://kakeibo.example' }), { rpID: 'kakeibo.example', origin: 'https://kakeibo.example' });
    assert.deepEqual(webauthnConfig({ WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost:3000' }), { rpID: 'localhost', origin: 'http://localhost:3000' });
    assert.ok(webauthnConfig({ WEBAUTHN_RP_ID: 'example', WEBAUTHN_ORIGIN: 'https://app.example' }));
    for (const env of [
        {}, { WEBAUTHN_RP_ID: 'kakeibo.example' }, { WEBAUTHN_ORIGIN: 'https://kakeibo.example' },
        { WEBAUTHN_RP_ID: 'kakeibo.example', WEBAUTHN_ORIGIN: 'http://kakeibo.example' }, // http outside localhost
        { WEBAUTHN_RP_ID: 'kakeibo.example', WEBAUTHN_ORIGIN: 'https://kakeibo.example/' }, // not exactly an origin
        { WEBAUTHN_RP_ID: 'kakeibo.example', WEBAUTHN_ORIGIN: 'https://kakeibo.example/login' },
        { WEBAUTHN_RP_ID: 'kakeibo.example', WEBAUTHN_ORIGIN: 'https://other.example' },
        { WEBAUTHN_RP_ID: 'kakeibo.example', WEBAUTHN_ORIGIN: 'https://evilkakeibo.example' },
        { WEBAUTHN_RP_ID: 'Kakeibo.Example', WEBAUTHN_ORIGIN: 'https://kakeibo.example' },
        { WEBAUTHN_RP_ID: 'https://kakeibo.example', WEBAUTHN_ORIGIN: 'https://kakeibo.example' },
        { WEBAUTHN_RP_ID: '', WEBAUTHN_ORIGIN: '' },
    ]) {
        assert.equal(webauthnConfig(env), null, JSON.stringify(env));
    }
    // never derived from the request
    for (const file of ['lib/webauthn.ts', 'app/api/auth/register/options/route.ts', 'app/api/auth/register/verify/route.ts', 'app/api/auth/login/options/route.ts', 'app/api/auth/login/verify/route.ts', 'app/api/auth/passkeys/add/options/route.ts', 'app/api/auth/passkeys/add/reauth/route.ts', 'app/api/auth/passkeys/add/bootstrap/route.ts', 'app/api/auth/passkeys/add/verify/route.ts']) {
        const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /headers\.get\(['"](host|x-forwarded-host|origin)['"]\)|request\.url|nextUrl/i, file);
    }
});

test('the passkey packages are pinned to exact versions', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.dependencies['@simplewebauthn/server'], '14.0.3');
    assert.equal(pkg.dependencies['@simplewebauthn/browser'], '14.0.0');
    const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    assert.equal(lock.packages['node_modules/@simplewebauthn/server'].version, '14.0.3');
    assert.equal(lock.packages['node_modules/@simplewebauthn/browser'].version, '14.0.0');
});

test('client helpers: invite fragment, in-app browsers, redirects and fixed messages', () => {
    const token = randomBytes(32).toString('base64url');
    assert.equal(inviteTokenFromHash(`#${token}`), token);
    for (const hash of ['', '#', '#short', `#${token}?x`, `#${token}/x`, `#${'a'.repeat(200)}`]) assert.equal(inviteTokenFromHash(hash), null, hash);
    assert.equal(inviteTokenFrom(token), token);
    assert.equal(inviteTokenFrom(`${token}.`), null);
    assert.equal(inviteTokenFrom(42), null);

    assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.0.0'), true);
    assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Instagram 300.0'), true);
    assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), false);

    assert.equal(safeRedirect('/yuki'), '/yuki');
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', null, 42]) assert.equal(safeRedirect(bad), '/');

    // unknown codes and server text never reach the screen
    const generic = apiErrorMessage({ ok: false, status: 500, data: { error: 'AuthError: stack <secret>' } });
    assert.doesNotMatch(generic, /secret|AuthError/);
    assert.notEqual(apiErrorMessage({ ok: false, status: 410, data: { error: 'InviteInvalid' } }), generic);
    assert.equal(apiErrorMessage({ ok: false, status: 400, data: { error: 'constructor' } }), generic);
    assert.doesNotMatch(ceremonyErrorMessage(Object.assign(new Error('internal detail'), { name: 'NotAllowedError' })), /internal/);

    assert.equal(isFresh(null), false);
    assert.equal(isFresh(now, now + 60_000), true);
    assert.equal(isFresh(now, now + 4 * 60_000), false);
});

test('GAS errors map to fixed HTTP failures; only SessionRevoked deletes the session', () => {
    assert.deepEqual(failureFromGas('InviteInvalid'), { status: 410, error: 'InviteInvalid' });
    assert.deepEqual(failureFromGas('ChallengeReused'), { status: 400, error: 'ChallengeInvalid' });
    assert.deepEqual(failureFromGas('CredentialNotFound'), { status: 401, error: 'VerificationFailed' });
    assert.deepEqual(failureFromGas('SessionRevoked'), { status: 401, error: 'Unauthorized', revokeSession: true });
    assert.deepEqual(failureFromGas('BootstrapNotAllowed'), { status: 403, error: 'NotAllowed' });
    for (const code of ['Unauthorized', 'AuthUnavailable', 'Busy', 'AuthError', 'NotConfigured', 'BadGateway', 'Unavailable', 'Invalid input']) {
        assert.deepEqual(failureFromGas(code), { status: 503, error: 'Service Unavailable' }, code);
    }
});
