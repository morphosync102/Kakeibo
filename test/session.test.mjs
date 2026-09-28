import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createSession, verifySession, SESSION_TTL_SECONDS } from '../lib/session.ts';

const secret = randomBytes(32).toString('hex');
const now = 1_800_000_000_000;

test('signed sessions are valid until the exact server-enforced expiration; each issuance has a nonce', async () => {
    const token = await createSession(secret, now);
    assert.equal(await verifySession(token, secret, now), true);
    assert.notEqual(await createSession(secret, now), token);
    assert.equal(await verifySession(token, secret, now + SESSION_TTL_SECONDS * 1000 - 1), true);
    assert.equal(await verifySession(token, secret, now + SESSION_TTL_SECONDS * 1000), false);
});
test('legacy, missing, malformed, overlong and tampered tokens fail closed', async () => {
    const token = await createSession(secret, now);
    for (const value of [undefined, null, '', 'authenticated', 'synthetic-test', {}, token + '.extra', 'a'.repeat(1000), token.replace('v1.', 'v2.'), token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')]) {
        assert.equal(await verifySession(value, secret, now), false);
    }
    const parts = token.split('.');
    parts[2] = String(Number(parts[2]) + 1);
    assert.equal(await verifySession(parts.join('.'), secret, now), false);
    parts[1] = '0' + parts[1];
    assert.equal(await verifySession(parts.join('.'), secret, now), false);
});
test('missing, malformed and rotated signing keys reject tokens; issuance cannot fall back', async () => {
    const token = await createSession(secret, now);
    for (const key of [undefined, '', 'invalid', randomBytes(31).toString('hex'), randomBytes(32).toString('hex')]) {
        assert.equal(await verifySession(token, key, now), false);
    }
    for (const key of ['', 'invalid', randomBytes(31).toString('hex')]) await assert.rejects(createSession(key, now));
});
test('even signed tokens with future issuance or a nonstandard lifetime are rejected', async () => {
    assert.equal(await verifySession(await createSession(secret, now + 120_000), secret, now), false);
    const parts = (await createSession(secret, now)).split('.');
    parts[2] = String(Number(parts[2]) + 1);
    const payload = parts.slice(0, 4).join('.');
    const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(payload).digest('hex');
    assert.equal(await verifySession(`${payload}.${signature}`, secret, now), false);
});
