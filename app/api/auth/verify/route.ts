import { NextResponse } from 'next/server';
import { createSession, isSessionSecretConfigured, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/session';

export async function POST(request: Request) {
    try {
        const { password } = await request.json();
        const correctPassword = process.env.APP_PASSWORD;
        const secret = process.env.SESSION_SECRET;

        if (!correctPassword || !isSessionSecretConfigured(secret)) {
            console.error('Authentication configuration is missing.');
            return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
        }

        if (typeof password !== 'string' || password.length > 1024) {
            return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
        }

        if (password === correctPassword) {
            const response = NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });

            // Set Secure Cookie
            response.cookies.set(SESSION_COOKIE, await createSession(secret), {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: SESSION_TTL_SECONDS,
                path: '/',
            });

            return response;
        } else {
            return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
        }
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
}
