import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSession, isSessionSecretConfigured, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { postLoginPath } from '@/lib/access';
import { CHALLENGE_COOKIE, challengeCookieOptions, LOGIN_BINDING, readChallengeToken } from '@/lib/webauthn-challenge';
import { parseAuthenticationResponse, webauthnConfig } from '@/lib/webauthn';
import { NO_STORE, readJsonObject } from '@/lib/passkey-flow';
import { verifyPasskeyAssertion } from '@/lib/passkey-assertion';
import { ACTIVE_COOKIE, activeCookieOptions, createActiveToken } from '@/lib/active-session';

// Passkey login, step 2 (design §3.6): purpose=login challenge cookie
// (deleted by every answer) -> GAS authGetCredential -> signature, origin,
// rpID, user verification, counter and userHandle == owner ->
// authRecordCredentialUse (one-time challenge) -> passkey session (amr=pk)
// and the app lock's active cookie (§3.12: this login also unlocks).
// The answer is { success, userId, redirectTo } (returnTo validated by
// postLoginPath; the client uses userId only for its cache housekeeping).

export async function POST(request: Request) {
    const env = process.env;
    const challengeCookie = (await cookies()).get(CHALLENGE_COOKIE)?.value;
    const respond = (body: Record<string, unknown>, status = 200) => {
        const response = NextResponse.json(body, { status, headers: NO_STORE });
        if (challengeCookie !== undefined) response.cookies.set(CHALLENGE_COOKIE, '', challengeCookieOptions(env, 0));
        return response;
    };

    const config = webauthnConfig(env);
    const secret = env.SESSION_SECRET;
    if (!config || !isSessionSecretConfigured(secret)) {
        console.error('Passkey login is not configured (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET).');
        return respond({ error: 'Service Unavailable' }, 503);
    }
    const body = await readJsonObject(request);
    const credentialResponse = parseAuthenticationResponse(body?.response);
    if (!credentialResponse) return respond({ error: 'Invalid request' }, 400);
    const claims = await readChallengeToken(challengeCookie, secret, { purposes: ['login'], binding: LOGIN_BINDING });
    if (!claims) return respond({ error: 'ChallengeInvalid' }, 400);

    const result = await verifyPasskeyAssertion({ config, env, fetchImpl: fetch, response: credentialResponse, challenge: claims.challenge, log: console });
    if (!result.ok) return respond({ error: result.failure.error }, result.failure.status);

    const response = respond({ success: true, userId: result.user.userId, redirectTo: postLoginPath(body?.returnTo, result.user) });
    response.cookies.set(SESSION_COOKIE, await createSession(secret, { ...result.user, amr: 'pk' }), sessionCookieOptions(env));
    response.cookies.set(ACTIVE_COOKIE, await createActiveToken(secret, result.user), activeCookieOptions(env));
    return response;
}
