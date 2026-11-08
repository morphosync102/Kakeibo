import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';

// Logout of this device (design §3.8): deletes the session cookie. The client
// clears its kakeibo_ localStorage (lib/client-session.ts logout()).
// Other devices stay signed in (all-device logout is U4: authBumpEpoch).
export async function POST() {
    const response = NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(process.env, 0));
    return response;
}
