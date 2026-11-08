import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isSessionSecretConfigured, readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { CHALLENGE_COOKIE, challengeCookieOptions, createChallengeToken, newChallenge, readChallengeToken } from '@/lib/webauthn-challenge';
import { parseAuthenticationResponse, registrationOptions, webauthnConfig } from '@/lib/webauthn';
import { failureFromGas, NO_STORE, readJsonObject } from '@/lib/passkey-flow';
import { verifyPasskeyAssertion } from '@/lib/passkey-assertion';

// Add a passkey, step 2 (design §3.3): verify the re-authentication with one
// of the user's own passkeys (purpose=reauth cookie bound to the session
// userId; the assertion's userHandle and the passkey's owner must be the
// session user; one-time challenge via authRecordCredentialUse). On success,
// a NEW challenge for the registration in a purpose=add cookie bound to the
// same userId (5 minutes). The reauth challenge is never reusable for it.

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
    const credentialResponse = parseAuthenticationResponse(body?.response);
    if (!credentialResponse) return respond({ error: 'Invalid request' }, 400);
    const claims = await readChallengeToken(challengeCookie, secret, { purposes: ['reauth'], binding: session.userId });
    if (!claims) return respond({ error: 'ChallengeInvalid' }, 400);

    const result = await verifyPasskeyAssertion({
        config, env, fetchImpl: fetch, response: credentialResponse, challenge: claims.challenge, expectedUserId: session.userId, log: console,
    });
    if (!result.ok) return respond({ error: result.failure.error }, result.failure.status);
    // The session must still be current (GAS checks the epoch again on add)
    if (result.user.epoch !== session.epoch) return respond({ error: 'Unauthorized' }, 401, true);

    // The user's passkeys, so the same authenticator is not registered twice
    const listed = await callGasAuth('authListCredentials', { actorUserId: session.userId, actorEpoch: session.epoch }, { env, fetchImpl: fetch });
    if (!listed.ok) {
        const failure = failureFromGas(listed.error);
        if (failure.status >= 500) console.error(`Add passkey: authListCredentials failed (${listed.error}${listed.detail ? `: ${listed.detail}` : ''})`);
        return respond({ error: failure.error }, failure.status, failure.revokeSession);
    }
    const exclude = Array.isArray(listed.data.credentials) ? listed.data.credentials as { credentialId: string }[] : [];

    const challenge = newChallenge();
    const options = await registrationOptions(config, { userId: session.userId, userName: result.displayName, challenge, exclude });
    const response = respond({ options });
    response.cookies.set(CHALLENGE_COOKIE, await createChallengeToken(secret, { purpose: 'add', challenge, binding: session.userId }), challengeCookieOptions(env));
    return response;
}
