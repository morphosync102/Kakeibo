export const EXPENSE_CATEGORIES = [
    '未分類', '食費', 'カフェ', '交通費', '音ゲー', 'ダーツ', '日用品', '交際費',
    '医療費', '住居費', 'インフラ', '旅行', 'その他', '固定費', '身だしなみ'
];

export const INCOME_CATEGORIES = ['給料', '臨時収入', '賞与', '立て替え', 'その他'];

export const categoriesForType = (type?: string) =>
    type === 'Income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
