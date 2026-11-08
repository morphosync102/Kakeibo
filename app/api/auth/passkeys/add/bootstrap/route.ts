import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
    constantTimeEqual, isPasswordLoginEnabled, isSessionSecretConfigured, readSession, SESSION_COOKIE, sessionCookieOptions,
} from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { CHALLENGE_COOKIE, challengeCookieOptions, createChallengeToken, newChallenge } from '@/lib/webauthn-challenge';
import { registrationOptions, webauthnConfig } from '@/lib/webauthn';
import { failureFromGas, NO_STORE, readJsonObject } from '@/lib/passkey-flow';

// Add a passkey, bootstrap only (design §3.3, §3.10): the admin's FIRST
// passkey, with APP_PASSWORD re-entered instead of a passkey re-authentication.
// Only while APP_PASSWORD is set (404 otherwise) and only for a user with no
// passkey (403); GAS checks role=admin and zero passkeys again on add
// (authAddCredential bootstrap). On success: a registration challenge in a
// purpose=bootstrap cookie bound to the session userId.

function fail(error: string, status: number, revokeSession = false) {
    const response = NextResponse.json({ error }, { status, headers: NO_STORE });
    if (revokeSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

export async function POST(request: Request) {
    const env = process.env;
    if (!isPasswordLoginEnabled(env)) return fail('Not Found', 404);
    const config = webauthnConfig(env);
    const secret = env.SESSION_SECRET;
    if (!config || !isSessionSecretConfigured(secret)) {
        console.error('Passkeys are not configured (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET).');
        return fail('Service Unavailable', 503);
    }
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return fail('Unauthorized', 401, true);

    const body = await readJsonObject(request);
    const password = body?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return fail('Invalid request', 400);
    if (!await constantTimeEqual(password, env.APP_PASSWORD as string)) return fail('Incorrect password', 401);

    const listed = await callGasAuth('authListCredentials', { actorUserId: session.userId, actorEpoch: session.epoch }, { env, fetchImpl: fetch });
    if (!listed.ok) {
        const failure = failureFromGas(listed.error);
        if (failure.status >= 500) console.error(`Bootstrap passkey: authListCredentials failed (${listed.error}${listed.detail ? `: ${listed.detail}` : ''})`);
        return fail(failure.error, failure.status, failure.revokeSession);
    }
    // A user with a passkey re-authenticates with it, never with the password
    if (!Array.isArray(listed.data.credentials) || listed.data.credentials.length !== 0) return fail('NotAllowed', 403);

    const challenge = newChallenge();
    const options = await registrationOptions(config, { userId: session.userId, challenge, exclude: [] });
    const response = NextResponse.json({ options }, { headers: NO_STORE });
    response.cookies.set(CHALLENGE_COOKIE, await createChallengeToken(secret, { purpose: 'bootstrap', challenge, binding: session.userId }), challengeCookieOptions(env));
    return response;
}
