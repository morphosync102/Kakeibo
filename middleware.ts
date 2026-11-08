import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { decideAccess, refreshesActivity } from '@/lib/access';
import { ACTIVE_COOKIE, activeCookieOptions, createActiveToken, isActiveTokenValid } from '@/lib/active-session';
import { LOCKED_ERROR, LOCKED_REASON } from '@/lib/app-lock';

// Every path is protected except the public ones (lib/access.ts), so a new
// route cannot be left open by forgetting to list it. Screens of a source the
// user may not open redirect to the user's home; APIs only need a session here
// and check their source themselves (/api/expenses: 403).
// App lock (design §3.12): a valid session without a valid kakeibo_active
// cookie is locked (screens -> /login?reason=locked, APIs -> 401 Locked; the
// session and the device cache are kept). Passing requests slide the cookie.
export async function middleware(request: NextRequest) {
    const cookie = request.cookies.get(SESSION_COOKIE)?.value;
    const activeCookie = request.cookies.get(ACTIVE_COOKIE)?.value;
    const { pathname, search } = request.nextUrl;
    // Variables are read one by one (Edge runtime: no reliance on the whole process.env object).
    const secret = process.env.SESSION_SECRET;
    const cookieEnv = { NODE_ENV: process.env.NODE_ENV };
    // readSession also rejects every amr=pwd session (the removed password login)
    const session = await readSession(cookie, { SESSION_SECRET: secret });
    const active = session !== null && await isActiveTokenValid(activeCookie, secret, session);
    const decision = decideAccess({ pathname, search, session, active });

    if (decision.kind === 'allow' || decision.kind === 'redirect') {
        const response = decision.kind === 'allow' ? NextResponse.next() : NextResponse.redirect(new URL(decision.location, request.url));
        if (session && active && refreshesActivity(pathname) && !isPrefetch(request)) {
            // A use of the app: slide the lock window
            response.cookies.set(ACTIVE_COOKIE, await createActiveToken(secret as string, session), activeCookieOptions(cookieEnv));
        } else if (pathname === '/login' && activeCookie !== undefined) {
            // Opening the login page ends the active state: the lock screen
            // cannot be left by going back without Face ID
            response.cookies.set(ACTIVE_COOKIE, '', activeCookieOptions(cookieEnv, 0));
        }
        return response;
    }

    if (decision.kind === 'lockedApi') {
        // Same user, same session: the client keeps its cache and shows the lock screen
        return NextResponse.json({ error: LOCKED_ERROR }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    if (decision.kind === 'locked') {
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('returnTo', decision.returnTo);
        loginUrl.searchParams.set('reason', LOCKED_REASON);
        const response = NextResponse.redirect(loginUrl);
        if (activeCookie !== undefined) response.cookies.set(ACTIVE_COOKIE, '', activeCookieOptions(cookieEnv, 0));
        return response;
    }

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
    // An invalid (tampered, expired, v1, password) cookie is deleted
    if (cookie !== undefined) response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(cookieEnv, 0));
    if (activeCookie !== undefined) response.cookies.set(ACTIVE_COOKIE, '', activeCookieOptions(cookieEnv, 0));
    return response;
}

// Link prefetches are not a use of the app (they still pass the lock check)
function isPrefetch(request: NextRequest): boolean {
    return request.headers.get('next-router-prefetch') === '1' || request.headers.get('purpose') === 'prefetch';
}

export const config = {
    // Everything except Next's build assets; public paths are decided by
    // isPublicPath (exact paths, not prefixes such as "login").
    matcher: ['/((?!_next/static|_next/image).*)'],
};
