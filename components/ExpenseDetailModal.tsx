import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { X, Trash2, Save, AlertCircle, CalendarDays, JapaneseYen } from 'lucide-react';
import { Expense } from '@/lib/api';
import { EXPENSE_CATEGORIES } from '@/lib/categories';

interface ExpenseDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    expense: Expense | null;
    source?: string;
    onUpdate: () => void; // Callback to refresh data
    onLocalRemove?: (expense: Expense) => void; // Optimistic removal
    onLocalUpdate?: (expense: Expense, changes: Partial<Expense>) => void; // Optimistic update
}

function toDateInputValue(date: string) {
    return date.replace(/\//g, '-').slice(0, 10);
}

export default function ExpenseDetailModal({ isOpen, onClose, expense, source = 'main', onUpdate, onLocalRemove, onLocalUpdate }: ExpenseDetailModalProps) {
    const [selectedCategory, setSelectedCategory] = useState(expense?.category || '');
    const [selectedDate, setSelectedDate] = useState(expense ? toDateInputValue(expense.date) : '');
    const [selectedAmount, setSelectedAmount] = useState(expense ? String(expense.amount) : '');
    const [categoryScope, setCategoryScope] = useState<'single' | 'merchant'>('merchant');
    const [isUpdatingDate, setIsUpdatingDate] = useState(false);
    const [isUpdatingAmount, setIsUpdatingAmount] = useState(false);
    const [confirmingCategory, setConfirmingCategory] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    useEffect(() => {
        if (!isOpen || !expense) return;
        setSelectedCategory(expense.category || '未分類');
        setSelectedDate(toDateInputValue(expense.date));
        setSelectedAmount(String(expense.amount));
        setCategoryScope('merchant');
        setConfirmingCategory(false);
        setConfirmingDelete(false);
    }, [isOpen, expense]);

    if (!isOpen || !expense) return null;

    const handleUpdateDate = async () => {
        if (!selectedDate) {
            toast.error('日付を入力してください');
            return;
        }

        const newDate = selectedDate.replace(/-/g, '/');
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
                    date: newDate
                }),
            });
            const data = await res.json();
            if (data.success) {
                toast.success('日付を更新しました');
                onLocalUpdate?.(expense, { date: newDate });
                onUpdate();
                onClose();
            } else {
                toast.error('更新に失敗しました: ' + (data.error || 'Unknown error'));
            }
        } catch {
            toast.error('エラーが発生しました');
        } finally {
            setIsUpdatingDate(false);
        }
    };

    const handleUpdateAmount = async () => {
        const amount = Number(selectedAmount);
        if (!selectedAmount || !isFinite(amount) || amount <= 0) {
            toast.error('正しい金額を入力してください');
            return;
        }

        setIsUpdatingAmount(true);
        try {
            const res = await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'updateTransaction',
                    source: source,
                    id: expense.id,
                    currentDate: expense.date,
                    currentMerchant: expense.merchant,
                    currentAmount: expense.amount,
                    amount
                }),
            });
            const data = await res.json();
            if (data.success) {
                toast.success('金額を更新しました');
                onLocalUpdate?.(expense, { amount });
                onUpdate();
                onClose();
            } else {
                toast.error('更新に失敗しました: ' + (data.error || 'Unknown error'));
            }
        } catch {
            toast.error('エラーが発生しました');
        } finally {
            setIsUpdatingAmount(false);
        }
    };

    // Optimistic: apply locally and close right away, reconcile in the background
    const handleUpdateCategory = () => {
        const category = selectedCategory;

        // Single-row change: strict-matched updateTransaction, no extra confirm needed
        if (categoryScope === 'single') {
            onLocalUpdate?.(expense, { category });
            toast.success(`この明細のカテゴリを「${category}」に変更しました`);
            onClose();

            fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'updateTransaction',
                    source: source,
                    id: expense.id,
                    currentDate: expense.date,
                    currentMerchant: expense.merchant,
                    currentAmount: expense.amount,
                    category
                }),
            })
                .then(res => res.json())
                .then(data => {
                    if (!data.success) {
                        toast.error('カテゴリの更新に失敗しました: ' + (data.error || 'Unknown error'));
                    }
                    onUpdate();
                })
                .catch(() => {
                    toast.error('カテゴリの更新に失敗しました');
                    onUpdate();
                });
            return;
        }

        // Merchant-wide change also rewrites the auto-categorize rule: two-tap confirm
        if (!confirmingCategory) {
            setConfirmingCategory(true);
            return;
        }

        onLocalUpdate?.(expense, { category });
        toast.success(`カテゴリを「${category}」に変更しました`);
        onClose();

        fetch('/api/expenses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'updateCategory',
                source: source,
                merchant: expense.merchant,
                category
            }),
        })
            .then(res => res.json())
            .then(data => {
                if (!data.success) {
                    toast.error('カテゴリの更新に失敗しました: ' + (data.error || 'Unknown error'));
                }
                onUpdate();
            })
            .catch(() => {
                toast.error('カテゴリの更新に失敗しました');
                onUpdate();
            });
    };

    // Optimistic: remove locally and close right away, reconcile in the background
    const handleDelete = () => {
        if (!confirmingDelete) {
            setConfirmingDelete(true);
            return;
        }

        onLocalRemove?.(expense);
        toast.success('削除しました');
        onClose();

        fetch('/api/expenses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'deleteTransaction',
                source: source,
                id: expense.id,
                // Extra fields for strict row matching (older GAS ignores them)
                date: expense.date,
                merchant: expense.merchant,
                amount: expense.amount
            }),
        })
            .then(res => res.json())
            .then(data => {
                if (!data.success) {
                    toast.error('削除に失敗しました: ' + (data.error || 'Unknown error'));
                    onUpdate();
                }
            })
            .catch(() => {
                toast.error('削除に失敗しました');
                onUpdate();
            });
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

                    {/* Amount Editor */}
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">金額変更</label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
                            <input
                                type="number"
                                inputMode="numeric"
                                value={selectedAmount}
                                onChange={(e) => setSelectedAmount(e.target.value)}
                                className="w-full text-base p-3 pl-8 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white font-bold"
                            />
                        </div>
                        <button
                            onClick={handleUpdateAmount}
                            disabled={isUpdatingAmount || selectedAmount === String(expense.amount)}
                            className={clsx(
                                "w-full py-3 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-[0.98]",
                                isUpdatingAmount || selectedAmount === String(expense.amount)
                                    ? "bg-blue-300 dark:bg-blue-900/60"
                                    : "bg-blue-600 hover:bg-blue-700"
                            )}
                        >
                            <JapaneseYen size={18} />
                            {isUpdatingAmount ? '更新中...' : '金額を保存'}
                        </button>
                        <p className="text-xs text-gray-400">選択した明細1件の金額だけを変更します。</p>
                    </div>

                    {/* Category Selector */}
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">カテゴリ変更</label>
                        <div className="relative">
                            <select
                                value={selectedCategory}
                                onChange={(e) => { setSelectedCategory(e.target.value); setConfirmingCategory(false); }}
                                className="w-full text-base p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white"
                            >
                                {EXPENSE_CATEGORIES.map(cat => (
                                    <option key={cat} value={cat}>{cat}</option>
                                ))}
                            </select>
                        </div>
                        {/* Scope selector */}
                        <div className="flex p-1 rounded-lg bg-gray-100 dark:bg-slate-800">
                            <button
                                onClick={() => { setCategoryScope('merchant'); setConfirmingCategory(false); }}
                                className={clsx(
                                    "flex-1 py-1.5 text-xs font-bold rounded-md transition-all",
                                    categoryScope === 'merchant' ? "bg-white dark:bg-slate-600 text-gray-800 dark:text-white shadow-sm" : "text-gray-400"
                                )}
                            >
                                この店舗すべて
                            </button>
                            <button
                                onClick={() => { setCategoryScope('single'); setConfirmingCategory(false); }}
                                className={clsx(
                                    "flex-1 py-1.5 text-xs font-bold rounded-md transition-all",
                                    categoryScope === 'single' ? "bg-white dark:bg-slate-600 text-gray-800 dark:text-white shadow-sm" : "text-gray-400"
                                )}
                            >
                                この明細のみ
                            </button>
                        </div>
                        <p className="text-xs text-gray-400 flex items-start gap-1">
                            <AlertCircle size={12} className="mt-0.5 shrink-0" />
                            {categoryScope === 'merchant'
                                ? '変更すると、このお店の過去・未来の取引もすべてこのカテゴリに統一されます。'
                                : 'この明細1件だけを変更します。自動分類ルールは変わりません。'}
                        </p>
                    </div>

                    {/* Actions */}
                    <div className="space-y-3 pt-2">
                        <button
                            onClick={handleUpdateCategory}
                            className={clsx(
                                "w-full py-3.5 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-[0.98]",
                                confirmingCategory
                                    ? "bg-amber-500 hover:bg-amber-600 shadow-lg shadow-amber-500/20"
                                    : "bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/20"
                            )}
                        >
                            <Save size={18} />
                            {confirmingCategory ? 'もう一度タップで店舗全体に適用' : 'カテゴリ設定を保存'}
                        </button>

                        <button
                            onClick={handleDelete}
                            className={clsx(
                                "w-full py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors",
                                confirmingDelete
                                    ? "bg-red-600 hover:bg-red-700 text-white"
                                    : "text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30"
                            )}
                        >
                            <Trash2 size={18} />
                            {confirmingDelete ? 'もう一度タップで削除' : 'この明細を削除'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
