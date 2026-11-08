// Who may open which path (design 2026-11-yuki-and-passkeys §4.2-4.3, §8.3).
// Pure functions used by middleware.ts and the login API; the proxy and GAS
// check data access independently. Usable from Edge, Node and node --test.

import { SOURCES, SOURCE_IDS, isSourceId, sourceFromPathname, sourceHref, tabFromPathname, type SourceId } from './sources.ts';
import type { Session } from './session.ts';

type SessionSources = { sources: readonly string[]; homeSource: Session['homeSource'] };

// Reachable without a session: exact paths, or everything below a prefix
// (prefixes end with '/', so '/loginX' or '/api/auth/registerX' never match).
const PUBLIC_EXACT: ReadonlySet<string> = new Set([
    '/login',
    '/invite',
    // the removed password login: always 404 (a stale login page gets
    // "ended", not "wrong password"); it reads nothing and issues nothing
    '/api/auth/verify',
    '/api/line/webhook',
    // PWA manifests and icons (iOS fetches them without cookies)
    '/manifest.webmanifest',
    ...SOURCE_IDS.filter(id => id !== 'main').map(id => `/${id}-manifest.json`),
    '/image.png',
    '/psyduck.png', // yahoo (personal) PWA icon
    '/icon.png',
    '/apple-icon.png',
    '/favicon.ico',
]);
const PUBLIC_PREFIXES: readonly string[] = [
    '/api/auth/register/',
    '/api/auth/login/',
    '/_next/', // build assets and dev tooling (also excluded by the matcher)
];

export function isPublicPath(pathname: string): boolean {
    return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function homePath(session: SessionSources): string {
    return isSourceId(session.homeSource) ? sourceHref(session.homeSource, 'home') : '/';
}

function canOpenSource(sources: readonly string[], source: SourceId): boolean {
    return sources.includes(source);
}

// Screens about the signed-in user rather than a kakeibo (e.g.
// /settings/passkeys): any session may open them, whatever its sources.
export function isAccountPath(pathname: string): boolean {
    return pathname === '/settings' || pathname.startsWith('/settings/');
}

// Reachable with a session even while the app is locked (§3.12): logging out
// of this device needs no Face ID.
const LOCK_EXEMPT_EXACT: ReadonlySet<string> = new Set(['/api/auth/logout']);

export function isLockExemptPath(pathname: string): boolean {
    return LOCK_EXEMPT_EXACT.has(pathname);
}

// Requests on these paths (after passing the lock) slide the app lock's
// active cookie: every protected screen and API except the lock-exempt ones.
export function refreshesActivity(pathname: string): boolean {
    return !isPublicPath(pathname) && !isLockExemptPath(pathname);
}

export type AccessDecision =
    | { kind: 'allow' }
    | { kind: 'unauthorized' } // API without a valid session: 401
    | { kind: 'login'; returnTo: string } // screen without a valid session
    | { kind: 'locked'; returnTo: string } // screen, valid session, idle too long: /login?reason=locked
    | { kind: 'lockedApi' } // API, valid session, idle too long: 401 Locked
    | { kind: 'redirect'; location: string }; // screen of a source the user may not open

// Every path is protected except the public ones. Screens belong to the
// source of their path prefix (lib/sources.ts); an API path's source is in its
// query/body and is checked by the API itself (403). active: the app lock's
// cookie is valid for this session (lib/active-session.ts); without it every
// protected path but the lock-exempt ones is locked, before anything else.
export function decideAccess({ pathname, search, session, active }: { pathname: string; search: string; session: SessionSources | null; active: boolean }): AccessDecision {
    if (isPublicPath(pathname)) return { kind: 'allow' };
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (!session) return isApi ? { kind: 'unauthorized' } : { kind: 'login', returnTo: `${pathname}${search}` };
    if (!active && !isLockExemptPath(pathname)) return isApi ? { kind: 'lockedApi' } : { kind: 'locked', returnTo: `${pathname}${search}` };
    if (isApi || isAccountPath(pathname)) return { kind: 'allow' };
    if (!canOpenSource(session.sources, sourceFromPathname(pathname))) return { kind: 'redirect', location: homePath(session) };
    return { kind: 'allow' };
}

const RETURN_TO_ORIGIN = 'http://return-to.invalid';
const MAX_RETURN_TO_LENGTH = 1024;

// A returnTo the app may navigate to after login: a same-origin relative path
// ('/' first, no '//' or '\', no control characters) of a screen whose source
// the user has. Returns the normalized path or null.
export function safeReturnTo(value: unknown, sources: readonly string[]): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return null;
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
    if (/[\u0000-\u001f\u007f]/.test(value)) return null;
    let url: URL;
    try {
        url = new URL(value, RETURN_TO_ORIGIN);
    } catch {
        return null;
    }
    if (url.origin !== RETURN_TO_ORIGIN || url.pathname.startsWith('//')) return null;
    if (url.pathname === '/login' || url.pathname === '/invite' || url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
    if (!isAccountPath(url.pathname) && !canOpenSource(sources, sourceFromPathname(url.pathname))) return null;
    return `${url.pathname}${url.search}${url.hash}`;
}

// Where to go after a successful login: a valid returnTo, else the home screen.
export function postLoginPath(returnTo: unknown, session: SessionSources): string {
    return safeReturnTo(returnTo, session.sources) ?? homePath(session);
}

// Display labels of the user's kakeibo, in session order (home first). The
// switcher is shown only for two or more; it is display only (access is
// decided by the middleware, the proxy and GAS).
export function sourceChoices(sources: readonly string[]): { id: SourceId; label: string }[] {
    return sources.filter(isSourceId).map(id => ({ id, label: SOURCES[id].label }));
}

// The same tab in another kakeibo (e.g. /yuki/calendar -> /calendar)
export function switchSourceHref(pathname: string, target: SourceId): string {
    return sourceHref(target, tabFromPathname(pathname));
}
