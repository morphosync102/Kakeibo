'use client';

import { useExpenses } from '@/hooks/useExpenses';
import { useEffect, useState, useRef, useMemo } from 'react';
import { format } from 'date-fns';
import { RefreshCw, Calendar as CalendarIcon } from 'lucide-react';
import { clsx } from 'clsx';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import BottomNav from '@/components/BottomNav';

// Lovely color palette for finance categories
const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];

interface DashboardProps {
    source?: string;
    isDarkMode?: boolean;
}

export default function Dashboard({ source, isDarkMode = false }: DashboardProps) {
    const { expenses, loading, refresh } = useExpenses(source);
    const [selectedMonth, setSelectedMonth] = useState<string>(format(new Date(), 'yyyy/MM'));
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [isScrolledToEnd, setIsScrolledToEnd] = useState(false);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // Theme-based colors
    const bgColor = isDarkMode ? 'bg-slate-950' : 'bg-gray-50';
    const cardBgColor = isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-100';
    const textColor = isDarkMode ? 'text-gray-100' : 'text-gray-800';
    const subTextColor = isDarkMode ? 'text-gray-400' : 'text-gray-500';
    const headerBg = isDarkMode ? 'bg-slate-950 border-slate-800' : 'bg-white border-b';

    // 1. Group expenses by month
    const monthlyData = useMemo(() => {
        const grouped: Record<string, typeof expenses> = {};
        expenses.forEach(item => {
            const monthKey = item.date.substring(0, 7); // YYYY/MM
            if (!grouped[monthKey]) grouped[monthKey] = [];
            grouped[monthKey].push(item);
        });
        return grouped;
    }, [expenses]);

    // 2. Generate list of months
    const availableMonths = useMemo(() => {
        const keys = Object.keys(monthlyData);
        const currentKey = format(new Date(), 'yyyy/MM');
        if (!keys.includes(currentKey)) keys.push(currentKey);
        return keys.sort();
    }, [monthlyData]);

    // 3. Current View Data
    const currentViewData = useMemo(() => {
        return monthlyData[selectedMonth] || [];
    }, [monthlyData, selectedMonth]);

    const currentViewTotal = useMemo(() => {
        return currentViewData.filter(d => d.type !== 'Income').reduce((sum, item) => sum + item.amount, 0);
    }, [currentViewData]);

    const categoryChartData = useMemo(() => {
        const catTotals: Record<string, number> = {};
        currentViewData.filter(d => d.type !== 'Income').forEach(item => {
            const cat = item.category || '未分類';
            catTotals[cat] = (catTotals[cat] || 0) + item.amount;
        });

        return Object.entries(catTotals)
            .map(([name, value], index) => ({
                name,
                value,
                color: COLORS[index % COLORS.length]
            }))
            .sort((a, b) => b.value - a.value);
    }, [currentViewData]);

    // Reset category filter when month changes
    useEffect(() => {
        setSelectedCategory(null);
    }, [selectedMonth]);

    // Filtered List Data
    const filteredViewData = useMemo(() => {
        let data = currentViewData;
        if (selectedCategory) {
            data = data.filter(item => (item.category || '未分類') === selectedCategory);
        }
        return data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [currentViewData, selectedCategory]);

    // Scroll to end on initial load
    useEffect(() => {
        if (!loading && availableMonths.length > 0 && !isScrolledToEnd && scrollContainerRef.current) {
            setTimeout(() => {
                const container = scrollContainerRef.current;
                if (container) {
                    container.scrollLeft = container.scrollWidth;
                    setIsScrolledToEnd(true);
                }
            }, 100);
        }
    }, [loading, availableMonths, isScrolledToEnd]);

    // Observe which card is in view
    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const month = entry.target.getAttribute('data-month');
                    if (month) {
                        setSelectedMonth(month);
                    }
                }
            });
        }, {
            root: container,
            threshold: 0.6
        });

        const cards = container.querySelectorAll('.month-card');
        cards.forEach(card => observer.observe(card));

        return () => observer.disconnect();
    }, [availableMonths]);

    return (
        <main className={clsx("min-h-screen pb-20 transition-colors duration-300", bgColor)}>
            {/* Header */}
            <header className={clsx("px-6 py-4 sticky top-0 z-10 flex justify-between items-center shadow-sm safe-area-top transition-colors", headerBg)}>
                <h1 className={clsx("text-xl font-bold", textColor)}>
                    {source === 'yahoo' ? '個人kakeibo' : 'My Kakeibo'}
                </h1>
                <button
                    onClick={refresh}
                    className={clsx("p-2 rounded-full transition-colors", isDarkMode ? "hover:bg-slate-800 active:bg-slate-700" : "hover:bg-gray-100 active:bg-gray-200")}
                    disabled={loading}
                >
                    <RefreshCw size={20} className={clsx("loading-icon", loading && "animate-spin", isDarkMode ? "text-gray-400" : "text-gray-600")} />
                </button>
            </header>

            {/* Swipeable Dashboard Cards Container */}
            <div className="pt-2 pb-2">
                <div
                    ref={scrollContainerRef}
                    className="flex overflow-x-auto snap-x snap-mandatory p-4 gap-4 scrollbar-hide"
                >
                    {availableMonths.map((month) => {
                        const dataForMonth = monthlyData[month] || [];
                        // const total = dataForMonth.reduce((s, i) => s + i.amount, 0);
                        const isCurrent = month === selectedMonth;
                        const isRealCurrentMonth = month === format(new Date(), 'yyyy/MM');

                        const income = dataForMonth.filter(d => d.type === 'Income').reduce((s, i) => s + i.amount, 0);
                        const expense = dataForMonth.filter(d => d.type !== 'Income').reduce((s, i) => s + i.amount, 0);
                        const balance = income - expense;

                        return (
                            <div
                                key={month}
                                data-month={month}
                                className="month-card snap-center shrink-0 w-full max-w-[85vw] sm:max-w-sm"
                            >
                                <div className={clsx(
                                    "rounded-2xl p-6 text-white shadow-lg transition-transform duration-300 relative overflow-hidden",
                                    isCurrent ? "scale-100 opacity-100 ring-2 ring-offset-2" : "scale-95 opacity-80",
                                    isCurrent && isDarkMode ? "ring-indigo-900" : "ring-indigo-300",
                                    // Card Colors
                                    isRealCurrentMonth
                                        ? (isDarkMode ? "bg-gradient-to-br from-indigo-900 to-indigo-950" : "bg-gradient-to-br from-indigo-600 to-indigo-800")
                                        : (isDarkMode ? "bg-gradient-to-br from-slate-700 to-slate-800" : "bg-gradient-to-br from-slate-500 to-slate-700")
                                )}>
                                    <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full blur-2xl pointer-events-none" />

                                    <div className="flex items-center justify-between mb-4 relative z-10">
                                        <div className="flex items-center gap-2 opacity-90">
                                            <CalendarIcon size={16} />
                                            <span className="text-sm font-medium">
                                                {isRealCurrentMonth ? "今月の収支" : `${month.split('/')[1]}月の収支`}
                                            </span>
                                        </div>
                                        <span className="text-xs bg-white/20 px-2 py-1 rounded-full">{month}</span>
                                    </div>

                                    <span className="text-4xl font-bold tracking-tight">
                                        ¥{balance.toLocaleString()}
                                    </span>

                                    <div className="mt-6 flex justify-between items-center text-xs opacity-90 relative z-10">
                                        <div className="flex flex-col">
                                            <span className="opacity-70 mb-0.5">収入</span>
                                            <span className="font-bold text-base">¥{income.toLocaleString()}</span>
                                        </div>
                                        <div className="w-px h-8 bg-white/20" />
                                        <div className="flex flex-col items-end">
                                            <span className="opacity-70 mb-0.5">支出</span>
                                            <span className="font-bold text-base">¥{expense.toLocaleString()}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Pagination Dots */}
                <div className="flex justify-center gap-1 mb-4">
                    {availableMonths.map(m => (
                        <div
                            key={m}
                            className={clsx(
                                "w-1.5 h-1.5 rounded-full transition-colors",
                                m === selectedMonth ? "bg-indigo-500" : (isDarkMode ? "bg-slate-700" : "bg-gray-300")
                            )}
                        />
                    ))}
                </div>
            </div>

            {/* Category Breakdown */}
            <div className="px-4 mb-6">
                <h2 className={clsx("text-sm font-semibold mb-3 px-2 flex justify-between", subTextColor)}>
                    <span>{selectedMonth.split('/')[1]}月のレポート</span>
                    <span className={clsx("text-xs font-normal px-2 py-1 rounded", isDarkMode ? "bg-slate-800 text-gray-300" : "bg-gray-100")}>
                        {selectedMonth}
                    </span>
                </h2>

                {/* Chart */}
                {categoryChartData.length > 0 ? (
                    <div className="h-64 -my-4 relative z-0">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={categoryChartData}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={60}
                                    outerRadius={80}
                                    paddingAngle={5}
                                    dataKey="value"
                                    stroke={isDarkMode ? "#020617" : "#fff"}
                                >
                                    {categoryChartData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />
                                    ))}
                                </Pie>
                                <Tooltip
                                    formatter={(value: any) => [`¥${(value || 0).toLocaleString()}`, '金額']}
                                    contentStyle={{
                                        borderRadius: '12px',
                                        border: 'none',
                                        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                                        backgroundColor: isDarkMode ? '#1e293b' : '#fff',
                                        color: isDarkMode ? '#fff' : '#000'
                                    }}
                                />
                            </PieChart>
                        </ResponsiveContainer>
                        {/* Center Text (Total) */}
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="text-center">
                                <div className={clsx("text-xs", isDarkMode ? "text-gray-500" : "text-gray-400")}>Total</div>
                                <div className={clsx("font-bold", isDarkMode ? "text-gray-200" : "text-gray-700")}>¥{currentViewTotal.toLocaleString()}</div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className={clsx("h-40 flex items-center justify-center text-gray-400 rounded-xl border border-dashed", isDarkMode ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200")}>
                        データがありません
                    </div>
                )}

                {/* Legend List */}
                <div className="grid grid-cols-2 gap-3 mt-2">
                    {categoryChartData.map((item, i) => (
                        <button
                            key={i}
                            onClick={() => setSelectedCategory(prev => prev === item.name ? null : item.name)}
                            className={clsx(
                                "p-3 rounded-xl shadow-sm border flex items-center justify-between transition-all",
                                selectedCategory === item.name
                                    ? (isDarkMode ? "bg-indigo-900/30 border-indigo-500 ring-1 ring-indigo-500" : "bg-indigo-50 border-indigo-500 ring-1 ring-indigo-500")
                                    : (isDarkMode ? "bg-slate-900 border-slate-800 hover:bg-slate-800" : "bg-white border-gray-100 hover:bg-gray-50"),
                                selectedCategory && selectedCategory !== item.name && "opacity-50"
                            )}
                        >
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                                <div className={clsx("text-xs", isDarkMode ? "text-gray-400" : "text-gray-500")}>{item.name}</div>
                            </div>
                            <div className={clsx("text-sm font-bold", isDarkMode ? "text-gray-200" : "text-gray-800")}>¥{item.value.toLocaleString()}</div>
                        </button>
                    ))}
                </div>
            </div>

            {/* Expense List */}
            <div className="px-4">
                <h2 className={clsx("text-sm font-semibold mb-3 px-2 flex justify-between items-center", subTextColor)}>
                    <span>
                        {selectedCategory
                            ? `${selectedCategory}の履歴 (${filteredViewData.length}件)`
                            : `${selectedMonth.split('/')[1]}月の履歴`}
                    </span>
                    {selectedCategory && (
                        <button
                            onClick={() => setSelectedCategory(null)}
                            className="text-xs text-indigo-500 hover:underline"
                        >
                            解除
                        </button>
                    )}
                </h2>

                {loading && expenses.length === 0 ? (
                    <div className="space-y-3">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className={clsx("h-20 rounded-xl animate-pulse", isDarkMode ? "bg-slate-900" : "bg-white")} />
                        ))}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredViewData.map((item, index) => (
                            <div
                                key={`${item.id}-${index}`}
                                className={clsx(
                                    "p-4 rounded-xl shadow-sm border flex justify-between items-center",
                                    cardBgColor
                                )}
                            >
                                <div>
                                    <div className="text-xs text-gray-400 mb-0.5">{format(new Date(item.date), 'M/d (EEE)')}</div>
                                    <div className={clsx("font-medium line-clamp-1", isDarkMode ? "text-gray-200" : "text-gray-800")}>{item.merchant}</div>
                                    <span className={clsx(
                                        "inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full",
                                        item.type === 'Income'
                                            ? (isDarkMode ? "bg-emerald-900/30 text-emerald-400" : "bg-emerald-100 text-emerald-600")
                                            : (isDarkMode ? "bg-slate-800 text-slate-400" : "bg-gray-100 text-gray-500")
                                    )}>
                                        {item.category || '未分類'}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className={clsx(
                                        "text-lg font-bold",
                                        item.type === 'Income'
                                            ? (isDarkMode ? "text-emerald-400" : "text-emerald-600")
                                            : (isDarkMode ? "text-gray-100" : "text-gray-900")
                                    )}>
                                        {item.type === 'Income' ? '+' : ''}¥{item.amount.toLocaleString()}
                                    </div>
                                    <button
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            if (!confirm('この明細を削除しますか？')) return;
                                            try {
                                                await fetch('/api/expenses', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ action: 'deleteTransaction', id: item.id, source }) // Pass source here if needed for deletion
                                                });
                                                refresh();
                                            } catch (err) {
                                                alert('削除に失敗しました');
                                            }
                                        }}
                                        className="text-xs text-red-300 hover:text-red-500 px-2"
                                    >
                                        ×
                                    </button>
                                </div>
                            </div>
                        ))}

                        {filteredViewData.length === 0 && (
                            <div className="text-center py-10 text-gray-400">
                                {selectedCategory ? 'このカテゴリの履歴はありません' : 'この月のデータはありません'}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <BottomNav />
        </main>
    );
}
