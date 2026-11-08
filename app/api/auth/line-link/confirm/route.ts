import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { callGasAuth } from '@/lib/gas-auth';
import { lineLinkableSources } from '@/lib/sources';
import { failureFromGas, NO_STORE, readJsonObject } from '@/lib/passkey-flow';

// LINE linking, step 4 (design §5.4, U5): the signed-in user confirms (or
// cancels) their own candidate. Only GAS authConfirmLineLink with the
// session's actor sets the destination, and only for a lineOptional source
// the actor owns (checked again by GAS).

function fail(error: string, status: number, revokeSession = false) {
    const response = NextResponse.json({ error }, { status, headers: NO_STORE });
    if (revokeSession) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}

export async function POST(request: Request) {
    const env = process.env;
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, env);
    if (!session) return fail('Unauthorized', 401, true);
    if (lineLinkableSources(session.sources).length === 0) return fail('NotAllowed', 403);
    const body = await readJsonObject(request);
    const decision = body?.decision;
    if (decision !== 'confirm' && decision !== 'cancel') return fail('Invalid request', 400);

    const result = await callGasAuth('authConfirmLineLink', { actorUserId: session.userId, actorEpoch: session.epoch, decision }, { env, fetchImpl: fetch });
    if (!result.ok) {
        const failure = failureFromGas(result.error);
        if (failure.status >= 500) console.error(`LINE link: authConfirmLineLink failed (${result.error}${result.detail ? `: ${result.detail}` : ''})`);
        return fail(failure.error, failure.status, failure.revokeSession);
    }
    return NextResponse.json({ success: true, decision }, { headers: NO_STORE });
}
