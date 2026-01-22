import { startTransition, useOptimistic, useState } from 'react';
import clsx from 'clsx';
import { X, Trash2, Save, AlertCircle } from 'lucide-react';
import { Expense } from '@/lib/api';

interface ExpenseDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    expense: Expense | null;
    source?: string;
    onUpdate: () => void; // Callback to refresh data
}

const CATEGORIES = [
    '食費', '日用品', '交通費', '交際費', '趣味・娯楽', '衣服・美容',
    '健康・医療', '通信費', '水道・光熱費', '住居費', '教育・教養',
    '特別費', '雑費', '給料', 'その他'
];

export default function ExpenseDetailModal({ isOpen, onClose, expense, source = 'main', onUpdate }: ExpenseDetailModalProps) {
    const [selectedCategory, setSelectedCategory] = useState(expense?.category || '');
    const [isUpdating, setIsUpdating] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    // Sync category when expense changes
    if (isOpen && expense && selectedCategory === '' && selectedCategory !== expense.category) {
        setSelectedCategory(expense.category);
    }

    if (!isOpen || !expense) return null;

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
        } catch (e) {
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
        } catch (e) {
            alert('エラーが発生しました');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-sm overflow-hidden shadow-xl transform transition-all">
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
