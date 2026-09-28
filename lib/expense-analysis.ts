import type { Expense } from './api';

export type StatisticsPeriod = { mode: 'all' } | { mode: 'year'; year: number } | { mode: 'month'; month: string };
export interface StatisticsPoint {
    key: string;
    income: number;
    expense: number;
    balance: number;
    cumulative: number;
}
export interface SearchFilters {
    keyword?: string;
    startDate?: string;
    endDate?: string;
    category?: string;
    minAmount?: string;
    maxAmount?: string;
}

// Compare calendar dates without local timezone / UTC conversion shifts.
export function dateKey(value: string): string | null {
    const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(value);
    if (!match) return null;
    const [, y, m, d] = match;
    const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return null;
    return `${y}-${m}-${d}`;
}

export function aggregateExpenses(expenses: Expense[], period: StatisticsPeriod) {
    const totals = { income: 0, expense: 0, balance: 0 };
    const rows = expenses.flatMap(item => {
        const date = dateKey(item.date);
        return date ? [{ item, date }] : [];
    });
    let start: string;
    let end: string;
    if (period.mode === 'all') {
        const dates = rows.map(row => row.date).sort();
        if (!dates.length) return { points: [], totals };
        start = dates[0].slice(0, 7) + '-01';
        end = dates[dates.length - 1];
    } else if (period.mode === 'year') {
        if (!Number.isInteger(period.year) || period.year < 1 || period.year > 9999) return { points: [], totals };
        start = `${String(period.year).padStart(4, '0')}-01-01`;
        end = start.slice(0, 4) + '-12-31';
    } else {
        start = period.month + '-01';
        if (!dateKey(start)) return { points: [], totals };
        const last = new Date(`${start}T00:00:00Z`);
        last.setUTCMonth(last.getUTCMonth() + 1, 0);
        end = last.toISOString().slice(0, 10);
    }
    const grouped = new Map<string, StatisticsPoint>();
    const cursor = new Date(`${start}T00:00:00Z`);
    const endTime = new Date(`${end}T00:00:00Z`).getTime();
    while (cursor.getTime() <= endTime) {
        const key = cursor.toISOString().slice(0, period.mode === 'month' ? 10 : 7);
        grouped.set(key, { key, income: 0, expense: 0, balance: 0, cumulative: 0 });
        if (period.mode === 'month') cursor.setUTCDate(cursor.getUTCDate() + 1);
        else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    for (const { item, date } of rows) {
        const point = grouped.get(date.slice(0, period.mode === 'month' ? 10 : 7));
        if (point) point[item.type === 'Income' ? 'income' : 'expense'] += item.amount;
    }
    let cumulative = 0;
    const points = [...grouped.values()].map(point => {
        totals.income += point.income;
        totals.expense += point.expense;
        point.balance = point.income - point.expense;
        cumulative += point.balance;
        return { ...point, cumulative };
    });
    totals.balance = totals.income - totals.expense;
    return { points, totals };
}

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
export const expenseCategories = (expenses: Expense[]) => [...new Set(expenses
    .filter(item => item.type !== 'Income').map(item => item.category || '未分類'))].sort();

export function searchExpenses(expenses: Expense[], filters: SearchFilters) {
    const errors: Partial<Record<keyof SearchFilters, string>> = {};
    for (const field of ['startDate', 'endDate'] as const) {
        if (filters[field] && !dateKey(filters[field])) errors[field] = '正しい日付を入力してください';
    }
    if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
        errors.endDate = '終了日は開始日以降にしてください';
    }
    for (const field of ['minAmount', 'maxAmount'] as const) {
        const value = filters[field];
        if (value !== undefined && value !== '' && (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
            errors[field] = '0以上の正しい金額を入力してください';
        }
    }
    if (filters.minAmount && filters.maxAmount && Number(filters.minAmount) > Number(filters.maxAmount)) {
        errors.maxAmount = '最大金額は最小金額以上にしてください';
    }
    if (Object.keys(errors).length) return { items: [], total: 0, errors };
    const keyword = normalize(filters.keyword || '');
    const items = expenses.filter(item => {
        if (item.type === 'Income') return false;
        const date = dateKey(item.date);
        return normalize(item.merchant).includes(keyword)
            && (!filters.startDate || (date !== null && date >= filters.startDate))
            && (!filters.endDate || (date !== null && date <= filters.endDate))
            && (!filters.category || (item.category || '未分類') === filters.category)
            && (!filters.minAmount || item.amount >= Number(filters.minAmount))
            && (!filters.maxAmount || item.amount <= Number(filters.maxAmount));
    }).sort((a, b) => (dateKey(b.date) || '').localeCompare(dateKey(a.date) || ''));
    return { items, total: items.reduce((sum, item) => sum + item.amount, 0), errors };
}
