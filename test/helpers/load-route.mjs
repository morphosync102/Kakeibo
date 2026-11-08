// Shared harness: runs a real Next.js route handler (TypeScript, transpiled to
// CommonJS) in a VM with only the framework (cookies, cache) and the upstream
// transport stubbed. `@/lib/*` imports resolve to the real modules.
// Not a test file itself (node --test runs it as an empty file).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

export const SYNTHETIC_GAS_URL = 'http://localhost/synthetic-upstream';

// upstream(args) answers each fetch (its return value is sent as JSON; a throw
// is a transport error). cookie: the kakeibo_session value or undefined.
// cookies: other request cookies by name (e.g. kakeibo_webauthn).
export async function loadRoute(path, { env = {}, cookie, cookies = {}, upstream = () => [] } = {}) {
    const code = ts.transpileModule(fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    const calls = [];
    const revalidated = [];
    const store = new Map();
    const cacheOptions = [];
    const cachedCalls = [];
    const logs = [];
    const libs = {
        '@/lib/session': await import('../../lib/session.ts'),
        '@/lib/expenses-proxy': await import('../../lib/expenses-proxy.ts'),
        '@/lib/access': await import('../../lib/access.ts'),
        '@/lib/gas-auth': await import('../../lib/gas-auth.ts'),
        '@/lib/webauthn': await import('../../lib/webauthn.ts'),
        '@/lib/webauthn-challenge': await import('../../lib/webauthn-challenge.ts'),
        '@/lib/passkey-flow': await import('../../lib/passkey-flow.ts'),
        '@/lib/passkey-assertion': await import('../../lib/passkey-assertion.ts'),
        '@/lib/line-webhook': await import('../../lib/line-webhook.ts'),
        '@/lib/sources': await import('../../lib/sources.ts'),
        '@/lib/active-session': await import('../../lib/active-session.ts'),
        '@/lib/app-lock': await import('../../lib/app-lock.ts'),
    };
    // next/server's after(): collected here and run by runAfter() (the
    // response is returned first, as on Vercel)
    const afterTasks = [];
    const nextServer = { ...require('next/server'), after: task => { afterTasks.push(task); } };
    const runAfter = async () => {
        while (afterTasks.length > 0) await afterTasks.shift()();
    };
    const log = (...args) => logs.push(args.map(String).join(' '));
    vm.runInNewContext(code, {
        exports,
        process: { env: { GAS_API_URL: SYNTHETIC_GAS_URL, ...env } },
        Request, Response, URL, URLSearchParams, TextEncoder, crypto,
        console: { ...console, error: log, log, warn: log, info: log },
        fetch: async (...args) => { calls.push(args); return Response.json(await upstream(args)); },
        require: name => {
            if (name in libs) return libs[name];
            if (name === 'next/server') return nextServer;
            if (name === 'next/headers') return {
                cookies: async () => ({
                    get: n => {
                        if (n === 'kakeibo_session') return cookie ? { value: cookie } : undefined;
                        return Object.prototype.hasOwnProperty.call(cookies, n) && cookies[n] !== undefined ? { value: cookies[n] } : undefined;
                    },
                }),
            };
            if (name === 'next/cache') return {
                revalidateTag: (tag, profile) => {
                    revalidated.push([tag, profile]);
                    for (const key of [...store.keys()]) if (store.get(key).tags.includes(tag)) store.delete(key);
                },
                // Mirrors Next 16: a result is stored only after the callback
                // resolves, keyed by keyParts + arguments.
                unstable_cache: (fn, keyParts, options) => {
                    cacheOptions.push({ keyParts, options });
                    return async (...args) => {
                        cachedCalls.push({ keyParts, args });
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
    return { ...exports, calls, revalidated, store, cacheOptions, cachedCalls, logs, runAfter, afterTasks };
}

// The kakeibo_session value a response sets ('' when it deletes the cookie), or
// null. Decoded as Next decodes request cookies ('+' travels as %2B).
export function setCookieValue(response) {
    const header = response.headers.get('set-cookie');
    if (!header) return null;
    const match = /kakeibo_session=([^;]*)/.exec(header);
    return match ? decodeURIComponent(match[1]) : null;
}
