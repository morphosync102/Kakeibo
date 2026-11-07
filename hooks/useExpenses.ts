'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchExpenses, Expense } from '@/lib/api';
import { fetchDiscardAction, getPendingWrites, getSettledWrites, shouldApplyFetch, subscribePendingWrites } from '@/lib/write-queue';

const STORAGE_KEY = 'kakeibo_expenses_cache';

function isSameExpense(a: Expense, b: Expense) {
    return a.id === b.id
        && a.date === b.date
        && a.merchant === b.merchant
        && a.amount === b.amount;
}

export function useExpenses(source?: string) {
    const [expenses, setExpensesState] = useState<Expense[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Bumped on every optimistic mutation. A fetch that started before the
    // latest mutation carries pre-edit server data, so its result is dropped
    // instead of rolling the edit back; the write's own refresh reconciles.
    const mutationVersion = useRef(0);
    // Set when a fetch result was dropped because writes were still queued;
    // the list is fetched again once the write queue drains.
    const reloadAfterWrites = useRef(false);
    // Incremented by every load; tells a discarded load whether a newer one is on its way
    const loadSeq = useRef(0);

    const cacheKey = source ? `${STORAGE_KEY}_${source}` : STORAGE_KEY;

    const persist = useCallback((data: Expense[]) => {
        setExpensesState(data);
        localStorage.setItem(cacheKey, JSON.stringify(data));
    }, [cacheKey]);

    // Fetch and apply unless the result may predate a write (see shouldApplyFetch):
    // a local mutation or a write (pending, or finished) overlapped the fetch.
    // A discarded result is fetched again once no write is pending.
    // fresh: bypass the proxy's server cache. Used for every refetch that must
    // reflect a write (it may have raced a cached read) and for manual refresh.
    const load = useCallback(async (fresh: boolean): Promise<void> => {
        const seq = ++loadSeq.current;
        const startedAt = mutationVersion.current;
        const pendingAtStart = getPendingWrites();
        const settledAtStart = getSettledWrites();
        reloadAfterWrites.current = false;
        const data = await fetchExpenses(source, { fresh });
        const apply = shouldApplyFetch({
            startedVersion: startedAt,
            currentVersion: mutationVersion.current,
            pendingAtStart,
            pendingWrites: getPendingWrites(),
            settledAtStart,
            settledWrites: getSettledWrites(),
        });
        if (!apply) {
            const next = fetchDiscardAction({
                pendingWrites: getPendingWrites(),
                newerFetchStarted: loadSeq.current !== seq,
            });
            if (next === 'reload-after-writes') reloadAfterWrites.current = true;
            if (next === 'reload-now') return load(true);
            return;
        }
        persist(data);
        setError(null);
    }, [source, persist]);

    // Converge after the last queued write. The modal's onUpdate refresh
    // normally does this (and clears the flag by starting a load); the
    // deferred check only fires when no such refresh follows, e.g. for writes
    // sent from another view.
    useEffect(() => subscribePendingWrites(pending => {
        if (pending !== 0 || !reloadAfterWrites.current) return;
        setTimeout(() => {
            if (!reloadAfterWrites.current) return;
            load(true).catch(e => {
                console.error(e);
                setError('データの取得に失敗しました');
            });
        }, 0);
    }), [load]);

    // Load from cache immediately on mount
    useEffect(() => {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                setExpensesState(JSON.parse(cached));
                setLoading(false); // Show cached data immediately
            } catch (e) {
                console.error('Failed to parse cache', e);
            }
        }
    }, [cacheKey]);

    const runLoad = useCallback(async (fresh: boolean) => {
        setLoading(true); // Optional: show spinner if user manually triggered
        try {
            await load(fresh);
        } catch (error) {
            // Keep whatever is on screen (cache) instead of wiping it
            console.error('Failed to refresh data', error);
            setError('データの取得に失敗しました');
        } finally {
            setLoading(false);
        }
    }, [load]);

    // Write completion (modal onUpdate) and the manual refresh button: always fresh.
    // Takes no arguments on purpose (it is used directly as an onClick handler).
    const refresh = useCallback(() => runLoad(true), [runLoad]);

    // Optimistic mutations: update local state (and cache) immediately,
    // callers run refresh() in the background to reconcile with the server.
    const removeLocal = useCallback((target: Expense) => {
        mutationVersion.current += 1;
        setExpensesState(previous => {
            const index = previous.findIndex(item => isSameExpense(item, target));
            if (index === -1) return previous;
            const next = [...previous.slice(0, index), ...previous.slice(index + 1)];
            localStorage.setItem(cacheKey, JSON.stringify(next));
            return next;
        });
    }, [cacheKey]);

    const updateLocal = useCallback((target: Expense, changes: Partial<Expense>) => {
        mutationVersion.current += 1;
        setExpensesState(previous => {
            const index = previous.findIndex(item => isSameExpense(item, target));
            if (index === -1) return previous;
            const next = [...previous];
            next[index] = { ...next[index], ...changes };
            localStorage.setItem(cacheKey, JSON.stringify(next));
            return next;
        });
    }, [cacheKey]);

    // Auto-fetch in background if cache exists, or fetch immediately if empty.
    // Startup reads may use the proxy's server cache (no write to reflect).
    useEffect(() => {
        const cached = localStorage.getItem(cacheKey);
        if (!cached) {
            runLoad(false);
        } else {
            // Background update (silent refresh)
            load(false).catch(e => {
                console.error(e);
                setError('データの取得に失敗しました');
            });
        }
    }, [runLoad, load, cacheKey]);

    return { expenses, loading, error, refresh, removeLocal, updateLocal };
}
