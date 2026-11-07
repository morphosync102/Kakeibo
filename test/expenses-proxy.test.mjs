import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { isAllowedSource, parseGasList } from '../lib/expenses-proxy.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const secret = randomBytes(32).toString('hex');

test('the proxy accepts only an omitted source, "main" or "yahoo"', () => {
  for (const ok of [undefined, null, 'main', 'yahoo']) assert.equal(isAllowedSource(ok), true, String(ok));
  for (const bad of ['', 'Yahoo', 'MAIN', 'other', 'yahoo ', 1, {}, [], true]) assert.equal(isAllowedSource(bad), false, JSON.stringify(bad));
});

test('only an array from GAS is a cacheable list; anything else throws', () => {
  assert.deepEqual(parseGasList([]), []);
  assert.deepEqual(parseGasList([{ id: 1 }]), [{ id: 1 }]);
  assert.throws(() => parseGasList({ error: 'Busy' }), /Busy/);
  assert.throws(() => parseGasList({ error: 'Invalid source' }), /Invalid source/);
  for (const bad of [null, undefined, 'text', 1, {}]) assert.throws(() => parseGasList(bad));
});

// Run the real route with Next's cache/cookies and the GAS transport stubbed.
// The unstable_cache stub mirrors Next 16: a result is stored only after the
// callback resolves (cacheNewResult), keyed by keyParts + arguments.
async function loadRoute(upstream, env = {}) {
  const code = ts.transpileModule(fs.readFileSync(join(__dirname, '../app/api/expenses/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const calls = [];
  const revalidated = [];
  const store = new Map();
  const cacheOptions = [];
  const cachedCalls = [];
  const logs = [];
  const session = await import('../lib/session.ts');
  const proxy = await import('../lib/expenses-proxy.ts');
  const token = await session.createSession(secret);
  vm.runInNewContext(code, {
    exports, process: { env: { SESSION_SECRET: secret, GAS_API_URL: 'http://localhost/synthetic-upstream', ...env } },
    Request, Response, URL, URLSearchParams,
    console: { ...console, error: (...args) => logs.push(args.map(String).join(' ')), log: (...args) => logs.push(args.map(String).join(' ')), warn: (...args) => logs.push(args.map(String).join(' ')) },
    fetch: async (...args) => { calls.push(args); return Response.json(upstream(args)); },
    require: name => {
      if (name === '@/lib/session') return session;
      if (name === '@/lib/expenses-proxy') return proxy;
      if (name === 'next/headers') return { cookies: async () => ({ get: () => ({ value: token }) }) };
      if (name === 'next/cache') return {
        revalidateTag: (tag, profile) => {
          revalidated.push([tag, profile]);
          for (const key of [...store.keys()]) if (store.get(key).tags.includes(tag)) store.delete(key);
        },
        unstable_cache: (fn, keyParts, options) => {
          cacheOptions.push({ keyParts, options });
          return async (...args) => {
            cachedCalls.push(args);
            const key = JSON.stringify([keyParts, args]);
            if (store.has(key)) return store.get(key).value;
            const value = await fn(...args);
            store.set(key, { value, tags: options.tags });
            return value;
          };
        },
      };
      return require(name);
    },
  });
  return { ...exports, calls, revalidated, store, cacheOptions, cachedCalls, logs };
}

const getReq = (query = '') => new Request(`http://localhost/api/expenses${query}`);
const postReq = (body) => new Request('http://localhost/api/expenses', { method: 'POST', body: JSON.stringify(body) });

test('a GAS {error} answer is returned as 502 and never cached; the next GET asks GAS again', async () => {
  let answer = { error: 'Busy' };
  const route = await loadRoute(() => answer);
  const failed = await route.GET(getReq('?source=yahoo'));
  assert.equal(failed.status, 502);
  assert.equal(route.store.size, 0);
  answer = [{ id: 'synthetic' }];
  const ok = await route.GET(getReq('?source=yahoo'));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), [{ id: 'synthetic' }]);
  assert.equal(route.calls.length, 2, 'the error was not served from cache');
  await route.GET(getReq('?source=yahoo'));
  assert.equal(route.calls.length, 2, 'a successful list is cached');
});

test('lists are cached for 5 minutes under their tag, the raw GAS fetch bypasses the fetch cache, and writes expire the tag', async () => {
  const route = await loadRoute(args => (args[1]?.method === 'POST' ? { success: true } : []));
  const tags = JSON.parse(JSON.stringify(route.cacheOptions.map(c => [c.options.tags[0], c.options.revalidate])));
  assert.deepEqual(tags.sort(), [['expenses', 300], ['fixedCosts', 300]]);
  await route.GET(getReq('?action=getFixedCosts'));
  await route.GET(getReq());
  assert.ok(route.calls.every(([, init]) => init.cache === 'no-store' && !init.next));
  assert.deepEqual([...route.store.values()].map(v => v.tags[0]).sort(), ['expenses', 'fixedCosts']);

  await route.POST(postReq({ action: 'deleteFixedCost', id: 0 }));
  assert.deepEqual(JSON.parse(JSON.stringify(route.revalidated)), [['fixedCosts', { expire: 0 }]]);
  assert.deepEqual([...route.store.values()].map(v => v.tags[0]), ['expenses']);
});

test('GET and POST reject an invalid source with 400 without calling GAS', async () => {
  const route = await loadRoute(() => []);
  for (const query of ['?source=Yahoo', '?source=', '?source=other', '?action=getFixedCosts&source=MAIN']) {
    const res = await route.GET(getReq(query));
    assert.equal(res.status, 400, query);
    assert.deepEqual(await res.json(), { error: 'Invalid source' });
  }
  for (const body of [{ action: 'addTransaction', source: 'Yahoo' }, { action: 'addTransaction', source: '' }, { action: 'x', source: 1 }, [], 'text']) {
    assert.equal((await route.POST(postReq(body))).status, 400, JSON.stringify(body));
  }
  assert.equal(route.calls.length, 0);
  assert.equal(route.revalidated.length, 0);

  for (const query of ['', '?source=main', '?source=yahoo']) assert.equal((await route.GET(getReq(query))).status, 200, query);
  for (const source of [undefined, 'main', 'yahoo']) assert.equal((await route.POST(postReq({ action: 'addTransaction', source }))).status, 200);
});

test('fresh=1 bypasses unstable_cache, reads GAS without the fresh flag, and is still validated', async () => {
  let answer = [{ id: 'old' }];
  const route = await loadRoute(() => answer);
  await route.GET(getReq('?source=yahoo')); // cached
  answer = [{ id: 'new' }];
  const fresh = await route.GET(getReq('?source=yahoo&fresh=1'));
  assert.deepEqual(await fresh.json(), [{ id: 'new' }]);
  assert.equal(route.cachedCalls.length, 1, 'fresh must not go through unstable_cache');
  assert.equal(route.calls.at(-1)[0], 'http://localhost/synthetic-upstream?source=yahoo');
  assert.equal(route.calls.at(-1)[1].cache, 'no-store');

  await route.GET(getReq('?fresh=1&action=getFixedCosts'));
  assert.equal(route.calls.at(-1)[0], 'http://localhost/synthetic-upstream?action=getFixedCosts');
  await route.GET(getReq('?fresh=1'));
  assert.equal(route.calls.at(-1)[0], 'http://localhost/synthetic-upstream');

  answer = { error: 'Busy' };
  assert.equal((await route.GET(getReq('?fresh=1'))).status, 502, 'fresh answers are validated as arrays too');
  const callsBefore = route.calls.length;
  assert.equal((await route.GET(getReq('?fresh=1&source=Yahoo'))).status, 400);
  assert.equal(route.calls.length, callsBefore, 'source is checked before GAS is called');
  assert.equal(route.cachedCalls.length, 1);
});

test('the route allows 60s of execution, longer than the client write timeout', async () => {
  const route = await loadRoute(() => []);
  const { WRITE_TIMEOUT_MS } = await import('../lib/write-queue.ts');
  assert.equal(route.maxDuration, 60);
  assert.ok(route.maxDuration * 1000 > WRITE_TIMEOUT_MS);
});

test('fetchExpenses asks for fresh data only when requested', async (t) => {
  const { fetchExpenses } = await import('../lib/api.ts');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return Response.json([]); });
  await fetchExpenses();
  await fetchExpenses('yahoo');
  await fetchExpenses('yahoo', { fresh: true });
  await fetchExpenses(undefined, { fresh: true });
  assert.deepEqual(urls, ['/api/expenses', '/api/expenses?source=yahoo', '/api/expenses?source=yahoo&fresh=1', '/api/expenses?fresh=1']);
});

// ---------------------------------------------------------------- GAS proxy key (4-1)

const DUMMY_KEY = 'dummy-gas-proxy-secret';

test('with GAS_PROXY_SECRET, GET sends the key to GAS but never in the cache key; client keys are dropped', async () => {
  const route = await loadRoute(() => [], { GAS_PROXY_SECRET: DUMMY_KEY });
  await route.GET(getReq('?source=yahoo&key=client-supplied'));
  const url = new URL(route.calls.at(-1)[0]);
  assert.equal(url.searchParams.get('key'), DUMMY_KEY);
  assert.deepEqual(url.searchParams.getAll('key'), [DUMMY_KEY], 'the client key is replaced, not added to');
  assert.equal(url.searchParams.get('source'), 'yahoo');
  assert.ok(!JSON.stringify(route.cachedCalls).includes(DUMMY_KEY), 'the secret must not be part of the cache key');
  assert.ok(!JSON.stringify(route.cachedCalls).includes('client-supplied'), 'client keys must not split the cache');

  await route.GET(getReq('?fresh=1&key=client-supplied'));
  const freshUrl = new URL(route.calls.at(-1)[0]);
  assert.deepEqual(freshUrl.searchParams.getAll('key'), [DUMMY_KEY]);
  assert.equal(freshUrl.searchParams.get('fresh'), null);
});

test('with GAS_PROXY_SECRET, POST sends the key in the body and overrides a client key', async () => {
  const route = await loadRoute(() => ({ success: true }), { GAS_PROXY_SECRET: DUMMY_KEY });
  const res = await route.POST(postReq({ action: 'addTransaction', source: 'yahoo', key: 'client-supplied', merchant: 'X' }));
  const sent = JSON.parse(route.calls.at(-1)[1].body);
  assert.equal(sent.key, DUMMY_KEY);
  assert.equal(sent.merchant, 'X');
  assert.ok(!JSON.stringify(await res.json()).includes(DUMMY_KEY), 'the key is never returned to the client');
});

test('without GAS_PROXY_SECRET no key is sent and client keys are still dropped', async () => {
  const route = await loadRoute(args => (args[1]?.method === 'POST' ? { success: true } : []));
  await route.GET(getReq('?key=client-supplied'));
  assert.equal(new URL(route.calls.at(-1)[0]).searchParams.get('key'), null);
  await route.POST(postReq({ action: 'addTransaction', key: 'client-supplied' }));
  assert.equal('key' in JSON.parse(route.calls.at(-1)[1].body), false);
});

test('GAS Unauthorized: GET answers 502, POST passes {error} through; the key never reaches logs or responses', async () => {
  const route = await loadRoute(() => ({ error: 'Unauthorized' }), { GAS_PROXY_SECRET: DUMMY_KEY });
  const get = await route.GET(getReq());
  assert.equal(get.status, 502);
  const post = await route.POST(postReq({ action: 'addTransaction' }));
  const body = await post.json();
  assert.equal(body.error, 'Unauthorized');
  assert.notEqual(body.success, true);

  // A transport error that mentions the request URL (which carries the key)
  const failing = await loadRoute(() => { throw new Error(`connect failed for http://localhost/synthetic-upstream?key=${DUMMY_KEY}`); }, { GAS_PROXY_SECRET: DUMMY_KEY });
  const failed = await failing.GET(getReq('?fresh=1'));
  assert.equal(failed.status, 502);
  assert.ok(!JSON.stringify(await failed.json()).includes(DUMMY_KEY));
  assert.ok(failing.logs.length > 0, 'the failure is still logged');
  assert.ok(failing.logs.every(line => !line.includes(DUMMY_KEY)), `logs leaked the key: ${failing.logs.join(' | ')}`);
});

test('proxy helpers strip client-controlled params and attach the key only when configured', async () => {
  const { toGasQuery, withGasKey, toGasBody } = await import('../lib/expenses-proxy.ts');
  assert.equal(toGasQuery(new URLSearchParams('source=yahoo&fresh=1&key=x&action=getFixedCosts')), 'source=yahoo&action=getFixedCosts');
  assert.equal(withGasKey('source=yahoo', DUMMY_KEY), `source=yahoo&key=${DUMMY_KEY}`);
  assert.equal(withGasKey('', DUMMY_KEY), `key=${DUMMY_KEY}`);
  assert.equal(withGasKey('source=yahoo', undefined), 'source=yahoo');
  assert.equal(withGasKey('source=yahoo', ''), 'source=yahoo');
  assert.deepEqual(toGasBody({ action: 'a', key: 'x' }, DUMMY_KEY), { action: 'a', key: DUMMY_KEY });
  assert.deepEqual(toGasBody({ action: 'a', key: 'x' }, undefined), { action: 'a' });
});

test('redactSecret masks URL-encoded forms of the secret too', async () => {
  const { redactSecret } = await import('../lib/expenses-proxy.ts');
  const secret = 'ab+c/d=e f';
  const url = `https://example.invalid/exec?${new URLSearchParams({ key: secret })}&x=${encodeURIComponent(secret)}`;
  const masked = redactSecret(`fetch failed: ${url} ${secret}`, secret);
  assert.ok(!masked.includes(secret));
  assert.ok(!masked.includes(encodeURIComponent(secret)));
  assert.ok(!masked.includes(new URLSearchParams({ k: secret }).toString().slice(2)));
});
