import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { isBase64Url } from '@/lib/webauthn';
import { failureFromGas, NO_STORE, readJsonObject } from '@/lib/passkey-flow';

// Revoke one of the signed-in user's own passkeys (design §3.8, U4). GAS
// authRevokeCredential only finds passkeys of the session's actor
// (CredentialNotFound otherwise) and bumps the epoch, which ends EVERY
// session of the user, this one included: the session cookie is deleted
// and the client clears its cache and goes to /login.

function respond(body: Record<string, unknown>, status: number, deleteSession: boolean) {
    const response = NextResponse.json(body, { status, headers: NO_STORE });
    if (deleteSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

export async function POST(request: Request) {
    const env = process.env;
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return respond({ error: 'Unauthorized' }, 401, true);
    const body = await readJsonObject(request);
    const credentialId = body?.credentialId;
    if (!isBase64Url(credentialId)) return respond({ error: 'Invalid request' }, 400, false);

    const result = await callGasAuth('authRevokeCredential', { actorUserId: session.userId, actorEpoch: session.epoch, credentialId }, { env, fetchImpl: fetch });
    if (!result.ok) {
        if (result.error === 'CredentialNotFound') return respond({ error: 'CredentialNotFound' }, 404, false);
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`Passkey revoke: authRevokeCredential failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return respond({ error: failure.error }, failure.status, Boolean(failure.revokeSession));
    }
    console.log('Passkey revoked by its owner; all sessions of the user end (epoch bumped).');
    return respond({ success: true, loggedOut: true }, 200, true);
}
