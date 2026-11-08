import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { WRITE_ACTIONS, gasErrorStatus, isAllowedSource, parseGasList, redactSecret, toGasBody, toGasQuery, withGasAuth } from '../lib/expenses-proxy.ts';
import { createSession } from '../lib/session.ts';
import { loadRoute, setCookieValue, SYNTHETIC_GAS_URL } from './helpers/load-route.mjs';

// Synthetic values only
const secret = randomBytes(32).toString('hex');
const DUMMY_KEY = 'dummy-gas-proxy-secret';
const DUMMY_AUTH_KEY = 'dummy-gas-auth-proxy-secret';
const ADMIN = { userId: 'u_admin_synthetic', epoch: 7, sources: ['main', 'yahoo'], homeSource: 'main' };
const YUKI = { userId: 'u_member_synthetic', epoch: 2, sources: ['yuki', 'main'], homeSource: 'yuki' };
const BASE_ENV = { SESSION_SECRET: secret, APP_PASSWORD: 'synthetic-password', GAS_AUTH_PROXY_SECRET: DUMMY_AUTH_KEY };

const session = (user = ADMIN, amr = 'pk') => createSession(secret, { ...user, amr });

async function route({ upstream = args => (args[1]?.method === 'POST' ? { success: true } : []), env = {}, user = ADMIN, amr = 'pk', cookie } = {}) {
  return loadRoute('app/api/expenses/route.ts', {
    env: { ...BASE_ENV, ...env },
    cookie: cookie === undefined ? await session(user, amr) : cookie,
    upstream,
  });
}

const getReq = (query = '') => new Request(`http://localhost/api/expenses${query}`);
const postReq = (body) => new Request('http://localhost/api/expenses', { method: 'POST', body: JSON.stringify(body) });
const sentQuery = (r) => new URL(r.calls.at(-1)[0]).searchParams;
const sentBody = (r) => JSON.parse(r.calls.at(-1)[1].body);

// ---------------------------------------------------------------- helpers

test('the proxy accepts only an omitted source, "main", "yahoo" or "yuki"', () => {
  for (const ok of [undefined, null, 'main', 'yahoo', 'yuki']) assert.equal(isAllowedSource(ok), true, String(ok));
  for (const bad of ['', 'Yahoo', 'MAIN', 'Yuki', 'other', 'yahoo ', 1, {}, [], true]) assert.equal(isAllowedSource(bad), false, JSON.stringify(bad));
});

test('only an array from GAS is a cacheable list; anything else throws with the GAS error code', () => {
  assert.deepEqual(parseGasList([]), []);
  assert.deepEqual(parseGasList([{ id: 1 }]), [{ id: 1 }]);
  assert.throws(() => parseGasList({ error: 'Busy' }), /Busy/);
  assert.throws(() => parseGasList({ error: 'SessionRevoked' }), e => e.gasError === 'SessionRevoked');
  for (const bad of [null, undefined, 'text', 1, {}]) assert.throws(() => parseGasList(bad));
});

test('WRITE_ACTIONS is exactly the GAS write allowlist', () => {
  const gas = fs.readFileSync(new URL('../gas/コード.js', import.meta.url), 'utf8');
  const block = /const WRITE_ACTIONS = \[([^\]]*)\]/.exec(gas)[1];
  const gasActions = [...block.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]);
  assert.deepEqual([...WRITE_ACTIONS], gasActions);
  assert.ok(!WRITE_ACTIONS.some(a => a.startsWith('auth')));
});

test('GAS errors map to statuses: SessionRevoked 401, Forbidden 403, AuthUnavailable 503, others none', () => {
  assert.equal(gasErrorStatus('SessionRevoked'), 401);
  assert.equal(gasErrorStatus('Forbidden'), 403);
  assert.equal(gasErrorStatus('AuthUnavailable'), 503);
  for (const other of ['Unauthorized', 'Invalid actor', 'Busy', 'Invalid source', undefined, null, 1]) assert.equal(gasErrorStatus(other), null);
});

test('helpers strip client-controlled fields and attach key, authKey and the actor only from the server', () => {
  const actor = { userId: 'u_admin_synthetic', epoch: 7 };
  const client = 'source=yahoo&fresh=1&key=x&authKey=y&actorUserId=u_forged&actorEpoch=99&action=getFixedCosts';
  assert.equal(toGasQuery(new URLSearchParams(client)), 'source=yahoo&action=getFixedCosts');
  const query = new URLSearchParams(withGasAuth('source=yahoo', { key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY, actor }));
  assert.deepEqual(Object.fromEntries(query), { source: 'yahoo', key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY, actorUserId: 'u_admin_synthetic', actorEpoch: '7' });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(withGasAuth('', { authKey: DUMMY_AUTH_KEY, actor }))), { authKey: DUMMY_AUTH_KEY, actorUserId: 'u_admin_synthetic', actorEpoch: '7' });

  const body = { action: 'a', source: 'main', key: 'x', authKey: 'y', actorUserId: 'u_forged', actorEpoch: 99, merchant: 'M' };
  assert.deepEqual(toGasBody(body, { key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY, actor }),
    { action: 'a', source: 'main', merchant: 'M', key: DUMMY_KEY, authKey: DUMMY_AUTH_KEY, actorUserId: 'u_admin_synthetic', actorEpoch: 7 });
  assert.deepEqual(toGasBody(body, { authKey: DUMMY_AUTH_KEY, actor }),
    { action: 'a', source: 'main', merchant: 'M', authKey: DUMMY_AUTH_KEY, actorUserId: 'u_admin_synthetic', actorEpoch: 7 });
});

test('redactSecret masks every given secret, URL-encoded forms included', () => {
  const a = 'ab+c/d=e f';
  const b = 'other secret&x';
  const url = `https://example.invalid/exec?${new URLSearchParams({ key: a, authKey: b })}&x=${encodeURIComponent(a)}`;
  const masked = redactSecret(`fetch failed: ${url} ${a} ${b}`, a, b, undefined, '');
  for (const s of [a, b]) {
    assert.ok(!masked.includes(s));
    assert.ok(!masked.includes(encodeURIComponent(s)));
    assert.ok(!masked.includes(new URLSearchParams({ k: s }).toString().slice(2)));
  }
  assert.equal(redactSecret('plain', undefined), 'plain');
});

// ---------------------------------------------------------------- caching

test('a GAS {error} answer is returned as 502 and never cached; the next GET asks GAS again', async () => {
  let answer = { error: 'Busy' };
  const r = await route({ upstream: () => answer });
  assert.equal((await r.GET(getReq('?source=yahoo'))).status, 502);
  assert.equal(r.store.size, 0);
  answer = [{ id: 'synthetic' }];
  const ok = await r.GET(getReq('?source=yahoo'));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), [{ id: 'synthetic' }]);
  assert.equal(r.calls.length, 2, 'the error was not served from cache');
  await r.GET(getReq('?source=yahoo'));
  assert.equal(r.calls.length, 2, 'a successful list is cached');
});

test('lists are cached for 5 minutes per tag and query, the raw GAS fetch bypasses the fetch cache, and writes expire the tag', async () => {
  const r = await route();
  await r.GET(getReq('?action=getFixedCosts&source=main'));
  await r.GET(getReq('?source=main'));
  assert.deepEqual(JSON.parse(JSON.stringify(r.cacheOptions)), [
    { keyParts: ['gas-list', 'fixedCosts', 'action=getFixedCosts&source=main'], options: { revalidate: 300, tags: ['fixedCosts'] } },
    { keyParts: ['gas-list', 'expenses', 'source=main'], options: { revalidate: 300, tags: ['expenses'] } },
  ]);
  assert.ok(r.calls.every(([, init]) => init.cache === 'no-store' && !init.next));
  assert.deepEqual([...r.store.values()].map(v => v.tags[0]).sort(), ['expenses', 'fixedCosts']);

  await r.POST(postReq({ action: 'deleteFixedCost', source: 'main', id: 0 }));
  assert.deepEqual(JSON.parse(JSON.stringify(r.revalidated)), [['fixedCosts', { expire: 0 }]]);
  assert.deepEqual([...r.store.values()].map(v => v.tags[0]), ['expenses']);
});

test('the cache key holds neither secrets nor the actor; the cache is per source and shared by the users who may read it', async () => {
  const r = await route({ env: { GAS_PROXY_SECRET: DUMMY_KEY } });
  await r.GET(getReq('?source=main&key=client&authKey=client&actorUserId=u_forged&actorEpoch=1'));
  const keys = JSON.stringify(r.cachedCalls) + JSON.stringify(r.cacheOptions) + JSON.stringify([...r.store.keys()]);
  for (const s of [DUMMY_KEY, DUMMY_AUTH_KEY, ADMIN.userId, 'actorUserId', 'actorEpoch', 'authKey', 'client', 'u_forged']) {
    assert.ok(!keys.includes(s), `cache key contains ${s}`);
  }

  // Yuki reads main from the entry filled for the admin: the list depends only on the source
  const yuki = await loadRoute('app/api/expenses/route.ts', { env: { ...BASE_ENV }, cookie: await session(YUKI), upstream: () => [] });
  yuki.store.set([...r.store.keys()][0], [...r.store.values()][0]);
  await yuki.GET(getReq('?source=main'));
  assert.equal(yuki.calls.length, 0, 'served from the shared per-source entry');
  // ...but the permission check comes first: a cached yahoo list is never read for Yuki
  await r.GET(getReq('?source=yahoo'));
  for (const [key, value] of r.store) yuki.store.set(key, value);
  const before = yuki.cachedCalls.length;
  assert.equal((await yuki.GET(getReq('?source=yahoo'))).status, 403);
  assert.equal(yuki.cachedCalls.length, before);
});

test('fresh=1 bypasses unstable_cache, reads GAS without the fresh flag, and is still validated', async () => {
  let answer = [{ id: 'old' }];
  const r = await route({ upstream: () => answer });
  await r.GET(getReq('?source=yahoo')); // cached
  answer = [{ id: 'new' }];
  const fresh = await r.GET(getReq('?source=yahoo&fresh=1'));
  assert.deepEqual(await fresh.json(), [{ id: 'new' }]);
  assert.equal(r.cachedCalls.length, 1, 'fresh must not go through unstable_cache');
  assert.equal(r.calls.at(-1)[0].split('?')[0], SYNTHETIC_GAS_URL);
  assert.equal(sentQuery(r).get('source'), 'yahoo');
  assert.equal(sentQuery(r).get('fresh'), null);
  assert.equal(r.calls.at(-1)[1].cache, 'no-store');

  await r.GET(getReq('?fresh=1&action=getFixedCosts'));
  assert.equal(sentQuery(r).get('action'), 'getFixedCosts');
  answer = { error: 'Busy' };
  assert.equal((await r.GET(getReq('?fresh=1'))).status, 502, 'fresh answers are validated as arrays too');
  const callsBefore = r.calls.length;
  assert.equal((await r.GET(getReq('?fresh=1&source=Yahoo'))).status, 400);
  assert.equal(r.calls.length, callsBefore, 'source is checked before GAS is called');
});

// ---------------------------------------------------------------- source permission

test('a source outside the session is 403 for GET (cached and fresh) and POST, without calling GAS', async () => {
  const cases = [
    [ADMIN, 'yuki'],
    [YUKI, 'yahoo'],
  ];
  for (const [user, source] of cases) {
    const r = await route({ user });
    for (const query of [`?source=${source}`, `?source=${source}&fresh=1`, `?source=${source}&action=getFixedCosts`]) {
      const res = await r.GET(getReq(query));
      assert.equal(res.status, 403, `${user.userId} ${query}`);
      assert.deepEqual(await res.json(), { error: 'Forbidden' });
    }
    for (const action of ['addTransaction', 'updateCategory', 'deleteFixedCost']) {
      assert.equal((await r.POST(postReq({ action, source }))).status, 403);
    }
    assert.equal(r.calls.length, 0);
    assert.equal(r.cachedCalls.length, 0);
    assert.equal(r.revalidated.length, 0);
  }
});

test('an omitted source means main: allowed for both users (an account without main would get 403)', async () => {
  for (const user of [ADMIN, YUKI]) {
    const r = await route({ user });
    assert.equal((await r.GET(getReq(''))).status, 200);
    assert.equal((await r.POST(postReq({ action: 'addTransaction' }))).status, 200);
  }
  const r = await route({ user: { userId: 'u_yuki_only', epoch: 0, sources: ['yuki'], homeSource: 'yuki' } });
  assert.equal((await r.GET(getReq(''))).status, 403);
  assert.equal((await r.POST(postReq({ action: 'addTransaction' }))).status, 403);
  assert.equal(r.calls.length, 0);
});

test('each user reaches their own sources (yuki included for Yuki)', async () => {
  const yuki = await route({ user: YUKI });
  for (const source of ['yuki', 'main']) {
    assert.equal((await yuki.GET(getReq(`?source=${source}`))).status, 200);
    assert.equal((await yuki.POST(postReq({ action: 'updateCategory', source, merchant: 'M', category: 'C' }))).status, 200);
  }
  const admin = await route({ user: ADMIN });
  for (const source of ['main', 'yahoo']) assert.equal((await admin.GET(getReq(`?source=${source}`))).status, 200);
});

test('GET and POST reject an invalid source with 400 without calling GAS', async () => {
  const r = await route();
  for (const query of ['?source=Yahoo', '?source=', '?source=other', '?action=getFixedCosts&source=MAIN']) {
    const res = await r.GET(getReq(query));
    assert.equal(res.status, 400, query);
    assert.deepEqual(await res.json(), { error: 'Invalid source' });
  }
  for (const body of [{ action: 'addTransaction', source: 'Yahoo' }, { action: 'addTransaction', source: '' }, { action: 'x', source: 1 }, [], 'text', null]) {
    assert.equal((await r.POST(postReq(body))).status, 400, JSON.stringify(body));
  }
  assert.equal(r.calls.length, 0);
  assert.equal(r.revalidated.length, 0);
});

// ---------------------------------------------------------------- POST allowlist

test('POST forwards only WRITE_ACTIONS; auth and unknown actions are 400 without calling GAS', async () => {
  const r = await route();
  for (const action of ['authGetAdminUser', 'authAddCredential', 'authRecordCredentialUse', 'authBumpEpoch', 'authLinkLine', 'version', 'getFixedCosts', 'ingestEmail', '', undefined, 1, 'addtransaction', 'toString', '__proto__']) {
    const res = await r.POST(postReq({ action, source: 'main', bootstrap: true }));
    assert.equal(res.status, 400, String(action));
    assert.deepEqual(await res.json(), { error: 'Unknown action' });
  }
  assert.equal(r.calls.length, 0);
  assert.equal(r.revalidated.length, 0);
  for (const action of WRITE_ACTIONS) assert.equal((await r.POST(postReq({ action, source: 'main' }))).status, 200, action);
  assert.equal(r.calls.length, WRITE_ACTIONS.length);
});

// ---------------------------------------------------------------- actor and keys

test('GET sends key, authKey and the session actor; client-supplied ones are dropped', async () => {
  const r = await route({ env: { GAS_PROXY_SECRET: DUMMY_KEY }, user: YUKI });
  for (const query of ['?source=yuki&key=c&authKey=c&actorUserId=u_admin_synthetic&actorEpoch=7', '?source=yuki&fresh=1&key=c&authKey=c&actorUserId=u_admin_synthetic&actorEpoch=7']) {
    await r.GET(getReq(query));
    const sent = sentQuery(r);
    assert.deepEqual(sent.getAll('key'), [DUMMY_KEY]);
    assert.deepEqual(sent.getAll('authKey'), [DUMMY_AUTH_KEY]);
    assert.deepEqual(sent.getAll('actorUserId'), [YUKI.userId]);
    assert.deepEqual(sent.getAll('actorEpoch'), [String(YUKI.epoch)]);
    assert.equal(sent.get('source'), 'yuki');
  }
});

test('POST sends key, authKey and the session actor; client-supplied ones are overridden', async () => {
  const r = await route({ env: { GAS_PROXY_SECRET: DUMMY_KEY }, upstream: () => ({ success: true }) });
  const res = await r.POST(postReq({ action: 'addTransaction', source: 'yahoo', key: 'c', authKey: 'c', actorUserId: 'u_member_synthetic', actorEpoch: 0, merchant: 'X' }));
  const sent = sentBody(r);
  assert.equal(sent.key, DUMMY_KEY);
  assert.equal(sent.authKey, DUMMY_AUTH_KEY);
  assert.equal(sent.actorUserId, ADMIN.userId);
  assert.equal(sent.actorEpoch, ADMIN.epoch);
  assert.equal(sent.merchant, 'X');
  const text = JSON.stringify(await res.json());
  for (const s of [DUMMY_KEY, DUMMY_AUTH_KEY]) assert.ok(!text.includes(s), 'secrets are never returned');
});

test('without GAS_PROXY_SECRET no key is sent (migration), but authKey and the actor still are', async () => {
  const r = await route();
  await r.GET(getReq('?source=main&key=c'));
  assert.equal(sentQuery(r).get('key'), null);
  assert.equal(sentQuery(r).get('authKey'), DUMMY_AUTH_KEY);
  await r.POST(postReq({ action: 'addTransaction', source: 'main', key: 'c' }));
  assert.equal('key' in sentBody(r), false);
  assert.equal(sentBody(r).authKey, DUMMY_AUTH_KEY);
});

test('without GAS_AUTH_PROXY_SECRET the proxy fails closed (503) instead of sending an actor-less request', async () => {
  const r = await route({ env: { GAS_AUTH_PROXY_SECRET: undefined } });
  for (const res of [await r.GET(getReq('?source=main')), await r.GET(getReq('?source=main&fresh=1')), await r.POST(postReq({ action: 'addTransaction', source: 'main' }))]) {
    assert.equal(res.status, 503);
  }
  assert.equal(r.calls.length, 0);
});

// ---------------------------------------------------------------- GAS errors

test('GAS SessionRevoked is 401 and deletes the cookie (GET cached / fresh and POST); never cached', async () => {
  const r = await route({ upstream: () => ({ error: 'SessionRevoked' }) });
  for (const res of [await r.GET(getReq('?source=main')), await r.GET(getReq('?source=main&fresh=1')), await r.POST(postReq({ action: 'addTransaction', source: 'main' }))]) {
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Unauthorized' });
    assert.equal(setCookieValue(res), '');
    assert.match(res.headers.get('set-cookie'), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  }
  assert.equal(r.store.size, 0);
  assert.equal(r.revalidated.length, 0);
});

test('GAS Forbidden is 403 and AuthUnavailable is 503, for GET and POST', async () => {
  for (const [error, status] of [['Forbidden', 403], ['AuthUnavailable', 503]]) {
    const r = await route({ upstream: () => ({ error }) });
    for (const res of [await r.GET(getReq('?source=main')), await r.GET(getReq('?source=main&fresh=1')), await r.POST(postReq({ action: 'addTransaction', source: 'main' }))]) {
      assert.equal(res.status, status, error);
      assert.equal(setCookieValue(res), null, 'the cookie is kept');
    }
    assert.equal(r.store.size, 0);
    assert.equal(r.revalidated.length, 0);
  }
});

test('other GAS errors: GET answers 502, POST passes {error} through; secrets never reach logs or responses', async () => {
  const r = await route({ upstream: () => ({ error: 'Unauthorized' }), env: { GAS_PROXY_SECRET: DUMMY_KEY } });
  const get = await r.GET(getReq('?source=main'));
  assert.equal(get.status, 502);
  assert.equal(setCookieValue(get), null, 'a GAS Unauthorized (proxy misconfiguration) does not log the user out');
  const post = await r.POST(postReq({ action: 'addTransaction', source: 'main' }));
  const body = await post.json();
  assert.equal(body.error, 'Unauthorized');
  assert.notEqual(body.success, true);

  // A transport error that mentions the request URL (which carries both secrets)
  const failing = await route({
    env: { GAS_PROXY_SECRET: DUMMY_KEY },
    upstream: () => { throw new Error(`connect failed for ${SYNTHETIC_GAS_URL}?key=${DUMMY_KEY}&authKey=${encodeURIComponent(DUMMY_AUTH_KEY)} ${DUMMY_AUTH_KEY}`); },
  });
  const failed = await failing.GET(getReq('?source=main&fresh=1'));
  assert.equal(failed.status, 502);
  const failedPost = await failing.POST(postReq({ action: 'addTransaction', source: 'main' }));
  assert.equal(failedPost.status, 500);
  const text = JSON.stringify(await failed.json()) + JSON.stringify(await failedPost.json());
  assert.ok(failing.logs.length > 0, 'the failure is still logged');
  for (const s of [DUMMY_KEY, DUMMY_AUTH_KEY]) {
    assert.ok(!text.includes(s));
    assert.ok(failing.logs.every(line => !line.includes(s)), `logs leaked a secret: ${failing.logs.join(' | ')}`);
  }
});

// ---------------------------------------------------------------- sessions

test('without APP_PASSWORD a password session is 401 for GET (cached path included) and POST, reading neither GAS nor the cache', async () => {
  const r = await route({ amr: 'pwd', env: { APP_PASSWORD: undefined } });
  for (const res of [await r.GET(getReq('?source=main')), await r.GET(getReq('?source=main&fresh=1')), await r.POST(postReq({ action: 'addTransaction', source: 'main' }))]) {
    assert.equal(res.status, 401);
  }
  assert.equal(r.calls.length, 0);
  assert.equal(r.cachedCalls.length, 0);
  // with APP_PASSWORD (migration period) the same session works; passkey sessions work without it
  assert.equal((await (await route({ amr: 'pwd' })).GET(getReq('?source=main'))).status, 200);
  assert.equal((await (await route({ amr: 'pk', env: { APP_PASSWORD: undefined } })).GET(getReq('?source=main'))).status, 200);
});

test('the route allows 60s of execution, longer than the client write timeout', async () => {
  const r = await route();
  const { WRITE_TIMEOUT_MS } = await import('../lib/write-queue.ts');
  assert.equal(r.maxDuration, 60);
  assert.ok(r.maxDuration * 1000 > WRITE_TIMEOUT_MS);
});

test('fetchExpenses asks for fresh data only when requested', async (t) => {
  const { fetchExpenses } = await import('../lib/api.ts');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return Response.json([]); });
  await fetchExpenses('main');
  await fetchExpenses('yahoo');
  await fetchExpenses('yahoo', { fresh: true });
  await fetchExpenses('main', { fresh: true });
  assert.deepEqual(urls, ['/api/expenses?source=main', '/api/expenses?source=yahoo', '/api/expenses?source=yahoo&fresh=1', '/api/expenses?source=main&fresh=1']);
});
