'use client';

import { useEffect, useMemo, useState } from 'react';
import { useExpenses } from '@/hooks/useExpenses';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, isSameMonth, isToday } from 'date-fns';
import { ja } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import BottomNav from '@/components/BottomNav';
import ExpenseDetailModal from './ExpenseDetailModal';
import { Expense } from '@/lib/api';

interface CalendarViewProps {
    source?: string;
    isDarkMode?: boolean;
}

interface DayTotals {
    income: number;
    expense: number;
    items: Expense[];
}

// Normalizes an expense date string to the calendar cell key
function toDayKey(date: string) {
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return null;
    return format(parsed, 'yyyy/MM/dd');
}

export default function CalendarView({ source, isDarkMode = false }: CalendarViewProps) {
    const { expenses, loading, error, refresh, removeLocal, updateLocal } = useExpenses(source);
    const [currentDate, setCurrentDate] = useState(new Date());
    const [direction, setDirection] = useState(0);
    const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);

    // Surface fetch failures without wiping the cached list
    useEffect(() => {
        if (error) toast.error(error);
    }, [error]);

    // Theme Colors
    const bgColor = isDarkMode ? 'bg-slate-950' : 'bg-white';
    const headerBg = isDarkMode ? 'bg-slate-950 border-slate-800' : 'bg-white border-b';
    const textColor = isDarkMode ? 'text-gray-100' : 'text-gray-800';
    const subTextColor = isDarkMode ? 'text-gray-400' : 'text-gray-600';
    const cardBg = isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-100';
    const summaryBg = isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-gray-50 border-gray-200';

    // Calendar Logic
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);

    const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

    // Pre-aggregate per-day totals in one pass instead of filtering per cell
    const dayTotals = useMemo(() => {
        const map = new Map<string, DayTotals>();
        expenses.forEach(item => {
            const key = toDayKey(item.date);
            if (!key) return;
            let totals = map.get(key);
            if (!totals) {
                totals = { income: 0, expense: 0, items: [] };
                map.set(key, totals);
            }
            if (item.type === 'Income') {
                totals.income += item.amount;
            } else {
                totals.expense += item.amount;
            }
            totals.items.push(item);
        });
        return map;
    }, [expenses]);

    const monthlySummary = useMemo(() => {
        const monthKey = format(currentDate, 'yyyy/MM');
        let income = 0;
        let expense = 0;
        dayTotals.forEach((totals, key) => {
            if (key.startsWith(monthKey)) {
                income += totals.income;
                expense += totals.expense;
            }
        });
        return { income, expense, balance: income - expense };
    }, [dayTotals, currentDate]);

    const selectedDayExpenses = dayTotals.get(format(currentDate, 'yyyy/MM/dd'))?.items ?? [];

    const nextMonth = () => {
        setDirection(1);
        setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    };
    const prevMonth = () => {
        setDirection(-1);
        setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    };

    // Swipe Logic
    const [touchStart, setTouchStart] = useState<number | null>(null);
    const [touchEnd, setTouchEnd] = useState<number | null>(null);

    const minSwipeDistance = 50;

    const onTouchStart = (e: React.TouchEvent) => {
        setTouchEnd(null);
        setTouchStart(e.targetTouches[0].clientX);
    };

    const onTouchMove = (e: React.TouchEvent) => {
        setTouchEnd(e.targetTouches[0].clientX);
    };

    const onTouchEnd = () => {
        if (!touchStart || !touchEnd) return;
        const distance = touchStart - touchEnd;
        const isLeftSwipe = distance > minSwipeDistance;
        const isRightSwipe = distance < -minSwipeDistance;

        if (isLeftSwipe) {
            nextMonth();
        }
        if (isRightSwipe) {
            prevMonth();
        }
    };

    const variants = {
        enter: (direction: number) => ({
            x: direction > 0 ? 300 : -300,
            opacity: 0
        }),
        center: {
            x: 0,
            opacity: 1
        },
        exit: (direction: number) => ({
            x: direction < 0 ? 300 : -300,
            opacity: 0
        })
    };

    return (
        <main
            className={clsx("min-h-screen pb-24 overflow-x-hidden transition-colors", bgColor)}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
        >
            <AnimatePresence initial={false} custom={direction} mode="popLayout">
                <motion.div
                    key={format(currentDate, 'yyyy-MM')}
                    custom={direction}
                    variants={variants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{
                        x: { type: "spring", stiffness: 300, damping: 30 },
                        opacity: { duration: 0.2 }
                    }}
                    className="w-full"
                >
                    {/* Header */}
                    <header className={clsx("px-6 py-4 z-10 border-b space-y-3", headerBg)}>
                        <div className="flex justify-between items-center">
                            <button onClick={(e) => { e.stopPropagation(); prevMonth(); }} className={clsx("p-2 rounded-full", isDarkMode ? "hover:bg-slate-800" : "hover:bg-gray-100")}>
                                <ChevronLeft size={24} className={subTextColor} />
                            </button>
                            <h1 className={clsx("text-lg font-bold", textColor)}>
                                {format(currentDate, 'yyyy年 M月', { locale: ja })}
                            </h1>
                            <button onClick={(e) => { e.stopPropagation(); nextMonth(); }} className={clsx("p-2 rounded-full", isDarkMode ? "hover:bg-slate-800" : "hover:bg-gray-100")}>
                                <ChevronRight size={24} className={subTextColor} />
                            </button>
                        </div>

                        {/* Monthly Summary */}
                        <div className={clsx("flex justify-between items-center rounded-xl p-3 text-sm", summaryBg)}>
                            <div className={clsx("text-center flex-1 border-r", isDarkMode ? "border-slate-800" : "border-gray-200")}>
                                <div className="text-[10px] text-gray-400">収入</div>
                                <div className={clsx("font-bold", isDarkMode ? "text-emerald-400" : "text-emerald-600")}>
                                    ¥{monthlySummary.income.toLocaleString()}
                                </div>
                            </div>
                            <div className={clsx("text-center flex-1 border-r", isDarkMode ? "border-slate-800" : "border-gray-200")}>
                                <div className="text-[10px] text-gray-400">支出</div>
                                <div className={clsx("font-bold", isDarkMode ? "text-gray-200" : "text-gray-700")}>
                                    ¥{monthlySummary.expense.toLocaleString()}
                                </div>
                            </div>
                            <div className="text-center flex-1">
                                <div className="text-[10px] text-gray-400">収支</div>
                                <div className={clsx("font-bold", monthlySummary.balance >= 0 ? (isDarkMode ? "text-indigo-400" : "text-indigo-600") : "text-red-500")}>
                                    {monthlySummary.balance.toLocaleString()}
                                </div>
                            </div>
                        </div>
                    </header>

                    {/* Weekday Headers */}
                    <div className={clsx("grid grid-cols-7 text-center py-4", bgColor)}>
                        {['日', '月', '火', '水', '木', '金', '土'].map((day, i) => (
                            <div key={day} className={clsx("text-xs font-semibold select-none", i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-gray-400")}>
                                {day}
                            </div>
                        ))}
                    </div>

                    {/* Calendar Grid */}
                    <div className="grid grid-cols-7 gap-1 px-2 pb-2">
                        {calendarDays.map((day) => {
                            const totals = dayTotals.get(format(day, 'yyyy/MM/dd'));
                            const incomeSum = totals?.income ?? 0;
                            const expenseSum = totals?.expense ?? 0;

                            const isCurrentMonth = isSameMonth(day, monthStart);
                            const isTodayDate = isToday(day);
                            const isSelected = format(day, 'yyyy/MM/dd') === format(currentDate, 'yyyy/MM/dd');

                            return (
                                <div
                                    key={day.toISOString()}
                                    onClick={() => setCurrentDate(day)}
                                    className={clsx(
                                        "aspect-[4/5] flex flex-col items-center justify-start py-1 relative transition-all cursor-pointer rounded-xl border border-transparent",
                                        !isCurrentMonth && "opacity-30",
                                        isSelected
                                            ? (isDarkMode ? "bg-slate-800 border-indigo-500 shadow-md z-10" : "bg-white border-indigo-500 shadow-md z-10")
                                            : (isDarkMode ? "hover:bg-slate-900" : "hover:bg-gray-50"),
                                    )}
                                >
                                    <div className={clsx(
                                        "text-xs mb-0.5 font-medium",
                                        isTodayDate ? "text-indigo-500 font-bold" : (isDarkMode ? "text-gray-300" : "text-gray-700")
                                    )}>
                                        {format(day, 'd')}
                                    </div>

                                    <div className="flex flex-col gap-0.5 w-full px-0.5">
                                        {incomeSum > 0 && (
                                            <div className={clsx(
                                                "text-[9px] font-bold px-1 rounded-sm text-center truncate",
                                                isSelected ? "bg-emerald-100 text-emerald-700" : "text-emerald-600 bg-emerald-50/50"
                                            )}>
                                                ¥{incomeSum.toLocaleString()}
                                            </div>
                                        )}
                                        {expenseSum > 0 && (
                                            <div className={clsx(
                                                "text-[9px] font-bold px-1 rounded-sm text-center truncate",
                                                isSelected ? (isDarkMode ? "bg-red-900/40 text-red-300" : "bg-red-100 text-red-700") : (isDarkMode ? "text-gray-500" : "text-gray-600")
                                            )}>
                                                ¥{expenseSum.toLocaleString()}
                                            </div>
                                        )}
                                    </div>

                                    {/* Dot indicator for today */}
                                    {isTodayDate && !isSelected && (
                                        <div className="absolute top-1 right-1 w-1 h-1 bg-indigo-500 rounded-full" />
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Daily Details List */}
                    <div className="px-4 py-6">
                        <h2 className={clsx("text-sm font-semibold mb-3 px-2 flex justify-between items-center", subTextColor)}>
                            <span>{format(currentDate, 'M月d日 (EEE)', { locale: ja })} の明細</span>
                        </h2>

                        {loading && expenses.length === 0 ? (
                            <div className="space-y-3">
                                {[...Array(3)].map((_, i) => (
                                    <div key={i} className={clsx("h-16 rounded-xl animate-pulse", isDarkMode ? "bg-slate-900" : "bg-gray-100")} />
                                ))}
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {selectedDayExpenses.map((item, index) => (
                                    <div
                                        key={`${item.id}-${index}`}
                                        onClick={() => setSelectedExpense(item)}
                                        className={clsx("p-4 rounded-xl shadow-sm border flex justify-between items-center cursor-pointer transition-transform active:scale-[0.99]", cardBg)}
                                    >
                                        <div className="flex-1 min-w-0 mr-2">
                                            <div className={clsx("font-medium truncate", textColor)}>{item.merchant}</div>
                                            <span className={clsx(
                                                "inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap",
                                                item.type === 'Income'
                                                    ? (isDarkMode ? "bg-emerald-900/30 text-emerald-400" : "bg-emerald-100 text-emerald-600")
                                                    : (isDarkMode ? "bg-slate-800 text-slate-400" : "bg-gray-100 text-gray-500")
                                            )}>
                                                {item.category || '未分類'}
                                            </span>
                                        </div>
                                        <div className={clsx(
                                            "text-lg font-bold whitespace-nowrap shrink-0",
                                            item.type === 'Income'
                                                ? (isDarkMode ? "text-emerald-400" : "text-emerald-600")
                                                : (isDarkMode ? "text-gray-100" : "text-gray-900")
                                        )}>
                                            {item.type === 'Income' ? '+' : ''}¥{item.amount.toLocaleString()}
                                        </div>
                                    </div>
                                ))}

                                {selectedDayExpenses.length === 0 && (
                                    <div className={clsx("text-center py-8 text-xs border border-dashed rounded-xl", isDarkMode ? "border-slate-800 text-gray-500" : "border-gray-200 text-gray-400")}>
                                        この日の支出はありません
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </motion.div>
            </AnimatePresence>

            <ExpenseDetailModal
                isOpen={!!selectedExpense}
                onClose={() => setSelectedExpense(null)}
                expense={selectedExpense}
                source={source}
                onUpdate={refresh}
                onLocalRemove={removeLocal}
                onLocalUpdate={updateLocal}
            />

            <BottomNav />
        </main>
    );
}
