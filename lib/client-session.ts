// Client-side session housekeeping (design §3.8). Every key this app stores
// in localStorage starts with `kakeibo_` (cached lists, the last user), and
// all of them are removed when the session ends or the user changes, so a
// shared device never shows the previous user's data. The app lock (§3.12)
// is different: same user, same session, so the cache is kept.
// Relative imports only: node --test loads it directly. Storage / location
// are injectable for tests and default to the browser globals.

import { LOCKED_ERROR, lockedLoginPath } from './app-lock.ts';

export const KAKEIBO_STORAGE_PREFIX = 'kakeibo_';
export const LOGIN_USER_KEY = 'kakeibo_user';
export const SESSION_EXPIRED_PATH = '/login?reason=session';

type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
type LocationLike = Pick<Location, 'assign'>;
type CurrentLocationLike = Pick<Location, 'assign' | 'pathname' | 'search'>;

export function browserStorage(): StorageLike | undefined {
    try {
        return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
        return undefined; // storage blocked
    }
}

function browserLocation(): CurrentLocationLike | undefined {
    return typeof location === 'undefined' ? undefined : location;
}

// Removes every kakeibo_ key (and only those). Never throws.
export function clearKakeiboStorage(storage: StorageLike | undefined = browserStorage()): void {
    if (!storage) return;
    try {
        const keys: string[] = [];
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key !== null && key.startsWith(KAKEIBO_STORAGE_PREFIX)) keys.push(key);
        }
        for (const key of keys) storage.removeItem(key);
    } catch {
        // storage unavailable: nothing cached to leak
    }
}

// After a successful login: if the device's last user is someone else, or
// unknown (v1 / migration-period devices), clear the cache, then record the
// new user. The same user keeps the cache.
export function rememberLoginUser(storage: StorageLike | undefined, userId: string): void {
    if (!storage) return;
    try {
        if (storage.getItem(LOGIN_USER_KEY) !== userId) clearKakeiboStorage(storage);
        storage.setItem(LOGIN_USER_KEY, userId);
    } catch {
        // storage unavailable
    }
}

// The server answered 401 (invalid, expired or revoked session): clear the
// cache and go to the login page.
export function handleSessionExpired({ storage = browserStorage(), location = browserLocation() }: { storage?: StorageLike; location?: LocationLike } = {}): void {
    clearKakeiboStorage(storage);
    location?.assign(SESSION_EXPIRED_PATH);
}

// The server answered 401 Locked (app lock, §3.12): the session is valid and
// the user is the same, so the cache stays (no refetch after Face ID). Opens
// the lock screen, which comes back here after the login. If someone else
// logs in there, rememberLoginUser clears the cache as usual.
export function handleAppLocked({ location = browserLocation() }: { location?: CurrentLocationLike } = {}): void {
    if (!location) return;
    location.assign(lockedLoginPath(`${location.pathname}${location.search}`));
}

// Any 401 of our APIs, by its error word: Locked -> lock screen (cache kept),
// anything else (Unauthorized: invalid, expired, revoked) -> cache cleared.
export function handleUnauthorized(error: unknown, deps: { storage?: StorageLike; location?: CurrentLocationLike } = {}): void {
    if (error === LOCKED_ERROR) handleAppLocked(deps);
    else handleSessionExpired(deps);
}

// The error word of a 401 JSON body ('' when unreadable). Never throws.
export async function unauthorizedError(res: Pick<Response, 'clone'>): Promise<string> {
    try {
        const body = await res.clone().json() as unknown;
        return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
    } catch {
        return '';
    }
}

// Where a logout lands: /login marked so it does not start Face ID by itself
// (lib/passkey-client.ts isLoggedOutLanding)
export const LOGGED_OUT_PATH = '/login?loggedOut=1';

// Logout of this device: delete the cookie (server), clear the cache, go to
// /login. The cache is cleared and the page left even if the request fails.
export async function logout({ storage = browserStorage(), location = browserLocation(), fetchImpl }: { storage?: StorageLike; location?: LocationLike; fetchImpl?: typeof fetch } = {}): Promise<void> {
    try {
        await (fetchImpl ?? fetch)('/api/auth/logout', { method: 'POST' });
    } catch {
        // offline: the cookie stays until it expires, the cache is still cleared
    }
    clearKakeiboStorage(storage);
    location?.assign(LOGGED_OUT_PATH);
}
