import { NextResponse } from 'next/server';
import { revalidateTag, unstable_cache } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { isAllowedSource, parseGasList, redactSecret, toGasBody, toGasQuery, withGasKey } from '@/lib/expenses-proxy';

// This URL will be updated with the user's new deployment URL
const GAS_API_URL = process.env.GAS_API_URL || '';

// Vercel function limit: longer than the client write timeout (45s), which
// itself covers GAS's 20s lock wait plus a cold start and the write.
export const maxDuration = 60;

const FIXED_COST_ACTIONS = ['getFixedCosts', 'addFixedCost', 'deleteFixedCost'];

// Shared secret GAS checks as `key` (IMPROVEMENTS 4-1). Read per request; while
// unset (migration period) no key is sent. Never logged or returned.
function gasSecret() {
    return process.env.GAS_PROXY_SECRET || undefined;
}

// Raw GAS read, never cached itself. GAS reports failures (including
// {error: 'Unauthorized'}) as a 200 `{ error }`, so parseGasList throws for
// anything but an array. `query` is the cache key and never holds the secret;
// the key is attached only here, for the outgoing request.
async function fetchGasList(query: string) {
    const upstream = withGasKey(query, gasSecret());
    const url = upstream ? `${GAS_API_URL}?${upstream}` : GAS_API_URL;
    const res = await fetch(url, {
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`GAS responded ${res.status}`);
    return parseGasList(await res.json());
}

// Cached for 5 minutes per query, invalidated by the POST handler's revalidateTag.
// unstable_cache stores a result only after the callback resolves, so a GAS
// error (thrown above) is never cached. The plain fetch cache would store any
// 200 response asynchronously, which revalidateTag cannot reliably evict.
// A GET that started before a write can still store its pre-write list after
// the POST's revalidateTag; refetches after writes therefore use `fresh=1`
// (below), and the short revalidate bounds how long such an entry lives.
// It also bounds the delay before email-imported rows appear (IMPROVEMENTS 5-5).
const LIST_CACHE_SECONDS = 300;
const getCachedList = {
    expenses: unstable_cache(fetchGasList, ['gas-list', 'expenses'], { revalidate: LIST_CACHE_SECONDS, tags: ['expenses'] }),
    fixedCosts: unstable_cache(fetchGasList, ['gas-list', 'fixedCosts'], { revalidate: LIST_CACHE_SECONDS, tags: ['fixedCosts'] }),
};

function invalidSource() {
    return NextResponse.json({ error: 'Invalid source' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

async function isAuthenticated() {
    return verifySession((await cookies()).get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
}

export async function GET(request: Request) {
    if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const { searchParams } = new URL(request.url);
    if (!isAllowedSource(searchParams.get('source') ?? undefined)) return invalidSource();
    try {
        // fresh=1 (refetch after a write, manual refresh): read GAS directly.
        // Neither `fresh` nor a client `key` is forwarded or part of the cache key.
        const fresh = searchParams.get('fresh') === '1';
        const query = toGasQuery(searchParams);
        const tag = searchParams.get('action') === 'getFixedCosts' ? 'fixedCosts' : 'expenses';
        const data = fresh ? await fetchGasList(query) : await getCachedList[tag](query);
        return NextResponse.json(data);
    } catch (error) {
        // Message only (no cause/stack objects), with the secret masked
        const message = error instanceof Error ? error.message : String(error);
        console.error(`GAS list fetch failed: ${redactSecret(message, gasSecret())}`);
        return NextResponse.json({ error: 'Bad Gateway' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
}

export async function POST(request: Request) {
    if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    try {
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body) || !isAllowedSource(body.source)) {
            return invalidSource();
        }
        const res = await fetch(GAS_API_URL, {
            method: 'POST',
            cache: 'no-store', // POST requests should not be cached
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toGasBody(body, gasSecret()))
        });

        if (!res.ok) throw new Error('Failed to post to GAS');
        const data = await res.json();

        // Expire immediately (not 'max' = stale-while-revalidate) so the refetch after a write sees it
        if (FIXED_COST_ACTIONS.includes(body.action)) {
            revalidateTag('fixedCosts', { expire: 0 });
        } else {
            revalidateTag('expenses', { expire: 0 });
        }

        return NextResponse.json(data);
    } catch {
        return NextResponse.json({ error: 'Post Error' }, { status: 500 });
    }
}
