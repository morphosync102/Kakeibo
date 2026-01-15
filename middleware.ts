import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
    // Check for session cookie
    const sessionCallback = request.cookies.get('kakeibo_session');

    // Protected Routes
    const protectedPaths = ['/', '/calendar', '/manage', '/api/expenses'];

    // Check if current path matches any protected path
    const isProtected = protectedPaths.some(path =>
        request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(path + '/')
    );

    if (isProtected && !sessionCallback) {
        // Redirect to login if accessing protected route without session
        // For API routes, ideally return 401, but redirect handles unified logic for now
        if (request.nextUrl.pathname.startsWith('/api/')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return NextResponse.redirect(new URL('/login', request.url));
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
