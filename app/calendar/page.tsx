'use client';

import { useState } from 'react';
import { useExpenses } from '@/hooks/useExpenses';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, isSameMonth, isSameDay, isToday } from 'date-fns';
import { ja } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import BottomNav from '@/components/BottomNav';

export default function CalendarPage() {
    const { expenses } = useExpenses();
    const [currentDate, setCurrentDate] = useState(new Date());
    const [direction, setDirection] = useState(0);

    // Calendar Logic
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);

    const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

    const getDayTotal = (day: Date) => {
        return expenses
            .filter(item => isSameDay(new Date(item.date), day))
            .reduce((sum, item) => sum + item.amount, 0);
    };

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
            className="min-h-screen bg-white pb-24 overflow-x-hidden"
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
                    <header className="px-6 py-4 bg-white z-10 border-b space-y-3">
                        <div className="flex justify-between items-center">
                            <button onClick={(e) => { e.stopPropagation(); prevMonth(); }} className="p-2 rounded-full hover:bg-gray-100">
                                <ChevronLeft size={24} className="text-gray-600" />
                            </button>
                            <h1 className="text-lg font-bold text-gray-800">
                                {format(currentDate, 'yyyy年 M月', { locale: ja })}
                            </h1>
                            <button onClick={(e) => { e.stopPropagation(); nextMonth(); }} className="p-2 rounded-full hover:bg-gray-100">
                                <ChevronRight size={24} className="text-gray-600" />
                            </button>
                        </div>

                        {/* Monthly Summary */}
                        <div className="flex justify-between items-center bg-gray-50 rounded-xl p-3 text-sm">
                            <div className="text-center flex-1 border-r border-gray-200">
                                <div className="text-[10px] text-gray-400">収入</div>
                                <div className="font-bold text-emerald-600">
                                    ¥{expenses
                                        .filter(item => isSameMonth(new Date(item.date), currentDate) && item.type === 'Income')
                                        .reduce((sum, i) => sum + i.amount, 0).toLocaleString()}
                                </div>
                            </div>
                            <div className="text-center flex-1 border-r border-gray-200">
                                <div className="text-[10px] text-gray-400">支出</div>
                                <div className="font-bold text-gray-700">
                                    ¥{expenses
                                        .filter(item => isSameMonth(new Date(item.date), currentDate) && item.type !== 'Income')
                                        .reduce((sum, i) => sum + i.amount, 0).toLocaleString()}
                                </div>
                            </div>
                            <div className="text-center flex-1">
                                <div className="text-[10px] text-gray-400">収支</div>
                                {(() => {
                                    const inc = expenses.filter(i => isSameMonth(new Date(i.date), currentDate) && i.type === 'Income').reduce((s, i) => s + i.amount, 0);
                                    const exp = expenses.filter(i => isSameMonth(new Date(i.date), currentDate) && i.type !== 'Income').reduce((s, i) => s + i.amount, 0);
                                    const bal = inc - exp;
                                    return (
                                        <div className={clsx("font-bold", bal >= 0 ? "text-indigo-600" : "text-red-500")}>
                                            {bal.toLocaleString()}
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>
                    </header>

                    {/* Weekday Headers */}
                    <div className="grid grid-cols-7 text-center py-4 bg-white">
                        {['日', '月', '火', '水', '木', '金', '土'].map((day, i) => (
                            <div key={day} className={clsx("text-xs font-semibold select-none", i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-gray-400")}>
                                {day}
                            </div>
                        ))}
                    </div>

                    {/* Calendar Grid */}
                    <div className="grid grid-cols-7 gap-1 px-2 pb-2">
                        {calendarDays.map((day, idx) => {
                            // Separate calculations
                            const dayExpenses = expenses.filter(item => isSameDay(new Date(item.date), day));
                            const incomeSum = dayExpenses.filter(i => i.type === 'Income').reduce((s, i) => s + i.amount, 0);
                            const expenseSum = dayExpenses.filter(i => i.type !== 'Income').reduce((s, i) => s + i.amount, 0);

                            const isCurrentMonth = isSameMonth(day, monthStart);
                            const isTodayDate = isToday(day);
                            const isSelected = isSameDay(day, currentDate);

                            return (
                                <div
                                    key={day.toISOString()}
                                    onClick={() => setCurrentDate(day)}
                                    className={clsx(
                                        "aspect-[4/5] flex flex-col items-center justify-start py-1 relative transition-all cursor-pointer rounded-xl border border-transparent",
                                        !isCurrentMonth && "opacity-30",
                                        isSelected
                                            ? "bg-white border-indigo-500 shadow-md z-10"
                                            : "bg-transparent hover:bg-gray-50",
                                    )}
                                >
                                    <div className={clsx(
                                        "text-xs mb-0.5 font-medium",
                                        isTodayDate ? "text-indigo-600 font-bold" : "text-gray-700"
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
                                                isSelected ? "bg-red-100 text-red-700" : "text-gray-600"
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
                        <h2 className="text-gray-500 text-sm font-semibold mb-3 px-2 flex justify-between items-center">
                            <span>{format(currentDate, 'M月d日 (EEE)', { locale: ja })} の明細</span>
                        </h2>

                        <div className="space-y-3">
                            {expenses
                                .filter(item => isSameDay(new Date(item.date), currentDate))
                                .map((item, index) => (
                                    <div
                                        key={`${item.id}-${index}`}
                                        className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex justify-between items-center group relative overflow-hidden"
                                    >
                                        <div>
                                            <div className="font-medium text-gray-800 line-clamp-1">{item.merchant}</div>
                                            <span className={clsx(
                                                "inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full",
                                                item.type === 'Income' ? "bg-emerald-100 text-emerald-600" : "bg-gray-100 text-gray-500"
                                            )}>
                                                {item.category || '未分類'}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <div className={clsx(
                                                "text-lg font-bold",
                                                item.type === 'Income' ? "text-emerald-600" : "text-gray-900"
                                            )}>
                                                {item.type === 'Income' ? '+' : ''}¥{item.amount.toLocaleString()}
                                            </div>
                                            {/* Delete Button */}
                                            <button
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    if (!confirm('この明細を削除しますか？')) return;
                                                    try {
                                                        await fetch('/api/expenses', {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ action: 'deleteTransaction', id: item.id })
                                                        });
                                                        alert('削除しました');
                                                        window.location.reload();
                                                    } catch (err) {
                                                        alert('削除に失敗しました');
                                                    }
                                                }}
                                                className="text-xs text-red-300 hover:text-red-500 px-2 py-1"
                                            >
                                                削除
                                            </button>
                                        </div>
                                    </div>
                                ))}

                            {expenses.filter(item => isSameDay(new Date(item.date), currentDate)).length === 0 && (
                                <div className="text-center py-8 text-gray-400 text-xs border border-dashed border-gray-200 rounded-xl">
                                    この日の支出はありません
                                </div>
                            )}
                        </div>
                    </div>
                </motion.div>
            </AnimatePresence>
            <BottomNav />
        </main>
    );
}
