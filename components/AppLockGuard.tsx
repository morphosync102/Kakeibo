'use client';

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isPublicPath } from "@/lib/access";
import { browserStorage, handleAppLocked, handleUnauthorized, unauthorizedError } from "@/lib/client-session";
import {
    APP_LOCK_CHECK_INTERVAL_MS, isIdleExpired, LOCKED_ERROR, markAppActive, readLastActive, shouldPing, visibilityAction,
} from "@/lib/app-lock";
import { getPendingWrites, subscribePendingWrites } from "@/lib/write-queue";

// App lock on the client (design §3.12, timings in lib/app-lock.ts). On every
// protected screen (public ones such as /login and /invite are skipped):
// - an interaction (tap, key) records the time on this device and, at most
//   once a minute, pings /api/auth/session so the server's sliding cookie
//   follows; the ping also learns of a lock or an ended session
// - idle for too long -> the lock screen /login?reason=locked&returnTo=...:
//   when the app becomes visible again (iOS resumes a home-screen app from
//   memory without any request), on the first tap (that tap is swallowed, so
//   it cannot start an edit), on a bfcache restore, or by a periodic check
// - writes still in the queue finish first (they were accepted: the server
//   window outlasts this one), then the screen changes
// The server enforces the lock on its own (middleware); this guard is the
// precise, per-device clock and what catches a resumed PWA.
export default function AppLockGuard() {
    const pathname = usePathname();

    useEffect(() => {
        if (!pathname || isPublicPath(pathname)) return;
        const storage = browserStorage();
        let lastPing: number | null = null;
        let locking = false;
        let unsubscribe: (() => void) | null = null;

        const lock = () => {
            if (locking) return;
            locking = true;
            if (getPendingWrites() === 0) {
                handleAppLocked();
                return;
            }
            unsubscribe = subscribePendingWrites(pending => {
                if (pending !== 0) return;
                unsubscribe?.();
                unsubscribe = null;
                handleAppLocked();
            });
        };

        const ping = (now: number) => {
            if (!shouldPing(lastPing, now)) return;
            lastPing = now;
            void fetch('/api/auth/session', { cache: 'no-store' }).then(async res => {
                if (res.status !== 401) return;
                const error = await unauthorizedError(res);
                if (error === LOCKED_ERROR) lock();
                else handleUnauthorized(error);
            }).catch(() => {
                // offline: the next interaction tries again
                lastPing = null;
            });
        };

        const idle = () => isIdleExpired(readLastActive(storage), Date.now());
        const touch = () => {
            const now = Date.now();
            markAppActive(storage, now);
            ping(now);
        };

        const onInteraction = (event: Event) => {
            if (locking || idle()) {
                // Swallow it before React sees it: no edit starts on a locked screen
                event.preventDefault();
                event.stopPropagation();
                lock();
                return;
            }
            touch();
        };
        const onVisible = () => {
            if (visibilityAction({ visible: document.visibilityState === 'visible', lastActive: readLastActive(storage) }) === 'lock') lock();
        };

        // Arriving on a screen is a use, unless it is already too late
        if (idle()) lock();
        else touch();

        const interactions = ['pointerdown', 'keydown', 'click'] as const;
        for (const type of interactions) window.addEventListener(type, onInteraction, true);
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('pageshow', onVisible);
        const timer = setInterval(onVisible, APP_LOCK_CHECK_INTERVAL_MS);
        return () => {
            for (const type of interactions) window.removeEventListener(type, onInteraction, true);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('pageshow', onVisible);
            clearInterval(timer);
            unsubscribe?.();
        };
    }, [pathname]);

    return null;
}
