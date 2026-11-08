import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { failureFromGas, NO_STORE } from '@/lib/passkey-flow';

// "Log out on every device" for the signed-in user (design §3.8, U4): GAS
// authBumpEpoch (+1), so every session of the user, this one included, is
// refused by GAS from now on (SessionRevoked). This device's cookie is
// deleted here; the client clears its cache and goes to /login.
// Note: cached lists of /api/expenses may still be served to an old cookie
// for up to 5 minutes (design §3.8 / §5.7, accepted); writes stop at once.

function respond(body: Record<string, unknown>, status: number, deleteSession: boolean) {
    const response = NextResponse.json(body, { status, headers: NO_STORE });
    if (deleteSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

export async function POST() {
    const env = process.env;
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return respond({ error: 'Unauthorized' }, 401, true);
    const result = await callGasAuth('authBumpEpoch', { actorUserId: session.userId, actorEpoch: session.epoch }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`Logout everywhere: authBumpEpoch failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return respond({ error: failure.error }, failure.status, Boolean(failure.revokeSession));
    }
    return respond({ success: true, loggedOut: true }, 200, true);
}
