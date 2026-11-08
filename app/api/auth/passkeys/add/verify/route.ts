import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSession, isSessionSecretConfigured, readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { CHALLENGE_COOKIE, challengeCookieOptions, readChallengeToken, sha256Hex } from '@/lib/webauthn-challenge';
import { labelFromUserAgent, parseRegistrationResponse, verifyRegistration, webauthnConfig } from '@/lib/webauthn';
import { failureFromGas, NO_STORE, readJsonObject } from '@/lib/passkey-flow';

// Add a passkey, last step (design §3.3). Accepts only the registration
// challenge issued after a passkey re-authentication: purpose=add, bound to
// the session userId; deleted by every answer (the password bootstrap of the
// migration period was removed in U6). GAS authAddCredential checks the
// actor's epoch, the one-time challenge and an existing passkey.

export async function POST(request: Request) {
    const env = process.env;
    const jar = await cookies();
    const challengeCookie = jar.get(CHALLENGE_COOKIE)?.value;
    const respond = (body: Record<string, unknown>, status = 200, revokeSession = false) => {
        const response = NextResponse.json(body, { status, headers: NO_STORE });
        if (challengeCookie !== undefined) response.cookies.set(CHALLENGE_COOKIE, '', challengeCookieOptions(env, 0));
        if (revokeSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(env, 0));
        return response;
    };

    const config = webauthnConfig(env);
    const secret = env.SESSION_SECRET;
    if (!config || !isSessionSecretConfigured(secret)) {
        console.error('Passkeys are not configured (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET).');
        return respond({ error: 'Service Unavailable' }, 503);
    }
    const session = await readSession(jar.get(SESSION_COOKIE)?.value, env);
    if (!session) return respond({ error: 'Unauthorized' }, 401, true);
    const body = await readJsonObject(request);
    const credentialResponse = parseRegistrationResponse(body?.response);
    if (!credentialResponse) return respond({ error: 'Invalid request' }, 400);
    const claims = await readChallengeToken(challengeCookie, secret, { purposes: ['add'], binding: session.userId });
    if (!claims) return respond({ error: 'ChallengeInvalid' }, 400);

    const credential = await verifyRegistration(config, credentialResponse, claims.challenge, labelFromUserAgent(request.headers.get('user-agent')));
    if (!credential) return respond({ error: 'VerificationFailed' }, 400);

    const result = await callGasAuth('authAddCredential', {
        actorUserId: session.userId,
        actorEpoch: session.epoch,
        challengeHash: await sha256Hex(claims.challenge),
        credential,
    }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`Add passkey: authAddCredential failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return respond({ error: failure.error }, failure.status, failure.revokeSession);
    }
    const credentialCount = typeof result.data.credentialCount === 'number' ? result.data.credentialCount : null;
    const response = respond({ success: true, credentialCount });
    // Re-authenticated with a passkey: a fresh passkey session
    response.cookies.set(SESSION_COOKIE, await createSession(secret, { ...session, amr: 'pk' }), sessionCookieOptions(env));
    return response;
}
