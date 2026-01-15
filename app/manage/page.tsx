'use client';

import BottomNav from '@/components/BottomNav';
import { useState } from 'react';
import { clsx } from 'clsx';
import { PlusCircle, RefreshCw, Check, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

export default function ManagePage() {
    const [activeTab, setActiveTab] = useState<'entry' | 'fixed'>('entry');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formData, setFormData] = useState({
        type: 'Expense',
        date: format(new Date(), 'yyyy-MM-dd'),
        merchant: '',
        amount: '',
        category: '食費'
    });

    const categories = {
        Expense: ['食費', '日用品', '交通費', '交際費', '趣味', '住居費', '光熱費', '通信費', 'その他'],
        Income: ['給料', '臨時収入', '賞与', 'その他']
    };

    const handleSubmit = async () => {
        if (!formData.amount) {
            alert('金額を入力してください');
            return;
        }

        setIsSubmitting(true);
        try {
            const res = await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'addTransaction',
                    date: formData.date.replace(/-/g, '/'), // Match YYYY/MM/DD format
                    merchant: formData.merchant || (formData.type === 'Income' ? '手動入力(収入)' : '手動入力(支出)'),
                    amount: formData.amount,
                    category: formData.category,
                    type: formData.type
                })
            });

            if (!res.ok) throw new Error('API Error');

            // Reset form
            setFormData(prev => ({ ...prev, merchant: '', amount: '' }));
            alert('追加しました！');
        } catch (e) {
            alert('エラーが発生しました');
            console.error(e);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <main className="min-h-screen bg-gray-50 pb-24">
            {/* Header */}
            <header className="bg-white border-b px-6 py-4 sticky top-0 z-10 shadow-sm safe-area-top">
                <h1 className="text-xl font-bold text-gray-800">管理・入力</h1>
            </header>

            {/* Tabs */}
            <div className="px-4 py-4">
                <div className="flex bg-white p-1 rounded-xl border border-gray-200 shadow-sm">
                    <button
                        onClick={() => setActiveTab('entry')}
                        className={clsx(
                            "flex-1 py-2 text-sm font-medium rounded-lg transition-colors",
                            activeTab === 'entry' ? "bg-indigo-50 text-indigo-600" : "text-gray-500 hover:bg-gray-50"
                        )}
                    >
                        手動入力
                    </button>
                    <button
                        onClick={() => setActiveTab('fixed')}
                        className={clsx(
                            "flex-1 py-2 text-sm font-medium rounded-lg transition-colors",
                            activeTab === 'fixed' ? "bg-indigo-50 text-indigo-600" : "text-gray-500 hover:bg-gray-50"
                        )}
                    >
                        固定費設定
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className="px-4 space-y-6">

                {activeTab === 'entry' && (
                    <div className="space-y-6">
                        {/* Manual Entry Section */}
                        <section className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
                            <div className="flex items-center gap-2 mb-5 text-gray-800 font-bold border-b pb-3">
                                <PlusCircle size={20} className="text-indigo-500" />
                                <h2>{formData.type === 'Income' ? '収入の入力' : '支出の入力'}</h2>
                            </div>

                            <div className="space-y-4">
                                {/* Type Toggle */}
                                <div className="flex bg-gray-100 p-1 rounded-lg">
                                    <button
                                        onClick={() => setFormData({ ...formData, type: 'Expense', category: '食費' })}
                                        className={clsx("flex-1 py-2 text-xs font-bold rounded-md transition-all", formData.type === 'Expense' ? "bg-white text-gray-800 shadow-sm" : "text-gray-400")}
                                    >
                                        支出 (Expense)
                                    </button>
                                    <button
                                        onClick={() => setFormData({ ...formData, type: 'Income', category: '給料' })}
                                        className={clsx("flex-1 py-2 text-xs font-bold rounded-md transition-all", formData.type === 'Income' ? "bg-emerald-500 text-white shadow-sm" : "text-gray-400")}
                                    >
                                        収入 (Income)
                                    </button>
                                </div>

                                <div className="flex gap-2">
                                    <input
                                        type="date"
                                        value={formData.date}
                                        onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                        className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm flex-1 outline-none focus:ring-2 focus:ring-indigo-100"
                                    />
                                    <select
                                        value={formData.category}
                                        onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                                        className="flex-1 bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm outline-none focus:ring-2 focus:ring-indigo-100"
                                    >
                                        {(formData.type === 'Income' ? categories.Income : categories.Expense).map(c => (
                                            <option key={c} value={c}>{c}</option>
                                        ))}
                                    </select>
                                </div>

                                <input
                                    type="text"
                                    placeholder={formData.type === 'Income' ? "内容 (任意)" : "内容 (任意)"}
                                    value={formData.merchant}
                                    onChange={(e) => setFormData({ ...formData, merchant: e.target.value })}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm outline-none focus:ring-2 focus:ring-indigo-100"
                                />

                                <div className="relative">
                                    <span className="absolute left-3 top-3 text-gray-400 text-sm">¥</span>
                                    <input
                                        type="number"
                                        placeholder="金額"
                                        value={formData.amount}
                                        onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                                        className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 pl-8 text-sm outline-none focus:ring-2 focus:ring-indigo-100 font-bold"
                                        inputMode="numeric"
                                    />
                                </div>

                                <button
                                    onClick={handleSubmit}
                                    disabled={isSubmitting}
                                    className={clsx(
                                        "w-full font-bold py-3.5 rounded-xl shadow-md transition-all flex justify-center items-center gap-2",
                                        formData.type === 'Income' ? "bg-emerald-500 hover:bg-emerald-600 text-white" : "bg-indigo-600 hover:bg-indigo-700 text-white",
                                        isSubmitting && "opacity-70 cursor-not-allowed"
                                    )}
                                >
                                    {isSubmitting ? <Loader2 className="animate-spin" /> : <Check size={18} />}
                                    <span>{isSubmitting ? '追加中...' : '追加する'}</span>
                                </button>
                            </div>
                        </section>

                        {/* Uncategorized Review Section (Optimized for space) */}
                        <section className="opacity-60 pointer-events-none grayscale">
                            {/* Placeholder for future implementation */}
                            <div className="text-center text-xs text-gray-400 mt-8">
                                カテゴリ未設定の自動検出は準備中です...
                            </div>
                        </section>
                    </div>
                )}

                {activeTab === 'fixed' && (
                    <FixedCostSection categories={categories} />
                )}

            </div>
            <BottomNav />
        </main>
    );
}

function FixedCostSection({ categories }: { categories: any }) {
    const [fixedCosts, setFixedCosts] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [showForm, setShowForm] = useState(false);

    // New Item Form State
    const [newItem, setNewItem] = useState({
        type: 'Expense',
        name: '',
        amount: '',
        day: '27',
        category: '住居費'
    });

    const days = Array.from({ length: 31 }, (_, i) => i + 1);

    // Initial Fetch
    const fetchFixedCosts = async () => {
        setIsLoading(true);
        try {
            // Add timestamp to prevent caching
            const res = await fetch(`/api/expenses?action=getFixedCosts&t=${Date.now()}`);
            if (!res.ok) throw new Error('Fetch failed');
            const data = await res.json();
            setFixedCosts(Array.isArray(data) ? data : []);
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    // Load data when component mounts
    useState(() => {
        fetchFixedCosts();
    });

    const handleAdd = async () => {
        if (!newItem.name || !newItem.amount) {
            alert('名前と金額を入力してください');
            return;
        }
        setIsAdding(true);
        try {
            await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'addFixedCost',
                    ...newItem
                })
            });
            setShowForm(false);
            setNewItem({ ...newItem, name: '', amount: '' });
            fetchFixedCosts(); // Refresh list
        } catch (e) {
            alert('エラーが発生しました');
        } finally {
            setIsAdding(false);
        }
    };

    const handleDelete = async (id: number) => {
        if (!confirm('本当に削除しますか？')) return;
        try {
            await fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'deleteFixedCost',
                    id: id
                })
            });
            fetchFixedCosts(); // Refresh list
        } catch (e) {
            alert('削除に失敗しました');
        }
    };

    return (
        <div className="space-y-6">
            <div className="bg-blue-50 p-4 rounded-xl text-blue-800 text-xs leading-relaxed">
                ここに登録した項目は、毎月指定した日に<strong>自動で家計簿に追加</strong>されます。<br />
                <span className="opacity-70">※家賃やサブスク、毎月の給料などに便利です。</span>
            </div>

            {/* List */}
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 min-h-[100px]">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-gray-800">登録済みの定期設定</h3>
                    <button onClick={fetchFixedCosts} className="text-gray-400 p-1 hover:bg-gray-50 rounded-full">
                        <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
                    </button>
                </div>

                <div className="space-y-3">
                    {fixedCosts.length === 0 && !isLoading && (
                        <div className="text-center text-gray-400 text-xs py-4">まだ設定がありません</div>
                    )}

                    {fixedCosts.map((item, index) => (
                        <div key={`${item.id}-${index}`} className="flex justify-between items-center py-3 border-b border-gray-50 last:border-0 group">
                            <div className="flex items-center gap-3">
                                <div className={clsx("w-1 h-8 rounded-full", item.type === 'Income' ? "bg-emerald-400" : "bg-indigo-400")}></div>
                                <div>
                                    <div className="font-bold text-gray-700 text-sm">{item.name}</div>
                                    <div className="text-xs text-gray-400">毎月 {item.day}日 / {item.category}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="text-right">
                                    <div className={clsx("font-bold text-sm", item.type === 'Income' ? "text-emerald-600" : "text-gray-800")}>
                                        ¥{Number(item.amount).toLocaleString()}
                                    </div>
                                    <div className="text-[10px] text-gray-400">{item.type === 'Income' ? '収入' : '支出'}</div>
                                </div>
                                <button
                                    onClick={() => handleDelete(item.id)}
                                    className="text-gray-300 hover:text-red-400 px-2"
                                >
                                    ×
                                </button>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Add Button */}
                {!showForm && (
                    <button
                        onClick={() => setShowForm(true)}
                        className="mt-6 w-full py-3 border-2 border-dashed border-gray-200 text-gray-400 rounded-xl text-sm font-bold hover:bg-gray-50 hover:border-indigo-200 hover:text-indigo-400 transition-colors flex justify-center items-center gap-2"
                    >
                        <PlusCircle size={16} /> 新しい定期設定を追加
                    </button>
                )}
            </div>

            {/* Add Form Modal/Inline */}
            {showForm && (
                <div className="bg-white p-5 rounded-2xl shadow-lg border border-indigo-100 animate-in fade-in slide-in-from-bottom-2">
                    <h3 className="font-bold text-gray-700 mb-4 text-sm">定期設定の追加</h3>

                    <div className="space-y-4">
                        <div className="flex bg-gray-100 p-1 rounded-lg">
                            <button
                                onClick={() => setNewItem({ ...newItem, type: 'Expense', category: '住居費' })}
                                className={clsx("flex-1 py-1.5 text-xs font-bold rounded-md transition-all", newItem.type === 'Expense' ? "bg-white text-gray-800 shadow-sm" : "text-gray-400")}
                            >
                                支出
                            </button>
                            <button
                                onClick={() => setNewItem({ ...newItem, type: 'Income', category: '給料' })}
                                className={clsx("flex-1 py-1.5 text-xs font-bold rounded-md transition-all", newItem.type === 'Income' ? "bg-emerald-500 text-white shadow-sm" : "text-gray-400")}
                            >
                                収入
                            </button>
                        </div>

                        <div className="flex gap-2">
                            <div className="flex-1">
                                <label className="text-[10px] text-gray-400 ml-1">日付</label>
                                <select
                                    value={newItem.day}
                                    onChange={(e) => setNewItem({ ...newItem, day: e.target.value })}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-sm outline-none"
                                >
                                    {days.map(d => <option key={d} value={d}>毎月 {d}日</option>)}
                                </select>
                            </div>
                            <div className="flex-[2]">
                                <label className="text-[10px] text-gray-400 ml-1">カテゴリ</label>
                                <select
                                    value={newItem.category}
                                    onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-sm outline-none"
                                >
                                    {(newItem.type === 'Income' ? categories.Income : categories.Expense).map((c: string) => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <input
                            type="text"
                            placeholder="名前 (例: 家賃)"
                            value={newItem.name}
                            onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm outline-none"
                        />

                        <input
                            type="number"
                            placeholder="金額"
                            value={newItem.amount}
                            onChange={(e) => setNewItem({ ...newItem, amount: e.target.value })}
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm outline-none font-bold"
                            inputMode="numeric"
                        />

                        <div className="flex gap-2 pt-2">
                            <button
                                onClick={() => setShowForm(false)}
                                className="flex-1 py-3 text-gray-400 font-bold text-xs"
                            >
                                キャンセル
                            </button>
                            <button
                                onClick={handleAdd}
                                disabled={isAdding}
                                className="flex-[2] bg-indigo-600 text-white font-bold py-3 rounded-xl shadow-md text-sm"
                            >
                                {isAdding ? '保存中...' : '設定を保存'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}

