import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const { password } = await request.json();
        const correctPassword = process.env.APP_PASSWORD;

        if (!correctPassword) {
            console.error("APP_PASSWORD is not set.");
            return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
        }

        if (password === correctPassword) {
            const response = NextResponse.json({ success: true });

            // Set Secure Cookie
            response.cookies.set('kakeibo_session', 'authenticated', {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 60 * 60 * 24 * 30, // 30 days
                path: '/',
            });

            return response;
        } else {
            return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
        }
    } catch (error) {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
}
