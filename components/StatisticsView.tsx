'use client';

import { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { clsx } from 'clsx';
import { useExpenses } from '@/hooks/useExpenses';
import { aggregateExpenses, dateKey, type StatisticsPeriod } from '@/lib/expense-analysis';
import BottomNav from './BottomNav';

const yen = (value: number) => `¥${value.toLocaleString()}`;

export default function StatisticsView({ source, isDarkMode = false }: { source?: string; isDarkMode?: boolean }) {
    const { expenses, loading, error, refresh } = useExpenses(source);
    const [mode, setMode] = useState<StatisticsPeriod['mode']>('all');
    const [year, setYear] = useState(() => new Date().getFullYear());
    const [month, setMonth] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });
    const period: StatisticsPeriod = mode === 'all' ? { mode } : mode === 'year' ? { mode, year } : { mode, month };
    const { points, totals } = useMemo(() => aggregateExpenses(expenses,
        mode === 'all' ? { mode } : mode === 'year' ? { mode, year } : { mode, month }), [expenses, mode, year, month]);
    const years = useMemo(() => {
        const values = expenses.flatMap(item => dateKey(item.date) ? [Number(item.date.slice(0, 4))] : []);
        const first = values.reduce((min, value) => Math.min(min, value), new Date().getFullYear());
        const last = values.reduce((max, value) => Math.max(max, value), new Date().getFullYear());
        return Array.from({ length: last - first + 1 }, (_, index) => last - index);
    }, [expenses]);
    const card = clsx('rounded-2xl border p-4', isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200');
    const field = clsx('rounded-lg border p-2 min-w-0 text-base', isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-gray-300');
    const invalidMonth = mode === 'month' && !dateKey(month + '-01');
    const hasPeriodData = expenses.some(item => {
        const key = dateKey(item.date);
        return key && (mode === 'all' || (mode === 'year' ? Number(key.slice(0, 4)) === year : key.startsWith(month + '-')));
    });

    return (
        <main className={clsx('min-h-screen pb-[calc(7rem+env(safe-area-inset-bottom))]', isDarkMode ? 'bg-slate-950 text-gray-100' : 'bg-gray-50 text-gray-900')}>
            <div className="max-w-4xl mx-auto p-4 space-y-5">
                <h1 className="text-xl font-bold">統計</h1>
                <div className="flex gap-2" aria-label="集計期間">
                    {(['all', 'year', 'month'] as const).map((value, index) => (
                        <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}
                            className={clsx('flex-1 rounded-xl p-3 font-semibold', mode === value ? 'bg-indigo-600 text-white' : card)}>
                            {['全期間', '年', '月'][index]}
                        </button>
                    ))}
                </div>
                {mode === 'year' && <label className="flex items-center gap-3">対象年
                    <select aria-label="対象年" value={year} onChange={event => setYear(Number(event.target.value))} className={field}>
                        {years.map(value => <option key={value} value={value}>{value}年</option>)}
                    </select>
                </label>}
                {mode === 'month' && <label className="flex flex-wrap items-center gap-3">対象月
                    <input aria-label="対象月" type="month" value={month} onChange={event => setMonth(event.target.value)} className={field} />
                    {invalidMonth && <span role="alert" className="text-red-500">対象月を選択してください</span>}
                </label>}
                {error && <div role="alert" className={card}>{error}。保存済みのデータがある場合は表示を維持しています。
                    <button className="ml-2 underline" onClick={refresh} disabled={loading}>再取得</button>
                </div>}
                {loading && <p role="status">読み込み中…</p>}
                {!invalidMonth && <>
                    <div className="grid grid-cols-1 min-[360px]:grid-cols-3 gap-2" aria-label="期間の収支">
                        {([['総収入', totals.income], ['総支出', totals.expense], ['収支', totals.balance]] as const).map(([label, value]) => (
                            <div key={label} className={card}><p className="text-sm opacity-70">{label}</p><p className="font-bold break-all text-lg">{yen(value)}</p></div>
                        ))}
                    </div>
                    {!loading && !error && !hasPeriodData && <p>対象期間のデータがありません</p>}
                    {points.length > 0 && <>
                        <p className="text-sm opacity-70">グラフをタップすると金額を確認できます。累積収支は選択期間の開始時点を0として計算します。</p>
                        <section className={card} aria-label="収入・支出・収支グラフ">
                            <h2 className="font-semibold mb-3">収入・支出・収支</h2>
                            <div className="h-72 min-w-0">
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={points} accessibilityLayer margin={{ left: 0, right: 8 }}>
                                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                                        <XAxis dataKey="key" tick={{ fontSize: 11 }} minTickGap={25} />
                                        <YAxis width={65} tick={{ fontSize: 11 }} />
                                        <Tooltip trigger="click" formatter={value => yen(Number(value))} contentStyle={{ color: '#111827' }} />
                                        <Legend /><ReferenceLine y={0} stroke="#94a3b8" />
                                        <Bar dataKey="income" name="収入" fill="#10b981" />
                                        <Bar dataKey="expense" name="支出" fill="#f59e0b" />
                                        <Line dataKey="balance" name="収支" stroke="#818cf8" strokeWidth={2} dot={false} />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            </div>
                        </section>
                        <section className={card} aria-label="累積収支グラフ">
                            <h2 className="font-semibold mb-3">累積収支</h2>
                            <div className="h-64 min-w-0">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={points} accessibilityLayer margin={{ left: 0, right: 8 }}>
                                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                                        <XAxis dataKey="key" tick={{ fontSize: 11 }} minTickGap={25} />
                                        <YAxis width={65} tick={{ fontSize: 11 }} />
                                        <Tooltip trigger="click" formatter={value => yen(Number(value))} contentStyle={{ color: '#111827' }} />
                                        <ReferenceLine y={0} stroke="#94a3b8" />
                                        <Line dataKey="cumulative" name="累積収支" stroke="#818cf8" strokeWidth={2} dot={points.length === 1} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </section>
                        <details className={card}>
                            <summary className="cursor-pointer">集計値を表で確認</summary>
                            <div className="overflow-x-auto mt-3"><table className="w-full text-sm text-right whitespace-nowrap">
                                <caption className="sr-only">{period.mode === 'month' ? '日別' : '月別'}の収支</caption>
                                <thead><tr>{['期間', '収入', '支出', '収支', '累積収支'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
                                <tbody>{points.map(point => <tr key={point.key}><th className="p-2">{point.key}</th>{[point.income, point.expense, point.balance, point.cumulative].map((value, index) => <td key={index} className="p-2">{yen(value)}</td>)}</tr>)}</tbody>
                            </table></div>
                        </details>
                    </>}
                </>}
            </div>
            <BottomNav />
        </main>
    );
}
