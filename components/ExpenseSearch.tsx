'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import type { Expense } from '@/lib/api';
import { expenseCategories, searchExpenses, type SearchFilters } from '@/lib/expense-analysis';

export default function ExpenseSearch({ expenses, loading, error, onSelect, isDarkMode = false }: {
    expenses: Expense[]; loading: boolean; error: string | null; onSelect: (expense: Expense) => void; isDarkMode?: boolean;
}) {
    const [filters, setFilters] = useState<SearchFilters>({});
    const [limit, setLimit] = useState(50);
    const categories = useMemo(() => expenseCategories(expenses), [expenses]);
    const { items, total, errors } = useMemo(() => searchExpenses(expenses, filters), [expenses, filters]);
    const update = (field: keyof SearchFilters, value: string) => {
        setFilters(previous => ({ ...previous, [field]: value }));
        setLimit(50);
    };
    const inputClass = clsx('w-full min-w-0 p-3 rounded-xl border text-base', isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-gray-300 text-gray-900');
    const fields = [
        ['keyword', '店舗名・内容', 'text'], ['startDate', '開始日', 'date'], ['endDate', '終了日', 'date'],
        ['minAmount', '最小金額', 'text'], ['maxAmount', '最大金額', 'text'],
    ] as const;
    const invalid = Object.keys(errors).length > 0;

    return <section className={clsx('p-4 space-y-4 max-w-3xl mx-auto', isDarkMode ? 'text-gray-100' : 'text-gray-900')} aria-label="支出検索">
        <h1 className="text-xl font-bold">支出検索</h1>
        <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-3">
            {fields.map(([field, label, type]) => <label key={field} className={clsx('block min-w-0 text-sm space-y-1', field === 'keyword' && 'min-[400px]:col-span-2')}>
                <span>{label}</span>
                <input aria-label={label} type={type} value={filters[field] || ''} onChange={event => update(field, event.target.value)}
                    inputMode={field.endsWith('Amount') ? 'decimal' : undefined} className={inputClass}
                    aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `search-${field}-error` : undefined} />
                {errors[field] && <span id={`search-${field}-error`} role="alert" className="block text-red-500">{errors[field]}</span>}
            </label>)}
            <label className="block min-w-0 text-sm space-y-1"><span>カテゴリ</span>
                <select aria-label="カテゴリ" value={filters.category || ''} onChange={event => update('category', event.target.value)} className={inputClass}>
                    <option value="">全カテゴリ</option>
                    {filters.category && !categories.includes(filters.category) && <option value={filters.category}>{filters.category}</option>}
                    {categories.map(category => <option key={category} value={category}>{category}</option>)}
                </select>
            </label>
        </div>
        <button onClick={() => { setFilters({}); setLimit(50); }} className="rounded-xl border px-4 py-2">条件をクリア</button>
        {loading && <p role="status">読み込み中…</p>}
        {!invalid && !(loading && expenses.length === 0) && !(error && expenses.length === 0) && <>
            <p role="status" aria-live="polite">{items.length.toLocaleString()}件 · 支出合計 ¥{total.toLocaleString()}</p>
            {items.length === 0 && <p>該当する支出はありません</p>}
            <ul className="space-y-2">
                {items.slice(0, limit).map((item, index) => <li key={`${item.id}-${item.date}-${index}`}>
                    <button onClick={() => onSelect(item)} className={clsx('w-full text-left rounded-xl border p-4 flex items-center gap-3', isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200')}>
                        <span className="flex-1 min-w-0"><span className="block text-xs opacity-70">{item.date}</span><span className="block font-semibold break-words">{item.merchant}</span><span className="text-xs opacity-70">{item.category || '未分類'}</span></span>
                        <span className="font-bold shrink-0">¥{item.amount.toLocaleString()}</span>
                    </button>
                </li>)}
            </ul>
            {items.length > limit && <button onClick={() => setLimit(value => value + 50)} className="w-full p-3 rounded-xl border">もっと見る</button>}
        </>}
    </section>;
}
