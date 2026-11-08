import { NextResponse } from 'next/server';
import { revalidateTag, unstable_cache } from 'next/cache';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, sessionCookieOptions, type Session } from '@/lib/session';
import {
    effectiveSource, gasErrorStatus, GasResponseError, isAllowedSource, isWriteAction, parseGasList,
    redactSecret, toGasBody, toGasQuery, withGasAuth, type GasCredentials,
} from '@/lib/expenses-proxy';

// This URL will be updated with the user's new deployment URL
const GAS_API_URL = process.env.GAS_API_URL || '';

// Vercel function limit: longer than the client write timeout (45s), which
// itself covers GAS's 20s lock wait plus a cold start and the write.
export const maxDuration = 60;

const FIXED_COST_ACTIONS = ['getFixedCosts', 'addFixedCost', 'deleteFixedCost'];
const NO_STORE = { 'Cache-Control': 'no-store' };

// Shared secrets, read per request, never logged or returned:
// - GAS_PROXY_SECRET: `key` (IMPROVEMENTS 4-1; unset = migration period, not sent)
// - GAS_AUTH_PROXY_SECRET: `authKey`, sent with the session's actor (design §5.6-5.7)
function gasSecrets() {
    return { key: process.env.GAS_PROXY_SECRET || undefined, authKey: process.env.GAS_AUTH_PROXY_SECRET || undefined };
}

function redact(text: string) {
    const { key, authKey } = gasSecrets();
    return redactSecret(text, key, authKey);
}

// Raw GAS read, never cached itself. GAS reports failures (including
// {error: 'Unauthorized'}) as a 200 `{ error }`, so parseGasList throws for
// anything but an array. `query` never holds a secret or the actor; they are
// attached only here, for the outgoing request.
async function fetchGasList(query: string, credentials: GasCredentials) {
    const upstream = withGasAuth(query, credentials);
    const url = upstream ? `${GAS_API_URL}?${upstream}` : GAS_API_URL;
    const res = await fetch(url, {
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`GAS responded ${res.status}`);
    return parseGasList(await res.json());
}

// Cached for 5 minutes per tag and query (= per source and action), invalidated
// by the POST handler's revalidateTag. The key is only the query: neither the
// secrets nor the actor are part of it, so one entry serves every user who may
// read that source (the list depends only on the source; access is checked
// before the cache is read). The callback closes over the actor only to answer
// a miss. unstable_cache stores a result only after the callback resolves, so a
// GAS error (thrown above) is never cached. The plain fetch cache would store
// any 200 response asynchronously, which revalidateTag cannot reliably evict.
// A GET that started before a write can still store its pre-write list after
// the POST's revalidateTag; refetches after writes therefore use `fresh=1`
// (below), and the short revalidate bounds how long such an entry lives.
// It also bounds the delay before email-imported rows appear (IMPROVEMENTS 5-5)
// and before an epoch revocation reaches cached reads (design §5.7).
const LIST_CACHE_SECONDS = 300;
function getCachedList(tag: 'expenses' | 'fixedCosts', query: string, credentials: GasCredentials) {
    return unstable_cache(() => fetchGasList(query, credentials), ['gas-list', tag, query], { revalidate: LIST_CACHE_SECONDS, tags: [tag] })();
}

function json(body: unknown, status: number) {
    return NextResponse.json(body, { status, headers: NO_STORE });
}

// 401 also deletes the cookie: the session is invalid or was revoked in GAS.
// The client clears its kakeibo_ localStorage and goes to /login (lib/api.ts,
// lib/write-queue.ts).
function unauthorized() {
    const response = json({ error: 'Unauthorized' }, 401);
    response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

const ERROR_BODIES: Record<401 | 403 | 503, string> = { 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' };

function errorResponse(status: 401 | 403 | 503) {
    return status === 401 ? unauthorized() : json({ error: ERROR_BODIES[status] }, status);
}

async function currentSession() {
    return readSession((await cookies()).get(SESSION_COOKIE)?.value, process.env);
}

// Checks shared by GET and POST, before GAS or the cache is touched: the
// session (signature, expiry, amr=pwd after APP_PASSWORD removal), the source
// against the session's sources, and the auth proxy secret (an actor is
// always sent, so a missing authKey fails closed instead of sending an
// actor-less request).
function authorize(session: Session, source: string): { credentials: GasCredentials } | { response: NextResponse } {
    if (!session.sources.includes(effectiveSource(source))) return { response: json({ error: 'Forbidden' }, 403) };
    const { key, authKey } = gasSecrets();
    if (!authKey) {
        console.error('GAS_AUTH_PROXY_SECRET is not configured; refusing to call GAS.');
        return { response: json({ error: 'Service Unavailable' }, 503) };
    }
    return { credentials: { key, authKey, actor: { userId: session.userId, epoch: session.epoch } } };
}

export async function GET(request: Request) {
    const session = await currentSession();
    if (!session) return unauthorized();
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') ?? undefined;
    if (!isAllowedSource(source)) return json({ error: 'Invalid source' }, 400);
    const auth = authorize(session, effectiveSource(source));
    if ('response' in auth) return auth.response;
    try {
        // fresh=1 (refetch after a write, manual refresh): read GAS directly.
        // Neither `fresh` nor client server-fields are forwarded or part of the cache key.
        const fresh = searchParams.get('fresh') === '1';
        const query = toGasQuery(searchParams);
        const tag = searchParams.get('action') === 'getFixedCosts' ? 'fixedCosts' : 'expenses';
        const data = fresh ? await fetchGasList(query, auth.credentials) : await getCachedList(tag, query, auth.credentials);
        return NextResponse.json(data);
    } catch (error) {
        const status = error instanceof GasResponseError ? gasErrorStatus(error.gasError) : null;
        // Message only (no cause/stack objects), with the secrets masked
        const message = error instanceof Error ? error.message : String(error);
        console.error(`GAS list fetch failed: ${redact(message)}`);
        if (status) return errorResponse(status);
        return json({ error: 'Bad Gateway' }, 502);
    }
}

export async function POST(request: Request) {
    const session = await currentSession();
    if (!session) return unauthorized();
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Invalid request' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid source' }, 400);
    const record = body as Record<string, unknown>;
    if (!isAllowedSource(record.source)) return json({ error: 'Invalid source' }, 400);
    // Writes only: auth actions (auth*) and anything else never reach GAS from here
    if (!isWriteAction(record.action)) return json({ error: 'Unknown action' }, 400);
    const auth = authorize(session, effectiveSource(record.source));
    if ('response' in auth) return auth.response;
    try {
        const res = await fetch(GAS_API_URL, {
            method: 'POST',
            cache: 'no-store', // POST requests should not be cached
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toGasBody(record, auth.credentials)),
        });

        if (!res.ok) throw new Error(`GAS responded ${res.status}`);
        const data = await res.json();

        const status = data && typeof data === 'object' ? gasErrorStatus((data as { error?: unknown }).error) : null;
        if (status) return errorResponse(status); // nothing was written

        // Expire immediately (not 'max' = stale-while-revalidate) so the refetch after a write sees it
        if (FIXED_COST_ACTIONS.includes(record.action as string)) {
            revalidateTag('fixedCosts', { expire: 0 });
        } else {
            revalidateTag('expenses', { expire: 0 });
        }

        return NextResponse.json(data);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`GAS write failed: ${redact(message)}`);
        return json({ error: 'Post Error' }, 500);
    }
}
