import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSession, isSessionSecretConfigured, normalizeSessionUser, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { homePath } from '@/lib/access';
import { callGasAuth } from '@/lib/gas-auth';
import { CHALLENGE_COOKIE, challengeCookieOptions, readChallengeToken, sha256Hex } from '@/lib/webauthn-challenge';
import { labelFromUserAgent, parseRegistrationResponse, verifyRegistration, webauthnConfig } from '@/lib/webauthn';
import { failureFromGas, inviteTokenFrom, NO_STORE, readJsonObject } from '@/lib/passkey-flow';
import { ACTIVE_COOKIE, activeCookieOptions, createActiveToken } from '@/lib/active-session';

// Invite registration, step 2 (design §3.3). The challenge cookie must be a
// purpose=register cookie bound to this invite's token hash; it is deleted by
// every answer. After verification GAS consumes the invite and adds the
// passkey atomically (one-time invite, one-time challenge), and the user gets
// a passkey session (amr=pk) with the app lock's active cookie (§3.12).

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
        console.error('Passkey registration is not configured (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / SESSION_SECRET).');
        return respond({ error: 'Service Unavailable' }, 503);
    }
    const body = await readJsonObject(request);
    const token = inviteTokenFrom(body?.token);
    if (!token) return respond({ error: 'InviteInvalid' }, 410);
    const credentialResponse = parseRegistrationResponse(body?.response);
    if (!credentialResponse) return respond({ error: 'Invalid request' }, 400);

    const tokenHash = await sha256Hex(token);
    const claims = await readChallengeToken(challengeCookie, secret, { purposes: ['register'], binding: tokenHash });
    if (!claims) return respond({ error: 'ChallengeInvalid' }, 400);

    const credential = await verifyRegistration(config, credentialResponse, claims.challenge, labelFromUserAgent(request.headers.get('user-agent')));
    if (!credential) return respond({ error: 'VerificationFailed' }, 400);

    const result = await callGasAuth('authConsumeInviteAndAddCredential', {
        tokenHash,
        challengeHash: await sha256Hex(claims.challenge),
        credential,
    }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`Passkey registration: authConsumeInviteAndAddCredential failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return respond({ error: failure.error }, failure.status);
    }
    const user = normalizeSessionUser(result.data.user);
    if (!user) {
        console.error('Passkey registration: GAS returned an invalid user.');
        return respond({ error: 'Service Unavailable' }, 503);
    }
    const response = respond({ success: true, userId: user.userId, redirectTo: homePath(user) });
    response.cookies.set(SESSION_COOKIE, await createSession(secret, { ...user, amr: 'pk' }), sessionCookieOptions(env));
    response.cookies.set(ACTIVE_COOKIE, await createActiveToken(secret, user), activeCookieOptions(env));
    return response;
}
