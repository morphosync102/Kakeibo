import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { lineLinkableSources } from '@/lib/sources';
import { failureFromGas, NO_STORE } from '@/lib/passkey-flow';

// LINE linking, step 1 (design §5.4, U5): issue a one-time link code for the
// signed-in user's own lineOptional source (yuki). GAS generates the code,
// stores only its hash and decides the destination source from the actor;
// the browser never names a user or a source. The code is in this response
// only and is never logged.

function fail(error: string, status: number, revokeSession = false) {
    const response = NextResponse.json({ error }, { status, headers: NO_STORE });
    if (revokeSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

export async function POST() {
    const env = process.env;
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return fail('Unauthorized', 401, true);
    // Only users with a lineOptional source (GAS checks again)
    if (lineLinkableSources(session.sources).length === 0) return fail('NotAllowed', 403);

    const result = await callGasAuth('authCreateLineLinkCode', { actorUserId: session.userId, actorEpoch: session.epoch }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`LINE link: authCreateLineLinkCode failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return fail(failure.error, failure.status, failure.revokeSession);
    }
    const { code, expiresAt } = result.data;
    if (typeof code !== 'string' || !/^[2-9A-HJ-NP-Z]{10}$/.test(code)) {
        console.error('LINE link: authCreateLineLinkCode returned an invalid code.');
        return fail('Service Unavailable', 503);
    }
    return NextResponse.json({ code, expiresAt: typeof expiresAt === 'string' ? expiresAt : null }, { headers: NO_STORE });
}
