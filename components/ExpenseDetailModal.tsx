import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { X, Trash2, Save, AlertCircle, CalendarDays } from 'lucide-react';
import { Expense } from '@/lib/api';

interface ExpenseDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    expense: Expense | null;
    source?: string;
    onUpdate: () => void; // Callback to refresh data
}

const CATEGORIES = [
    '未分類', '食費', 'カフェ', '交通費', '音ゲー', '日用品', '交際費',
    '医療費', '光熱費', 'その他', '固定費', '身だしなみ'
];

function toDateInputValue(date: string) {
    return date.replace(/\//g, '-').slice(0, 10);
}

export default function ExpenseDetailModal({ isOpen, onClose, expense, source = 'main', onUpdate }: ExpenseDetailModalProps) {
    const [selectedCategory, setSelectedCategory] = useState(expense?.category || '');
    const [selectedDate, setSelectedDate] = useState(expense ? toDateInputValue(expense.date) : '');
    const [isUpdating, setIsUpdating] = useState(false);
    const [isUpdatingDate, setIsUpdatingDate] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    useEffect(() => {
        if (!isOpen || !expense) return;
        setSelectedCategory(expense.category || '未分類');
        setSelectedDate(toDateInputValue(expense.date));
    }, [isOpen, expense]);

    if (!isOpen || !expense) return null;

    const handleUpdateDate = async () => {
        if (!selectedDate) {
            alert('日付を入力してください');
            return;
        }

        setIsUpdatingDate(true);
        try {
            const res = await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'updateTransactionDate',
                    source: source,
                    id: expense.id,
                    currentDate: expense.date,
                    merchant: expense.merchant,
                    amount: expense.amount,
                    date: selectedDate.replace(/-/g, '/')
                }),
            });
            const data = await res.json();
            if (data.success) {
                alert('日付を更新しました');
                onUpdate();
                onClose();
            } else {
                alert('更新に失敗しました: ' + (data.error || 'Unknown error'));
            }
        } catch {
            alert('エラーが発生しました');
        } finally {
            setIsUpdatingDate(false);
        }
    };

    const handleUpdateCategory = async () => {
        if (!confirm(`「${expense.merchant}」のカテゴリを「${selectedCategory}」に変更しますか？\n※過去の履歴もすべて変更され、今後の自動分類設定も更新されます。`)) return;

        setIsUpdating(true);
        try {
            const res = await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'updateCategory',
                    source: source,
                    merchant: expense.merchant,
                    category: selectedCategory
                }),
            });
            const data = await res.json();
            if (data.success) {
                alert('カテゴリを更新しました');
                onUpdate();
                onClose();
            } else {
                alert('更新に失敗しました: ' + (data.error || 'Unknown error'));
            }
        } catch {
            alert('エラーが発生しました');
        } finally {
            setIsUpdating(false);
        }
    };

    const handleDelete = async () => {
        if (!confirm('本当にこの明細を削除しますか？')) return;

        setIsDeleting(true);
        try {
            const res = await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'deleteTransaction',
                    source: source,
                    id: expense.id
                }),
            });
            const data = await res.json();
            if (data.success) {
                onUpdate();
                onClose();
            } else {
                alert('削除に失敗しました: ' + (data.error || 'Unknown error'));
            }
        } catch {
            alert('エラーが発生しました');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto shadow-xl transform transition-all">
                {/* Header */}
                <div className="px-6 py-4 border-b border-gray-100 dark:border-slate-800 flex justify-between items-center">
                    <h3 className="font-bold text-lg text-gray-900 dark:text-white">明細詳細</h3>
                    <button onClick={onClose} className="p-2 -mr-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 space-y-6">
                    {/* Basic Info */}
                    <div className="text-center space-y-2">
                        <div className="text-sm text-gray-500 dark:text-gray-400">{expense.date}</div>
                        <div className="text-xl font-bold text-gray-900 dark:text-white line-clamp-2">{expense.merchant}</div>
                        <div className={clsx("text-3xl font-bold font-mono tracking-tight", expense.type === 'Income' ? "text-emerald-500" : "text-gray-900 dark:text-white")}>
                            ¥{expense.amount.toLocaleString()}
                        </div>
                    </div>

                    {/* Date Editor */}
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">日付変更</label>
                        <input
                            type="date"
                            value={selectedDate}
                            onChange={(e) => setSelectedDate(e.target.value)}
                            className="w-full text-base p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white"
                        />
                        <button
                            onClick={handleUpdateDate}
                            disabled={isUpdatingDate || selectedDate === toDateInputValue(expense.date)}
                            className={clsx(
                                "w-full py-3 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-[0.98]",
                                isUpdatingDate || selectedDate === toDateInputValue(expense.date)
                                    ? "bg-blue-300 dark:bg-blue-900/60"
                                    : "bg-blue-600 hover:bg-blue-700"
                            )}
                        >
                            <CalendarDays size={18} />
                            {isUpdatingDate ? '更新中...' : '日付を保存'}
                        </button>
                        <p className="text-xs text-gray-400">選択した明細1件の日付だけを変更します。</p>
                    </div>

                    {/* Category Selector */}
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">カテゴリ変更</label>
                        <div className="relative">
                            <select
                                value={selectedCategory}
                                onChange={(e) => setSelectedCategory(e.target.value)}
                                className="w-full text-base p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white"
                            >
                                {CATEGORIES.map(cat => (
                                    <option key={cat} value={cat}>{cat}</option>
                                ))}
                            </select>
                            {/* Chevron down icon could go here via CSS or absolute SVG */}
                        </div>
                        <p className="text-xs text-gray-400 flex items-start gap-1">
                            <AlertCircle size={12} className="mt-0.5 shrink-0" />
                            変更すると、このお店の過去・未来の取引もすべてこのカテゴリに統一されます。
                        </p>
                    </div>

                    {/* Actions */}
                    <div className="space-y-3 pt-2">
                        <button
                            onClick={handleUpdateCategory}
                            disabled={isUpdating}
                            className={clsx(
                                "w-full py-3.5 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-[0.98]",
                                isUpdating ? "bg-blue-400" : "bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/20"
                            )}
                        >
                            <Save size={18} />
                            {isUpdating ? '更新中...' : 'カテゴリ設定を保存'}
                        </button>

                        <button
                            onClick={handleDelete}
                            disabled={isDeleting}
                            className="w-full py-3.5 rounded-xl font-bold text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 flex items-center justify-center gap-2 transition-colors"
                        >
                            <Trash2 size={18} />
                            {isDeleting ? '削除中...' : 'この明細を削除'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
