'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchExpenses, Expense } from '@/lib/api';

const STORAGE_KEY = 'kakeibo_expenses_cache';

export function useExpenses() {
    const [expenses, setExpensesState] = useState<Expense[]>([]);
    const [loading, setLoading] = useState(true);

    // Load from cache immediately on mount
    useEffect(() => {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached) {
            try {
                setExpensesState(JSON.parse(cached));
                setLoading(false); // Show cached data immediately
            } catch (e) {
                console.error('Failed to parse cache', e);
            }
        }
    }, []);

    const refresh = useCallback(async () => {
        setLoading(true); // Optional: show spinner if user manually triggered
        try {
            const data = await fetchExpenses();
            setExpensesState(data);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (error) {
            console.error('Failed to refresh data', error);
        } finally {
            setLoading(false);
        }
    }, []);

    // Auto-fetch in background if cache exists, or fetch immediately if empty
    useEffect(() => {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (!cached) {
            refresh();
        } else {
            // Background update (silent refresh)
            fetchExpenses().then(data => {
                setExpensesState(data);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            }).catch(e => console.error(e));
        }
    }, [refresh]);

    return { expenses, loading, refresh };
}
