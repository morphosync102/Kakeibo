import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
    createSession, isPasswordLoginEnabled, isSessionSecretConfigured, readSession, SESSION_COOKIE, sessionCookieOptions,
} from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { CHALLENGE_COOKIE, challengeCookieOptions, readChallengeToken, sha256Hex } from '@/lib/webauthn-challenge';
import { labelFromUserAgent, parseRegistrationResponse, verifyRegistration, webauthnConfig } from '@/lib/webauthn';
import { failureFromGas, NO_STORE, readJsonObject } from '@/lib/passkey-flow';

// Add a passkey, last step (design §3.3). Accepts only the registration
// challenge issued after a re-authentication: purpose=add (passkey reauth) or
// purpose=bootstrap (password re-entry), bound to the session userId; deleted
// by every answer. GAS authAddCredential checks the actor's epoch, the
// one-time challenge and (bootstrap) role=admin with zero passkeys.

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
    const claims = await readChallengeToken(challengeCookie, secret, { purposes: ['add', 'bootstrap'], binding: session.userId });
    if (!claims) return respond({ error: 'ChallengeInvalid' }, 400);
    const bootstrap = claims.purpose === 'bootstrap';
    // The password bootstrap ends with the migration period
    if (bootstrap && !isPasswordLoginEnabled(env)) return respond({ error: 'NotAllowed' }, 403);

    const credential = await verifyRegistration(config, credentialResponse, claims.challenge, labelFromUserAgent(request.headers.get('user-agent')));
    if (!credential) return respond({ error: 'VerificationFailed' }, 400);

    const result = await callGasAuth('authAddCredential', {
        actorUserId: session.userId,
        actorEpoch: session.epoch,
        challengeHash: await sha256Hex(claims.challenge),
        credential,
        ...(bootstrap ? { bootstrap: true } : {}),
    }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`Add passkey: authAddCredential failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return respond({ error: failure.error }, failure.status, failure.revokeSession);
    }
    const credentialCount = typeof result.data.credentialCount === 'number' ? result.data.credentialCount : null;
    const response = respond({ success: true, credentialCount });
    // Re-authenticated with a passkey: the session becomes a passkey session
    // (survives the removal of APP_PASSWORD). A bootstrap keeps its session.
    if (!bootstrap) response.cookies.set(SESSION_COOKIE, await createSession(secret, { ...session, amr: 'pk' }), sessionCookieOptions(env));
    return response;
}
