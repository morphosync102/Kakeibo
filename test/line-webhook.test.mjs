import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { isValidLineSignature, lineSignature, linkCodeMessages, LINK_ACCEPTED_REPLY, MAX_FORWARDED_PER_WEBHOOK } from '../lib/line-webhook.ts';
import { loadRoute } from './helpers/load-route.mjs';

// LINE webhook (design §5.4, §8.5). Synthetic channel secret, user ids and
// tokens only.
const CHANNEL_SECRET = randomBytes(16).toString('hex');
const ACCESS_TOKEN = 'dummy-line-channel-access-token';
const DUMMY_KEY = 'dummy-gas-proxy-secret';
const DUMMY_AUTH_KEY = 'dummy-gas-auth-proxy-secret';
const ENV = { LINE_CHANNEL_SECRET: CHANNEL_SECRET, GAS_PROXY_SECRET: DUMMY_KEY, GAS_AUTH_PROXY_SECRET: DUMMY_AUTH_KEY, NODE_ENV: 'production' };
const LINE_USER = `U${'0123456789abcdef'.repeat(2)}`;
const OTHER_USER = `U${'fedcba9876543210'.repeat(2)}`;
const CODE = 'K7M2P9QX4R';

const sign = body => createHmac('sha256', CHANNEL_SECRET).update(body, 'utf8').digest('base64');
const textEvent = (text, extra = {}) => ({
    type: 'message', mode: 'active', timestamp: 1, replyToken: 'synthetic-reply-token',
    source: { type: 'user', userId: LINE_USER }, message: { type: 'text', id: '1', text },
    deliveryContext: { isRedelivery: false }, webhookEventId: 'synthetic', ...extra,
});
const payload = (...events) => JSON.stringify({ destination: 'Usyntheticbot', events });

async function deliver(rawBody, { signature = sign(rawBody), env = {}, upstream = () => ({ success: true }) } = {}) {
    const route = await loadRoute('app/api/line/webhook/route.ts', { env: { ...ENV, ...env }, upstream });
    const headers = { 'content-type': 'application/json' };
    if (signature !== null) headers['x-line-signature'] = signature;
    const res = await route.POST(new Request('https://kakeibo.example/api/line/webhook', { method: 'POST', body: rawBody, headers }));
    const respondedBeforeGas = route.calls.length === 0;
    await route.runAfter();
    return {
        status: res.status,
        json: await res.json(),
        respondedBeforeGas,
        calls: route.calls.map(([url, init]) => ({ url, init, body: JSON.parse(init.body) })),
        logs: route.logs,
    };
}

test('signature: base64 HMAC-SHA256 of the raw body with the channel secret, compared in constant time', async () => {
    const body = payload(textEvent(CODE));
    assert.equal(await lineSignature(CHANNEL_SECRET, body), sign(body));
    assert.equal(await isValidLineSignature(CHANNEL_SECRET, body, sign(body)), true);
    assert.equal(await isValidLineSignature(CHANNEL_SECRET, body, null), false);
    assert.equal(await isValidLineSignature('', body, sign(body)), false);
    const source = fs.readFileSync(new URL('../lib/line-webhook.ts', import.meta.url), 'utf8');
    assert.match(source, /constantTimeEqual\(/);
    const route = fs.readFileSync(new URL('../app/api/line/webhook/route.ts', import.meta.url), 'utf8');
    assert.match(route, /request\.text\(\)/);
    assert.doesNotMatch(route, /request\.json\(\)/, 'the raw text is verified, never a re-serialized JSON');
    assert.ok(route.indexOf('isValidLineSignature') < route.indexOf('JSON.parse'), 'verify before parse');
});

test('a correctly signed code message: 200 at once, then authLinkLine with key + authKey (after the response)', async () => {
    const body = payload(textEvent(` ${CODE.toLowerCase()}\n`));
    const res = await deliver(body);
    assert.equal(res.status, 200);
    assert.ok(res.respondedBeforeGas, 'GAS is called after the response (after())');
    assert.equal(res.calls.length, 1);
    assert.deepEqual(res.calls[0].body, { action: 'authLinkLine', code: CODE, lineUserId: LINE_USER, key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY });
    // no LINE reply without LINE_CHANNEL_ACCESS_TOKEN on this side
});

test('invalid, missing or wrong-key signatures and altered raw bodies are 401 and forward nothing', async () => {
    const body = payload(textEvent(CODE));
    const reformatted = JSON.stringify(JSON.parse(body), null, 2); // same JSON, other bytes
    const cases = [
        ['missing', body, null],
        ['empty', body, ''],
        ['garbage', body, 'not-base64!!'],
        ['other secret', body, createHmac('sha256', 'other-secret').update(body).digest('base64')],
        ['body altered (code)', body.replace(CODE, 'ZZZZZZZZZZ'), sign(body)],
        ['body altered (whitespace only)', reformatted, sign(body)],
        ['hex instead of base64', body, createHmac('sha256', CHANNEL_SECRET).update(body).digest('hex')],
    ];
    for (const [label, raw, signature] of cases) {
        const res = await deliver(raw, { signature });
        assert.equal(res.status, 401, label);
        assert.deepEqual(res.json, { error: 'Unauthorized' }, label);
        assert.equal(res.calls.length, 0, label);
        for (const s of [CODE, LINE_USER, CHANNEL_SECRET]) assert.ok(res.logs.every(line => !line.includes(s)), label);
    }
    // the reformatted body with its own correct signature is accepted
    assert.equal((await deliver(reformatted)).status, 200);
});

test('without LINE_CHANNEL_SECRET the webhook refuses everything (503) and parses nothing', async () => {
    const body = payload(textEvent(CODE));
    const res = await deliver(body, { env: { LINE_CHANNEL_SECRET: undefined } });
    assert.equal(res.status, 503);
    assert.equal(res.calls.length, 0);
});

test('signed requests without a code are 200 and forward nothing (verification ping, other messages, groups, redeliveries, junk)', async () => {
    const bodies = [
        JSON.stringify({ destination: 'Usyntheticbot', events: [] }), // LINE's "Verify" button
        payload(textEvent('こんにちは')),
        payload(textEvent('K7M2P9QX4')), // 9 characters
        payload(textEvent('K7M2P9QX4R1')),
        payload(textEvent('K7M2P9QX0R')), // 0 is not in the alphabet
        payload(textEvent(`code ${CODE}`)),
        payload({ ...textEvent(CODE), source: { type: 'group', groupId: 'Cgroup', userId: LINE_USER } }),
        payload({ ...textEvent(CODE), source: { type: 'user', userId: 'not-a-line-user' } }),
        payload({ ...textEvent(CODE), message: { type: 'sticker', id: '1' } }),
        payload({ ...textEvent(CODE), deliveryContext: { isRedelivery: true } }),
        payload({ ...textEvent(CODE), mode: 'standby' }),
        payload({ type: 'follow', source: { type: 'user', userId: LINE_USER }, replyToken: 'x' }),
        'not json',
        '[]',
        'null',
    ];
    for (const body of bodies) {
        const res = await deliver(body);
        assert.equal(res.status, 200, body);
        assert.equal(res.calls.length, 0, body);
    }
});

test('GAS refusals (rate limit, wrong code) and failures still answer 200; only fixed words are logged', async () => {
    for (const upstream of [() => ({ error: 'RateLimited' }), () => ({ error: 'LinkCodeInvalid' }), () => { throw new Error(`down ${DUMMY_KEY} ${DUMMY_AUTH_KEY}`); }]) {
        const res = await deliver(payload(textEvent(CODE)), { upstream, env: { LINE_CHANNEL_ACCESS_TOKEN: ACCESS_TOKEN } });
        assert.equal(res.status, 200);
        assert.equal(res.calls.length, 1, 'no LINE reply when the code did not match');
        for (const s of [CODE, LINE_USER, CHANNEL_SECRET, DUMMY_KEY, DUMMY_AUTH_KEY, ACCESS_TOKEN, 'synthetic-reply-token']) {
            assert.ok(res.logs.every(line => !line.includes(s)), `${s}: ${res.logs.join(' | ')}`);
        }
    }
});

test('a matched code is answered on LINE only when LINE_CHANNEL_ACCESS_TOKEN is set (reply API, success only)', async () => {
    const res = await deliver(payload(textEvent(CODE)), { env: { LINE_CHANNEL_ACCESS_TOKEN: ACCESS_TOKEN } });
    assert.equal(res.status, 200);
    assert.equal(res.calls.length, 2);
    const reply = res.calls[1];
    assert.equal(reply.url, 'https://api.line.me/v2/bot/message/reply');
    assert.equal(reply.init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.deepEqual(reply.body, { replyToken: 'synthetic-reply-token', messages: [{ type: 'text', text: LINK_ACCEPTED_REPLY }] });
    for (const s of [ACCESS_TOKEN, CODE, LINE_USER]) assert.ok(res.logs.every(line => !line.includes(s)));
});

test('several codes in one delivery are forwarded one by one, at most MAX_FORWARDED_PER_WEBHOOK', async () => {
    const events = Array.from({ length: MAX_FORWARDED_PER_WEBHOOK + 3 }, (_, i) => textEvent(CODE, { source: { type: 'user', userId: i % 2 ? OTHER_USER : LINE_USER } }));
    const res = await deliver(payload(...events));
    assert.equal(res.status, 200);
    assert.equal(res.calls.length, MAX_FORWARDED_PER_WEBHOOK);
    assert.deepEqual(linkCodeMessages(JSON.parse(payload(textEvent(CODE)))), [{ code: CODE, lineUserId: LINE_USER, replyToken: 'synthetic-reply-token' }]);
});

test('an oversized body is refused before parsing', async () => {
    const big = payload(textEvent(CODE), ...Array.from({ length: 3000 }, () => textEvent('x'.repeat(60))));
    const res = await deliver(big);
    assert.equal(res.status, 401);
    assert.equal(res.calls.length, 0);
});
