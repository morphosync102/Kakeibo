import { NextResponse } from 'next/server';
import {
    constantTimeEqual, createSession, isPasswordLoginEnabled, isSessionSecretConfigured,
    normalizeSessionUser, SESSION_COOKIE, sessionCookieOptions,
} from '@/lib/session';
import { postLoginPath } from '@/lib/access';
import { callGasAuth } from '@/lib/gas-auth';

// Password login, migration period only (design §3.10). The password is shared,
// so it cannot tell who typed it: it always issues the admin's v2 session
// (amr=pwd) from GAS authGetAdminUser. Removing APP_PASSWORD disables this
// route (404) and invalidates every amr=pwd session (lib/session.ts).

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(error: string, status: number) {
    return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
    const env = process.env;
    if (!isPasswordLoginEnabled(env)) return fail('Not Found', 404);
    const secret = env.SESSION_SECRET;
    if (!isSessionSecretConfigured(secret)) {
        console.error('Authentication configuration is missing (SESSION_SECRET).');
        return fail('Server configuration error', 500);
    }

    let password: unknown;
    let returnTo: unknown;
    try {
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid request', 400);
        ({ password, returnTo } = body as Record<string, unknown>);
    } catch {
        return fail('Invalid request', 400);
    }
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return fail('Invalid request', 400);
    if (!await constantTimeEqual(password, env.APP_PASSWORD as string)) return fail('Incorrect password', 401);

    // Only after the password matched: who is the admin, at which epoch?
    const result = await callGasAuth('authGetAdminUser', {}, { env, fetchImpl: fetch });
    if (!result.ok) {
        // No session without exactly one active admin row
        const status = result.error === 'AdminNotFound' || result.error === 'AdminAmbiguous' ? 500 : 503;
        console.error(`Password login: authGetAdminUser failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return fail(status === 500 ? 'Server configuration error' : 'Service Unavailable', status);
    }
    const raw = result.data.user;
    const user = raw && typeof raw === 'object' && (raw as Record<string, unknown>).role === 'admin' ? normalizeSessionUser(raw) : null;
    if (!user) {
        console.error('Password login: authGetAdminUser returned an invalid user.');
        return fail('Server configuration error', 500);
    }

    const response = NextResponse.json(
        { success: true, userId: user.userId, redirectTo: postLoginPath(returnTo, user) },
        { headers: NO_STORE },
    );
    response.cookies.set(SESSION_COOKIE, await createSession(secret, { ...user, amr: 'pwd' }), sessionCookieOptions(env));
    return response;
}
