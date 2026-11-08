// App lock: Face ID again after 30 minutes without use (design
// 2026-11-yuki-and-passkeys §3.12). Shared by the browser (AppLockGuard,
// lib/api.ts, lib/write-queue.ts) and the server (lib/active-session.ts,
// middleware). Client-safe: no secrets, no imports, so node --test loads it
// directly.
//
// Two clocks, one threshold:
// - client: the time of the last user interaction on this device
//   (localStorage LAST_ACTIVE_KEY). Past APP_LOCK_IDLE_MS the guard sends the
//   screen to /login?reason=locked (on return to the app, on the first tap,
//   or by a periodic check while visible).
// - server: a signed sliding cookie (kakeibo_active) refreshed by every
//   screen / API request that passed the lock, and by a ping at most once per
//   APP_LOCK_PING_INTERVAL_MS while the user interacts. It lives
//   APP_LOCK_IDLE_MS + APP_LOCK_PING_INTERVAL_MS, so a client that still
//   counts itself active (its last ping is at most one interval older than
//   its last interaction) is never refused: a write sent from an active
//   screen is not lost to the lock. The server cookie alone locks a device
//   whose client state is gone (a cold start without storage).

// The idle time before the lock. The one place to change it.
export const APP_LOCK_IDLE_MS = 30 * 60 * 1000;
// Interactions refresh the server cookie at most this often
export const APP_LOCK_PING_INTERVAL_MS = 60 * 1000;
// Lifetime of the server cookie (sliding)
export const ACTIVE_TTL_MS = APP_LOCK_IDLE_MS + APP_LOCK_PING_INTERVAL_MS;
// While a screen stays visible without interaction, how often the guard checks
export const APP_LOCK_CHECK_INTERVAL_MS = 30 * 1000;

// kakeibo_ prefix: removed with the cache on logout / user change
export const LAST_ACTIVE_KEY = 'kakeibo_last_active';
export const LOCKED_REASON = 'locked';
// The 401 error word of an API refused by the lock (the session is still valid)
export const LOCKED_ERROR = 'Locked';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

// The last interaction recorded on this device, or null (none / unreadable)
export function readLastActive(storage: StorageLike | undefined): number | null {
    if (!storage) return null;
    try {
        const value = storage.getItem(LAST_ACTIVE_KEY);
        if (value === null || !/^\d{1,15}$/.test(value)) return null;
        return Number(value);
    } catch {
        return null;
    }
}

export function markAppActive(storage: StorageLike | undefined, now = Date.now()): void {
    if (!storage) return;
    try {
        storage.setItem(LAST_ACTIVE_KEY, String(now));
    } catch {
        // storage unavailable: the server cookie still locks
    }
}

// Idle for longer than the lock time. Unknown (null) is not idle: the screen
// was just served, so the server found the device active.
export function isIdleExpired(lastActive: number | null, now = Date.now()): boolean {
    return lastActive !== null && now - lastActive > APP_LOCK_IDLE_MS;
}

// Whether an interaction should refresh the server cookie now
export function shouldPing(lastPing: number | null, now = Date.now()): boolean {
    return lastPing === null || now - lastPing >= APP_LOCK_PING_INTERVAL_MS;
}

// What the guard does when the page becomes visible again (iOS resumes a
// home-screen app from memory without any request): lock when idle too long.
export function visibilityAction({ visible, lastActive, now = Date.now() }: { visible: boolean; lastActive: number | null; now?: number }): 'lock' | 'none' {
    return visible && isIdleExpired(lastActive, now) ? 'lock' : 'none';
}

// The lock screen for the current location (the login page starts Face ID by
// itself; after it, the server-validated returnTo brings the user back)
export function lockedLoginPath(currentPath: string): string {
    const params = new URLSearchParams();
    if (currentPath.startsWith('/') && !currentPath.startsWith('//') && !currentPath.startsWith('/login')) params.set('returnTo', currentPath);
    params.set('reason', LOCKED_REASON);
    return `/login?${params.toString()}`;
}
