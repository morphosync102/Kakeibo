import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

export async function middleware(request: NextRequest) {

    // Protected Routes
    const protectedPaths = ['/', '/statistics', '/calendar', '/manage', '/api/expenses', '/yahoo'];

    // Check if current path matches any protected path
    const isProtected = protectedPaths.some(path =>
        request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(path + '/')
    );

    if (isProtected && !await verifySession(request.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET)) {
        // Redirect to login if accessing protected route without session
        // For API routes, ideally return 401, but redirect handles unified logic for now
        if (request.nextUrl.pathname.startsWith('/api/')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('returnTo', request.nextUrl.pathname);
        return NextResponse.redirect(loginUrl);
    }

    return NextResponse.next();
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - api/auth (auth routes)
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - login (login page)
         * - image.png (app icon)
         */
        '/((?!api/auth|_next/static|_next/image|favicon.ico|login|image.png).*)',
    ],
};
