'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchExpenses, Expense } from '@/lib/api';

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

    const cacheKey = source ? `${STORAGE_KEY}_${source}` : STORAGE_KEY;

    const persist = useCallback((data: Expense[]) => {
        setExpensesState(data);
        localStorage.setItem(cacheKey, JSON.stringify(data));
    }, [cacheKey]);

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
            const data = await fetchExpenses(source);
            persist(data);
            setError(null);
        } catch (error) {
            // Keep whatever is on screen (cache) instead of wiping it
            console.error('Failed to refresh data', error);
            setError('データの取得に失敗しました');
        } finally {
            setLoading(false);
        }
    }, [source, persist]);

    // Optimistic mutations: update local state (and cache) immediately,
    // callers run refresh() in the background to reconcile with the server.
    const removeLocal = useCallback((target: Expense) => {
        setExpensesState(previous => {
            const index = previous.findIndex(item => isSameExpense(item, target));
            if (index === -1) return previous;
            const next = [...previous.slice(0, index), ...previous.slice(index + 1)];
            localStorage.setItem(cacheKey, JSON.stringify(next));
            return next;
        });
    }, [cacheKey]);

    const updateLocal = useCallback((target: Expense, changes: Partial<Expense>) => {
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
            fetchExpenses(source).then(data => {
                persist(data);
                setError(null);
            }).catch(e => {
                console.error(e);
                setError('データの取得に失敗しました');
            });
        }
    }, [refresh, cacheKey, source, persist]);

    return { expenses, loading, error, refresh, removeLocal, updateLocal };
}
