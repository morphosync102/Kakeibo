import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE } from '@/lib/session';

// The signed-in user's kakeibo, for display only (the kakeibo switcher,
// design §4.1). Access is decided by the middleware, the proxy and GAS.
// Returns no secrets and no user id.
export async function GET() {
    const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value, process.env);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(
        { sources: session.sources, homeSource: session.homeSource },
        { headers: { 'Cache-Control': 'no-store' } },
    );
}
