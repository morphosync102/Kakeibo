import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { failureFromGas, NO_STORE } from '@/lib/passkey-flow';

// The signed-in user's own active passkeys (design §4.1, U4): GAS
// authListCredentials with the session's actor. No public keys; only the
// display fields are passed on.

function fail(error: string, status: number, revokeSession = false) {
    const response = NextResponse.json({ error }, { status, headers: NO_STORE });
    if (revokeSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 64) : '');

export async function POST() {
    const env = process.env;
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return fail('Unauthorized', 401, true);
    const result = await callGasAuth('authListCredentials', { actorUserId: session.userId, actorEpoch: session.epoch }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`Passkey list: authListCredentials failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return fail(failure.error, failure.status, failure.revokeSession);
    }
    const raw = Array.isArray(result.data.credentials) ? result.data.credentials : [];
    const credentials = raw
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && typeof (c as Record<string, unknown>).credentialId === 'string')
        .map(c => ({
            credentialId: c.credentialId as string,
            label: text(c.label) || 'パスキー',
            synced: c.deviceType === 'multiDevice' || c.backedUp === true,
            createdAt: text(c.createdAt),
            lastUsedAt: text(c.lastUsedAt),
        }));
    return NextResponse.json({ credentials }, { headers: NO_STORE });
}
