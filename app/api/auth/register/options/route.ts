import { NextResponse } from 'next/server';
import { isSessionSecretConfigured } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { CHALLENGE_COOKIE, challengeCookieOptions, createChallengeToken, newChallenge, sha256Hex } from '@/lib/webauthn-challenge';
import { registrationOptions, webauthnConfig } from '@/lib/webauthn';
import { failureFromGas, inviteTokenFrom, NO_STORE, readJsonObject } from '@/lib/passkey-flow';

// Invite registration, step 1 (design §3.3). Public (no session): the invite
// token from the URL fragment is the credential. Only its SHA-256 goes to GAS
// (authPeekInvite, which does not consume it). The challenge cookie is bound
// to that hash (purpose=register).

function fail(error: string, status: number) {
    return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
    const env = process.env;
    const config = webauthnConfig(env);
    const secret = env.SESSION_SECRET;
    if (!config || !isSessionSecretConfigured(secret)) {
        console.error('Passkey registration is not configured (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET).');
        return fail('Service Unavailable', 503);
    }
    const body = await readJsonObject(request);
    const token = inviteTokenFrom(body?.token);
    if (!token) return fail('InviteInvalid', 410);
    const tokenHash = await sha256Hex(token);

    const result = await callGasAuth('authPeekInvite', { tokenHash }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`Passkey registration: authPeekInvite failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return fail(failure.error, failure.status);
    }
    const user = result.data.user as { userId?: unknown; displayName?: unknown } | undefined;
    if (!user || typeof user.userId !== 'string') {
        console.error('Passkey registration: authPeekInvite returned an invalid user.');
        return fail('Service Unavailable', 503);
    }
    const exclude = Array.isArray(result.data.credentials) ? result.data.credentials as { credentialId: string; transports?: string[] }[] : [];
    const displayName = typeof user.displayName === 'string' ? user.displayName : '';

    const challenge = newChallenge();
    let options;
    try {
        options = await registrationOptions(config, { userId: user.userId, userName: displayName, challenge, exclude });
    } catch {
        console.error('Passkey registration: invalid user from authPeekInvite.');
        return fail('Service Unavailable', 503);
    }
    const response = NextResponse.json({ options, displayName }, { headers: NO_STORE });
    response.cookies.set(CHALLENGE_COOKIE, await createChallengeToken(secret, { purpose: 'register', challenge, binding: tokenHash }), challengeCookieOptions(env));
    return response;
}
