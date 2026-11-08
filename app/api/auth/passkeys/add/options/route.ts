import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isPasswordLoginEnabled, isSessionSecretConfigured, readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { CHALLENGE_COOKIE, challengeCookieOptions, createChallengeToken, newChallenge } from '@/lib/webauthn-challenge';
import { authenticationOptions, webauthnConfig } from '@/lib/webauthn';
import { failureFromGas, NO_STORE } from '@/lib/passkey-flow';

// Add a passkey, step 1 (design §3.3). A session alone never adds a passkey:
// - the user has passkeys: re-authenticate with one of them first
//   (mode 'reauth': options limited to the user's own passkeys, challenge
//   cookie purpose=reauth bound to the session userId)
// - no passkey yet: only the bootstrap of the admin's first passkey, by
//   re-entering APP_PASSWORD (mode 'bootstrap', migration period only; GAS
//   checks role=admin and zero passkeys again when adding)

function fail(error: string, status: number, revokeSession = false) {
    const response = NextResponse.json({ error }, { status, headers: NO_STORE });
    if (revokeSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

export async function POST() {
    const env = process.env;
    const config = webauthnConfig(env);
    const secret = env.SESSION_SECRET;
    if (!config || !isSessionSecretConfigured(secret)) {
        console.error('Passkeys are not configured (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET).');
        return fail('Service Unavailable', 503);
    }
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return fail('Unauthorized', 401, true);

    const listed = await callGasAuth('authListCredentials', { actorUserId: session.userId, actorEpoch: session.epoch }, { env, fetchImpl: fetch });
    if (!listed.ok) {
        const failure = failureFromGas(listed.error);
        if (failure.status >= 500) console.error(`Add passkey: authListCredentials failed (${listed.error}${listed.detail ? `: ${listed.detail}` : ''})`);
        return fail(failure.error, failure.status, failure.revokeSession);
    }
    const credentials = Array.isArray(listed.data.credentials) ? listed.data.credentials as { credentialId: string }[] : [];
    if (credentials.length === 0) {
        if (!isPasswordLoginEnabled(env)) return fail('NotAllowed', 403);
        return NextResponse.json({ mode: 'bootstrap' }, { headers: NO_STORE });
    }

    const challenge = newChallenge();
    const options = await authenticationOptions(config, { challenge, allow: credentials });
    const response = NextResponse.json({ mode: 'reauth', options }, { headers: NO_STORE });
    response.cookies.set(CHALLENGE_COOKIE, await createChallengeToken(secret, { purpose: 'reauth', challenge, binding: session.userId }), challengeCookieOptions(env));
    return response;
}
