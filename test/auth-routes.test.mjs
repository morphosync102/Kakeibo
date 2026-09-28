import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const secret = randomBytes(32).toString('hex');

// Execute actual route code with only framework cookies/cache and the upstream
// transport stubbed. This deliberately bypasses middleware to test API defense.
async function loadRoute(path, token, env = {}) {
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    const calls = [];
    const session = await import('../lib/session.ts');
    vm.runInNewContext(code, {
        exports, process: { env: { SESSION_SECRET: secret, GAS_API_URL: 'http://localhost/synthetic-upstream', ...env } },
        Request, Response, URL, console,
        fetch: async (...args) => { calls.push(args); return Response.json({ success: true }); },
        require: name => {
            if (name === '@/lib/session') return session;
            if (name === 'next/headers') return { cookies: async () => ({ get: () => token ? { value: token } : undefined }) };
            if (name === 'next/cache') return { revalidateTag() {} };
            return require(name);
        },
    });
    return { ...exports, calls };
}

test('GET and POST reject missing/legacy sessions without invoking GAS even without middleware', async () => {
    for (const token of [undefined, 'authenticated', 'forged']) {
        const route = await loadRoute('../app/api/expenses/route.ts', token);
        assert.equal((await route.GET(new Request('http://localhost/api/expenses'))).status, 401);
        assert.equal((await route.POST(new Request('http://localhost/api/expenses', { method: 'POST', body: '{}' }))).status, 401);
        assert.equal(route.calls.length, 0);
    }
});

test('API accepts valid sessions and rejects expired/tampered sessions or missing server key', async () => {
    const { createSession, SESSION_TTL_SECONDS } = await import('../lib/session.ts');
    const valid = await createSession(secret);
    for (const token of [await createSession(secret, Date.now() - (SESSION_TTL_SECONDS + 1) * 1000), valid + 'x']) {
        const route = await loadRoute('../app/api/expenses/route.ts', token);
        assert.equal((await route.GET(new Request('http://localhost/api/expenses'))).status, 401);
        assert.equal(route.calls.length, 0);
    }
    const missingKey = await loadRoute('../app/api/expenses/route.ts', valid, { SESSION_SECRET: undefined });
    assert.equal((await missingKey.GET(new Request('http://localhost/api/expenses'))).status, 401);
    assert.equal(missingKey.calls.length, 0);
    const route = await loadRoute('../app/api/expenses/route.ts', valid);
    assert.equal((await route.GET(new Request('http://localhost/api/expenses?source=yahoo'))).status, 200);
    assert.equal((await route.POST(new Request('http://localhost/api/expenses', { method: 'POST', body: JSON.stringify({ action: 'addTransaction', source: 'yahoo' }) }))).status, 200);
    assert.equal(route.calls.length, 2);
    assert.equal(route.calls[0][0], 'http://localhost/synthetic-upstream?source=yahoo');
});

test('login issues secure signed cookies only for correct passwords; missing config fails closed', async () => {
    const password = randomBytes(24).toString('hex');
    const route = await loadRoute('../app/api/auth/verify/route.ts', undefined, { APP_PASSWORD: password, NODE_ENV: 'production' });
    const request = value => new Request('http://localhost/api/auth/verify', { method: 'POST', body: JSON.stringify({ password: value }) });
    for (const value of [null, {}, randomBytes(12).toString('hex')]) {
        const response = await route.POST(request(value));
        assert.ok(response.status >= 400);
        assert.equal(response.headers.get('set-cookie'), null);
    }
    const response = await route.POST(request(password));
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=strict/i);
    assert.match(cookie, /Path=\//);
    const token = /kakeibo_session=([^;]+)/.exec(cookie)[1];
    const { verifySession } = await import('../lib/session.ts');
    assert.equal(await verifySession(token, secret), true);
    const noKey = await loadRoute('../app/api/auth/verify/route.ts', undefined, { APP_PASSWORD: password, SESSION_SECRET: undefined });
    assert.equal((await noKey.POST(request(password))).status, 500);
});
