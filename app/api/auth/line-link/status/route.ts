import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { lineLinkableSources } from '@/lib/sources';
import { failureFromGas, NO_STORE } from '@/lib/passkey-flow';

// LINE linking, step 3 (design §5.4, U5): the signed-in user's own link
// state. For a candidate (a LINE user sent the code), the LINE display name
// from GAS (profile API) so the user can check it is their own LINE before
// confirming. The display name is shown only, never logged or stored here.

function fail(error: string, status: number, revokeSession = false) {
    const response = NextResponse.json({ error }, { status, headers: NO_STORE });
    if (revokeSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

export async function POST() {
    const env = process.env;
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return fail('Unauthorized', 401, true);
    if (lineLinkableSources(session.sources).length === 0) return fail('NotAllowed', 403);

    const result = await callGasAuth('authGetLineLinkCandidate', { actorUserId: session.userId, actorEpoch: session.epoch }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`LINE link: authGetLineLinkCandidate failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return fail(failure.error, failure.status, failure.revokeSession);
    }
    const { status, displayName, expiresAt } = result.data;
    const expires = typeof expiresAt === 'string' ? expiresAt : null;
    if (status === 'candidate' && typeof displayName === 'string') {
        return NextResponse.json({ status, displayName: displayName.slice(0, 100), expiresAt: expires }, { headers: NO_STORE });
    }
    if (status === 'pending') return NextResponse.json({ status, expiresAt: expires }, { headers: NO_STORE });
    return NextResponse.json({ status: 'none' }, { headers: NO_STORE });
}
