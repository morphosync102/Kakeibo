import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createSession, SESSION_TTL_SECONDS } from '../lib/session.ts';
import { runBrowserChecks } from './statistics-search.browser.mjs';

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

export async function runSecurityAndFeatureChecks() {
    // Per-run credentials stay in memory. The app cannot reach the live GAS URL.
    const password = randomBytes(24).toString('hex');
    const secret = randomBytes(32).toString('hex');
    let upstreamCalls = 0;
    const upstream = createServer((request, response) => {
        upstreamCalls++;
        request.resume();
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.method === 'POST' ? { success: true } : []));
    });
    const upstreamPort = await listen(upstream);
    const reserve = createServer();
    const port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const baseURL = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, APP_PASSWORD: password, SESSION_SECRET: secret, GAS_API_URL: `http://127.0.0.1:${upstreamPort}`, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startupLog = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { startupLog = (startupLog + chunk).slice(-8000); });
    let browser;
    try {
        let ready = false;
        for (let attempt = 0; attempt < 150; attempt++) {
            if (server.exitCode !== null) throw new Error(`Local test server stopped: ${startupLog}`);
            try { ready = (await fetch(`${baseURL}/login`)).ok; } catch { /* Wait for listening. */ }
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(ready, 'local server starts');
        const expired = await createSession(secret, Date.now() - (SESSION_TTL_SECONDS + 1) * 1000);
        const valid = await createSession(secret);
        const tampered = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a');
        for (const token of ['', 'authenticated', 'synthetic-test', expired, tampered]) {
            const headers = token ? { Cookie: `kakeibo_session=${token}` } : {};
            for (const path of ['/', '/statistics', '/calendar', '/manage', '/yahoo', '/yahoo/statistics', '/yahoo/calendar', '/yahoo/manage']) {
                const response = await fetch(baseURL + path, { headers, redirect: 'manual' });
                assert.equal(response.status, 307, `rejects invalid session on ${path}`);
                assert.equal(new URL(response.headers.get('location'), baseURL).pathname, '/login');
            }
            for (const method of ['GET', 'POST']) {
                const response = await fetch(`${baseURL}/api/expenses?source=yahoo`, {
                    method, headers, ...(method === 'POST' ? { body: '{}' } : {}), redirect: 'manual',
                });
                assert.equal(response.status, 401, `${method} rejects invalid session`);
            }
        }
        assert.equal(upstreamCalls, 0, 'invalid requests never reach upstream');
        const incorrect = await fetch(`${baseURL}/api/auth/verify`, { method: 'POST', body: JSON.stringify({ password: randomBytes(16).toString('hex') }) });
        assert.equal(incorrect.status, 401);
        assert.equal(incorrect.headers.get('set-cookie'), null);
        const login = await fetch(`${baseURL}/api/auth/verify`, { method: 'POST', body: JSON.stringify({ password }) });
        assert.equal(login.status, 200);
        const cookieHeader = login.headers.get('set-cookie');
        assert.match(cookieHeader, /HttpOnly/);
        assert.match(cookieHeader, /Secure/);
        assert.match(cookieHeader, /SameSite=strict/i);
        assert.match(cookieHeader, /Max-Age=2592000/);
        const cookie = cookieHeader.split(';')[0];
        assert.equal((await fetch(`${baseURL}/statistics`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 200);
        assert.equal((await fetch(`${baseURL}/api/expenses`, { headers: { Cookie: cookie } })).status, 200);
        assert.equal((await fetch(`${baseURL}/api/expenses`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ action: 'addTransaction', source: 'main' }) })).status, 200);
        assert.equal(upstreamCalls, 2, 'authenticated requests reach only local fake upstream');
        console.log('PASS security: 40 page redirects, 10 API rejections, zero unauthorized upstream calls, real login and signed-cookie API access');
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
        console.log(await runBrowserChecks(await browser.newPage(), baseURL, password));
    } finally {
        await browser?.close();
        if (server.exitCode === null) {
            const stopped = once(server, 'exit');
            server.kill('SIGTERM');
            await stopped;
        }
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
    }
}

if (process.argv.includes('--run')) await runSecurityAndFeatureChecks();
