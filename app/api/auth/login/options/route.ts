import { NextResponse } from 'next/server';
import { isSessionSecretConfigured } from '@/lib/session';
import { CHALLENGE_COOKIE, challengeCookieOptions, createChallengeToken, LOGIN_BINDING, newChallenge } from '@/lib/webauthn-challenge';
import { authenticationOptions, webauthnConfig } from '@/lib/webauthn';
import { NO_STORE } from '@/lib/passkey-flow';

// Passkey login, step 1 (design §3.6). Public, no GAS round trip: a new
// challenge in a purpose=login cookie, and no allowCredentials (the device
// offers its discoverable passkeys; the user is found from the assertion).
export async function POST() {
    const env = process.env;
    const config = webauthnConfig(env);
    const secret = env.SESSION_SECRET;
    if (!config || !isSessionSecretConfigured(secret)) {
        console.error('Passkey login is not configured (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET).');
        return NextResponse.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
    }
    const challenge = newChallenge();
    const options = await authenticationOptions(config, { challenge });
    const response = NextResponse.json({ options }, { headers: NO_STORE });
    response.cookies.set(CHALLENGE_COOKIE, await createChallengeToken(secret, { purpose: 'login', challenge, binding: LOGIN_BINDING }), challengeCookieOptions(env));
    return response;
}
