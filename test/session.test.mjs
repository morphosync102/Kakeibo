import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { SESSION_SOURCE_IDS, SESSION_TTL_SECONDS, constantTimeEqual, createSession, readSession } from '../lib/session.ts';
import { SOURCE_IDS } from '../lib/sources.ts';

// Synthetic values only (no real ids or keys)
const secret = randomBytes(32).toString('hex');
const now = 1_800_000_000_000;
const env = { SESSION_SECRET: secret, APP_PASSWORD: 'synthetic-password' };
const noPassword = { SESSION_SECRET: secret };
const admin = { userId: 'u_admin_synthetic', epoch: 3, sources: ['main', 'yahoo'], homeSource: 'main' };
const yuki = { userId: 'u_member-synthetic', epoch: 0, sources: ['main', 'yuki'], homeSource: 'yuki' };

const sign = (payload, key = secret) => createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('hex');
const resign = (token, edit) => {
    const parts = token.split('.');
    edit(parts);
    const payload = parts.slice(0, -1).join('.');
    return `${payload}.${sign(payload)}`;
};

test('a v2 session round-trips userId, epoch, sources (home first) and amr', async () => {
    const token = await createSession(secret, { ...admin, amr: 'pk' }, now);
    assert.match(token, /^v2\./);
    assert.deepEqual(await readSession(token, env, now), { userId: admin.userId, epoch: 3, sources: ['main', 'yahoo'], homeSource: 'main', amr: 'pk' });
    // the home source is stored first, whatever order GAS listed them in
    const member = await readSession(await createSession(secret, { ...yuki, amr: 'pwd' }, now), env, now);
    assert.deepEqual(member, { userId: yuki.userId, epoch: 0, sources: ['yuki', 'main'], homeSource: 'yuki', amr: 'pwd' });
    assert.notEqual(await createSession(secret, { ...admin, amr: 'pk' }, now), token, 'each issuance has a nonce');
});

test('sessions expire exactly at the server-enforced lifetime; future issuance is rejected', async () => {
    const token = await createSession(secret, { ...admin, amr: 'pk' }, now);
    assert.ok(await readSession(token, env, now + SESSION_TTL_SECONDS * 1000 - 1));
    assert.equal(await readSession(token, env, now + SESSION_TTL_SECONDS * 1000), null);
    assert.equal(await readSession(await createSession(secret, { ...admin, amr: 'pk' }, now + 120_000), env, now), null);
    // a validly signed token with a nonstandard lifetime
    assert.equal(await readSession(resign(token, p => { p[2] = String(Number(p[2]) + 1); }), env, now), null);
});

test('without APP_PASSWORD, password sessions are invalid and passkey sessions stay valid', async () => {
    const pwd = await createSession(secret, { ...admin, amr: 'pwd' }, now);
    const pk = await createSession(secret, { ...admin, amr: 'pk' }, now);
    assert.ok(await readSession(pwd, env, now));
    for (const off of [noPassword, { ...noPassword, APP_PASSWORD: '' }]) {
        assert.equal(await readSession(pwd, off, now), null);
        assert.ok(await readSession(pk, off, now));
    }
});

test('changing amr (pwd -> pk) or any other field breaks the signature', async () => {
    const token = await createSession(secret, { ...admin, amr: 'pwd' }, now);
    const parts = token.split('.');
    const edits = [
        p => { p[7] = 'pk'; }, // amr
        p => { p[4] = 'u_someone_else'; }, // userId
        p => { p[5] = '4'; }, // epoch
        p => { p[6] = 'main+yahoo+yuki'; }, // sources
        p => { p[6] = 'yahoo+main'; }, // home source
        p => { p[3] = 'f'.repeat(32); }, // nonce
        p => { p[2] = String(Number(p[2]) - 1); }, // expiry
        p => { p[8] = p[8].slice(0, -1) + (p[8].endsWith('a') ? 'b' : 'a'); }, // signature
    ];
    for (const edit of edits) {
        const copy = [...parts];
        edit(copy);
        assert.equal(await readSession(copy.join('.'), noPassword, now) ?? await readSession(copy.join('.'), env, now), null, copy.join('.'));
    }
});

test('v1, malformed, overlong and unknown-source tokens fail closed', async () => {
    const token = await createSession(secret, { ...admin, amr: 'pk' }, now);
    const issued = Math.floor(now / 1000);
    const v1Payload = `v1.${issued}.${issued + SESSION_TTL_SECONDS}.${'a'.repeat(32)}`;
    const v1 = `${v1Payload}.${sign(v1Payload)}`;
    for (const value of [undefined, null, '', 'authenticated', {}, v1, token + '.extra', token.replace('v2.', 'v3.'), 'a'.repeat(600)]) {
        assert.equal(await readSession(value, env, now), null, String(value));
    }
    // correctly signed but structurally invalid
    for (const edit of [
        p => { p[6] = 'main+other'; },
        p => { p[6] = 'main+main'; },
        p => { p[6] = ''; },
        p => { p[7] = 'otp'; },
        p => { p[5] = '01'; },
        p => { p[5] = '-1'; },
        p => { p[4] = 'bad id'; },
    ]) {
        assert.equal(await readSession(resign(token, edit), env, now), null);
    }
});

test('a token longer than 512 characters is rejected before verification', async () => {
    const long = { ...admin, userId: 'u'.repeat(64), amr: 'pk' };
    const token = await createSession(secret, long, now);
    assert.ok(token.length <= 512);
    assert.ok(await readSession(token, env, now));
    assert.equal(await readSession(token + 'x'.repeat(600), env, now), null);
});

test('missing, malformed and rotated signing keys reject tokens; issuance validates its input', async () => {
    const token = await createSession(secret, { ...admin, amr: 'pk' }, now);
    for (const key of [undefined, '', 'invalid', randomBytes(31).toString('hex'), randomBytes(32).toString('hex')]) {
        assert.equal(await readSession(token, { SESSION_SECRET: key, APP_PASSWORD: 'x' }, now), null);
    }
    for (const key of ['', 'invalid', randomBytes(31).toString('hex')]) await assert.rejects(createSession(key, { ...admin, amr: 'pk' }, now));
    for (const bad of [
        { ...admin, amr: 'otp' },
        { ...admin, amr: 'pk', userId: 'has.dot' },
        { ...admin, amr: 'pk', userId: '' },
        { ...admin, amr: 'pk', epoch: -1 },
        { ...admin, amr: 'pk', epoch: 1.5 },
        { ...admin, amr: 'pk', sources: [] },
        { ...admin, amr: 'pk', sources: ['main', 'other'] },
        { ...admin, amr: 'pk', homeSource: 'yuki' },
    ]) {
        await assert.rejects(createSession(secret, bad, now), JSON.stringify(bad));
    }
});

test('the session source list matches the registry', () => {
    assert.deepEqual([...SESSION_SOURCE_IDS], [...SOURCE_IDS]);
});

test('constantTimeEqual compares whole strings of any length', async () => {
    assert.equal(await constantTimeEqual('synthetic', 'synthetic'), true);
    for (const [a, b] of [['synthetic', 'synthetiC'], ['synthetic', 'synthetic '], ['', 'x'], ['x', '']]) {
        assert.equal(await constantTimeEqual(a, b), false);
    }
});
