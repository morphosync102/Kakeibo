'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchExpenses, Expense } from '@/lib/api';
import { getPendingWrites, shouldApplyFetch, subscribePendingWrites } from '@/lib/write-queue';

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

    const cacheKey = source ? `${STORAGE_KEY}_${source}` : STORAGE_KEY;

    const persist = useCallback((data: Expense[]) => {
        setExpensesState(data);
        localStorage.setItem(cacheKey, JSON.stringify(data));
    }, [cacheKey]);

    // Fetch and apply unless a local mutation happened while it was in flight
    // or a write is still pending (its result would temporarily roll it back)
    const load = useCallback(async () => {
        const startedAt = mutationVersion.current;
        reloadAfterWrites.current = false;
        const data = await fetchExpenses(source);
        const apply = shouldApplyFetch({
            startedVersion: startedAt,
            currentVersion: mutationVersion.current,
            pendingWrites: getPendingWrites(),
        });
        if (!apply) {
            if (getPendingWrites() > 0) reloadAfterWrites.current = true;
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
            load().catch(e => {
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

    const refresh = useCallback(async () => {
        setLoading(true); // Optional: show spinner if user manually triggered
        try {
            await load();
        } catch (error) {
            // Keep whatever is on screen (cache) instead of wiping it
            console.error('Failed to refresh data', error);
            setError('データの取得に失敗しました');
        } finally {
            setLoading(false);
        }
    }, [load]);

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

    // Auto-fetch in background if cache exists, or fetch immediately if empty
    useEffect(() => {
        const cached = localStorage.getItem(cacheKey);
        if (!cached) {
            refresh();
        } else {
            // Background update (silent refresh)
            load().catch(e => {
                console.error(e);
                setError('データの取得に失敗しました');
            });
        }
    }, [refresh, load, cacheKey]);

    return { expenses, loading, error, refresh, removeLocal, updateLocal };
}
