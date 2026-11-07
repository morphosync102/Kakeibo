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
async function loadRoute(upstream) {
  const code = ts.transpileModule(fs.readFileSync(join(__dirname, '../app/api/expenses/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const calls = [];
  const revalidated = [];
  const store = new Map();
  const cacheOptions = [];
  const cachedCalls = [];
  const session = await import('../lib/session.ts');
  const proxy = await import('../lib/expenses-proxy.ts');
  const token = await session.createSession(secret);
  vm.runInNewContext(code, {
    exports, process: { env: { SESSION_SECRET: secret, GAS_API_URL: 'http://localhost/synthetic-upstream' } },
    Request, Response, URL, URLSearchParams, console: { ...console, error: () => {} },
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
  return { ...exports, calls, revalidated, store, cacheOptions, cachedCalls };
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
