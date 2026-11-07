// Client-side write serialization for optimistic edits.
//
// Optimistic UI closes dialogs before GAS answers, so several writes can be in
// flight at once. Writes to the same row must reach GAS in order: the second
// one strict-matches on the values the first one wrote (amount → date edit,
// edit → delete), and would otherwise fail with "Transaction not found".
// Every POST therefore runs through one Promise chain, one at a time.
//
// Keep this module free of `@/` imports: tests load it directly with Node's
// TypeScript type stripping.

type PendingListener = (pending: number) => void;

export function createWriteQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    let pendingCount = 0;
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
            .finally(() => setPending(pendingCount - 1));
        tail = result.then(() => undefined, () => undefined);
        return result;
    }

    function subscribe(listener: PendingListener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }

    return { enqueue, subscribe, pending: () => pendingCount };
}

// Whether a fetched expense list may replace local state. Data fetched while a
// write is queued or in flight, or before the latest optimistic edit, predates
// that edit and would roll it back on screen.
export function shouldApplyFetch({ startedVersion, currentVersion, pendingWrites }: {
    startedVersion: number;
    currentVersion: number;
    pendingWrites: number;
}) {
    return startedVersion === currentVersion && pendingWrites === 0;
}

const writeQueue = createWriteQueue();

export const enqueueWrite = writeQueue.enqueue;
export const subscribePendingWrites = writeQueue.subscribe;
export const getPendingWrites = writeQueue.pending;

export type WriteResult = { success?: boolean; error?: string; [key: string]: unknown };

// POST one write to /api/expenses through the shared queue. Resolves with the
// GAS response on success and rejects (with GAS's error message when present)
// otherwise. keepalive lets the request finish if the page is closed or
// navigated away right after an optimistic edit.
export function postWrite(payload: Record<string, unknown>): Promise<WriteResult> {
    return enqueueWrite(async () => {
        const res = await fetch('/api/expenses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true,
        });
        const data = await res.json() as WriteResult;
        if (!data?.success) throw new Error(data?.error || 'Unknown error');
        return data;
    });
}
