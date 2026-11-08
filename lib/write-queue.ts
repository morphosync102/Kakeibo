// Client-side write serialization for optimistic edits.
//
// Optimistic UI closes dialogs before GAS answers, so several writes can be in
// flight at once. Writes to the same row must reach GAS in order: the second
// one strict-matches on the values the first one wrote (amount → date edit,
// edit → delete), and would otherwise fail with "Transaction not found".
// Every POST therefore runs through one Promise chain, one at a time.
//
// Keep this module free of `@/` imports: tests load it directly with Node's
// TypeScript type stripping (relative imports carry the .ts extension).

import { handleUnauthorized, unauthorizedError } from './client-session.ts';

type PendingListener = (pending: number) => void;

export function createWriteQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    let pendingCount = 0;
    let settledCount = 0; // monotonic: writes finished (success or failure)
    const listeners = new Set<PendingListener>();

    const setPending = (next: number) => {
        pendingCount = next;
        for (const listener of listeners) listener(pendingCount);
    };

    // Run `task` after every previously queued write has settled. The next
    // write runs whether this one succeeded or failed. The returned promise
    // settles with the task's result after the pending count is decremented,
    // so a caller that refreshes on completion sees an accurate count.
    function enqueue<T>(task: () => Promise<T>): Promise<T> {
        setPending(pendingCount + 1);
        const result = tail
            .then(() => task())
            .finally(() => {
                settledCount += 1;
                setPending(pendingCount - 1);
            });
        tail = result.then(() => undefined, () => undefined);
        return result;
    }

    function subscribe(listener: PendingListener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }

    return { enqueue, subscribe, pending: () => pendingCount, settled: () => settledCount };
}

// Whether a fetched expense list may replace local state. It must not if a
// local edit happened during the fetch, a write was pending when it started or
// is pending now, or a write finished while it was in flight: in all of those
// cases the server may have answered with data that predates a write, and
// applying it would roll that write back on screen (even after a newer fetch,
// started once the write had finished, was already applied).
export function shouldApplyFetch({
    startedVersion, currentVersion, pendingAtStart, pendingWrites, settledAtStart, settledWrites,
}: {
    startedVersion: number;
    currentVersion: number;
    pendingAtStart: number;
    pendingWrites: number;
    settledAtStart: number;
    settledWrites: number;
}) {
    return startedVersion === currentVersion
        && pendingAtStart === 0
        && pendingWrites === 0
        && settledAtStart === settledWrites;
}

// What to do with a fetch result that shouldApplyFetch rejected:
// - writes still queued: fetch again once the queue drains
// - queue idle and no newer fetch started: fetch again now
// - a newer fetch already started (after this one): it will converge
export function fetchDiscardAction({ pendingWrites, newerFetchStarted }: {
    pendingWrites: number;
    newerFetchStarted: boolean;
}): 'reload-after-writes' | 'reload-now' | 'none' {
    if (pendingWrites > 0) return 'reload-after-writes';
    return newerFetchStarted ? 'none' : 'reload-now';
}

const writeQueue = createWriteQueue();

export const enqueueWrite = writeQueue.enqueue;
export const subscribePendingWrites = writeQueue.subscribe;
export const getPendingWrites = writeQueue.pending;
export const getSettledWrites = writeQueue.settled;

// GAS waits up to 20s for its script lock, plus a cold start and the write
// itself. A timeout that fires while GAS is still working reports a failure
// for a write that may land, and the UI may then offer to resend it, so keep a
// generous margin.
export const WRITE_TIMEOUT_MS = 45000;

export type WriteResult = { success?: boolean; error?: string; [key: string]: unknown };

// A write that timed out is NOT a definite failure: GAS may still apply it.
// Callers must not restore input / offer a resend for it (that could create a
// duplicate); they tell the user to check the list and refetch instead.
export class WriteTimeoutError extends Error {
    constructor() {
        super('通信がタイムアウトしました');
        this.name = 'WriteTimeoutError';
    }
}

export function isWriteTimeout(error: unknown): boolean {
    return error instanceof Error && error.name === 'WriteTimeoutError';
}

// POST one write to /api/expenses through the shared queue. Resolves with the
// GAS response on success and rejects (with GAS's error message when present)
// otherwise. keepalive lets the request finish if the page is closed or
// navigated away right after an optimistic edit; it can be combined with an
// abort signal (Fetch spec), which ends a hung request after timeoutMs so the
// queue moves on to the next write; that rejection is a WriteTimeoutError.
export function postWrite(
    payload: Record<string, unknown>,
    { timeoutMs = WRITE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<WriteResult> {
    return enqueueWrite(async () => {
        let data: WriteResult;
        try {
            const res = await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true,
                signal: AbortSignal.timeout(timeoutMs),
            });
            // Invalid, expired or revoked session: nothing was written. Clear
            // the cached lists and go to /login. App lock (401 Locked): also
            // nothing written; the cache stays and the lock screen opens. An
            // active screen is not refused (lib/app-lock.ts: the server window
            // outlasts the client's), and the guard locks only after the
            // queue has drained (components/AppLockGuard.tsx).
            if (res.status === 401) {
                const error = await unauthorizedError(res);
                handleUnauthorized(error);
                throw new Error(error === 'Locked' ? 'Locked' : 'Unauthorized');
            }
            data = await res.json() as WriteResult;
        } catch (e) {
            if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
                throw new WriteTimeoutError();
            }
            throw e;
        }
        if (!data?.success) throw new Error(data?.error || 'Unknown error');
        return data;
    });
}
