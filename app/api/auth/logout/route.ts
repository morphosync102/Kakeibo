import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { ACTIVE_COOKIE, activeCookieOptions } from '@/lib/active-session';

// Logout of this device (design §3.8): deletes the session cookie and the app
// lock's active cookie. The client clears its kakeibo_ localStorage
// (lib/client-session.ts logout()). Other devices stay signed in
// (all-device logout: /api/auth/logout/all). Reachable while locked (§3.12).
export async function POST() {
    const response = NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    response.cookies.set(ACTIVE_COOKIE, '', activeCookieOptions(process.env, 0));
    return response;
}
