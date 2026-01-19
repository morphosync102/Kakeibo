'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchExpenses, Expense } from '@/lib/api';

const STORAGE_KEY = 'kakeibo_expenses_cache';

export function useExpenses(source?: string) {
    const [expenses, setExpensesState] = useState<Expense[]>([]);
    const [loading, setLoading] = useState(true);

    const cacheKey = source ? `${STORAGE_KEY}_${source}` : STORAGE_KEY;

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
            setExpensesState(data);
            localStorage.setItem(cacheKey, JSON.stringify(data));
        } catch (error) {
            console.error('Failed to refresh data', error);
        } finally {
            setLoading(false);
        }
    }, [source, cacheKey]);

    // Auto-fetch in background if cache exists, or fetch immediately if empty
    useEffect(() => {
        const cached = localStorage.getItem(cacheKey);
        if (!cached) {
            refresh();
        } else {
            // Background update (silent refresh)
            fetchExpenses(source).then(data => {
                setExpensesState(data);
                localStorage.setItem(cacheKey, JSON.stringify(data));
            }).catch(e => console.error(e));
        }
    }, [refresh, cacheKey, source]);

    return { expenses, loading, refresh };
}
