import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { decideAccess } from '@/lib/access';

// Every path is protected except the public ones (lib/access.ts), so a new
// route cannot be left open by forgetting to list it. Screens of a source the
// user may not open redirect to the user's home; APIs only need a session here
// and check their source themselves (/api/expenses: 403).
export async function middleware(request: NextRequest) {
    const cookie = request.cookies.get(SESSION_COOKIE)?.value;
    const { pathname, search } = request.nextUrl;
    // readSession also rejects amr=pwd sessions once APP_PASSWORD is removed.
    // Variables are read one by one (Edge runtime: no reliance on the whole process.env object).
    const session = await readSession(cookie, { SESSION_SECRET: process.env.SESSION_SECRET, APP_PASSWORD: process.env.APP_PASSWORD });
    const decision = decideAccess({ pathname, search, session });

    if (decision.kind === 'allow') return NextResponse.next();
    if (decision.kind === 'redirect') return NextResponse.redirect(new URL(decision.location, request.url));

    const response = decision.kind === 'unauthorized'
        ? NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
        : (() => {
            // reason=session: /login clears the kakeibo_ localStorage before
            // any screen can show another user's cached data
            const loginUrl = new URL('/login', request.url);
            loginUrl.searchParams.set('returnTo', decision.returnTo);
            loginUrl.searchParams.set('reason', 'session');
            return NextResponse.redirect(loginUrl);
        })();
    // An invalid (tampered, expired, v1, revoked password) cookie is deleted
    if (cookie !== undefined) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions({ NODE_ENV: process.env.NODE_ENV }, 0));
    return response;
}

export const config = {
    // Everything except Next's build assets; public paths are decided by
    // isPublicPath (exact paths, not prefixes such as "login").
    matcher: ['/((?!_next/static|_next/image).*)'],
};
