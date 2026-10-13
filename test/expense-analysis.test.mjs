import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateExpenses, aggregateCategories, categoryExpensesByYear, searchExpenses, expenseCategories } from '../lib/expense-analysis.ts';

const item = (date, amount, type = 'Expense', merchant = '架空 Shop', category = '') => ({ date, amount, type, merchant, category });
const data = [item('2024/12/31', 1000, 'Income'), item('2025/02/01', 400), item('2025/02/28', 100, undefined), item('2025/03/01', 20, 'Other')];

test('all periods cross years, fill gaps, count legacy expenses, accumulate deficits', () => {
    const result = aggregateExpenses(data, { mode: 'all' });
    assert.deepEqual(result.points.map(p => p.key), ['2024-12', '2025-01', '2025-02', '2025-03']);
    assert.deepEqual(result.points.map(p => p.cumulative), [1000, 1000, 500, 480]);
    assert.deepEqual(result.totals, { income: 1000, expense: 520, balance: 480 });
    assert.equal(result.points[1].expense, 0);
});
test('year contains twelve months and resets cumulative at period start', () => {
    const result = aggregateExpenses(data, { mode: 'year', year: 2025 });
    assert.equal(result.points.length, 12);
    assert.equal(result.points[0].cumulative, 0);
    assert.equal(result.points[11].cumulative, -520);
});
test('month uses every day, includes edges, leap year and excludes adjacent month', () => {
    const result = aggregateExpenses(data, { mode: 'month', month: '2025-02' });
    assert.equal(result.points.length, 28);
    assert.equal(result.points[0].balance, -400);
    assert.equal(result.points[27].cumulative, -500);
    assert.equal(aggregateExpenses([], { mode: 'month', month: '2024-02' }).points.length, 29);
});
test('empty and income-only/expense-only periods', () => {
    assert.deepEqual(aggregateExpenses([], { mode: 'all' }), { points: [], totals: { income: 0, expense: 0, balance: 0 } });
    assert.equal(aggregateExpenses([data[0]], { mode: 'all' }).totals.balance, 1000);
    assert.equal(aggregateExpenses([data[1]], { mode: 'all' }).totals.balance, -400);
    assert.equal(aggregateExpenses(data, { mode: 'year', year: 2020 }).totals.balance, 0);
});
test('invalid dates do not create buckets or hang aggregation', () => {
    assert.equal(aggregateExpenses([item('bad', 9), item('2025/02/31', 9)], { mode: 'all' }).points.length, 0);
    assert.equal(aggregateExpenses(data, { mode: 'month', month: '' }).points.length, 0);
});
test('search normalizes width, kana and case; combines every condition inclusively', () => {
    const rows = [item('2025/02/01', 400, 'Expense', 'ＡＢＣ ｶﾌｪ', '食費'), item('2025/02/02', 500, 'Income', 'ABC カフェ', '食費'), ...data];
    const result = searchExpenses(rows, { keyword: '  abc カフェ ', startDate: '2025-02-01', endDate: '2025-02-01', category: '食費', minAmount: '400', maxAmount: '400' });
    assert.equal(result.items.length, 1);
    assert.equal(result.total, 400);
    assert.deepEqual(result.errors, {});
});
test('unspecified conditions include all expenses descending; one-sided and unclassified filters', () => {
    assert.equal(searchExpenses(data, {}).items.length, 3);
    assert.equal(searchExpenses(data, {}).items[0].date, '2025/03/01');
    assert.equal(searchExpenses(data, { startDate: '2025-02-28' }).items.length, 2);
    assert.equal(searchExpenses(data, { endDate: '2025-02-01' }).items.length, 1);
    assert.equal(searchExpenses(data, { minAmount: '100' }).total, 500);
    assert.equal(searchExpenses(data, { maxAmount: '100', category: '未分類' }).total, 120);
    assert.deepEqual(expenseCategories([...data, item('2025/01/01', 9, 'Income', '架空', '給与')]), ['未分類']);
    assert.equal(searchExpenses(data, { keyword: '存在しない' }).items.length, 0);
});
test('invalid ranges/amounts suppress results; zero and decimals allowed', () => {
    for (const filters of [
        { startDate: '2025-02-02', endDate: '2025-02-01' }, { startDate: '2025-02-31' },
        { minAmount: '101', maxAmount: '100' }, { minAmount: '-1' }, { maxAmount: 'abc' },
        { minAmount: 'Infinity' }, { maxAmount: ' ' }, { minAmount: '0x10' },
    ]) {
        const result = searchExpenses(data, filters);
        assert.ok(Object.keys(result.errors).length);
        assert.deepEqual(result.items, []);
        assert.equal(result.total, 0);
    }
    assert.equal(searchExpenses([item('2025/02/01', 0.5)], { minAmount: '0', maxAmount: '0.5' }).total, 0.5);
});
test('updated and deleted inputs are re-evaluated without mutating original data', () => {
    const filters = { minAmount: '300' };
    assert.equal(searchExpenses(data, filters).items.length, 1);
    assert.equal(searchExpenses(data.map(x => ({ ...x, amount: 10 })), filters).items.length, 0);
    assert.equal(searchExpenses(data.filter(x => x !== data[1]), filters).total, 0);
    assert.equal(data[0].date, '2024/12/31');
});
test('category totals follow the period, exclude income and group blank as 未分類', () => {
    const rows = [item('2024/05/01', 300, 'Expense', 'a', '食費'), item('2025/01/10', 200, 'Expense', 'b', '食費'),
        item('2025/02/01', 600, 'Expense', 'c', '交通費'), item('2025/03/01', 200), item('2025/03/02', 9999, 'Income', 'd', '給料'), item('bad', 5)];
    assert.deepEqual(aggregateCategories(rows, { mode: 'year', year: 2025 }).map(r => [r.category, r.amount, r.share]),
        [['交通費', 600, 0.6], ['未分類', 200, 0.2], ['食費', 200, 0.2]]);
    assert.deepEqual(aggregateCategories(rows, { mode: 'month', month: '2025-01' }).map(r => r.amount), [200]);
    assert.equal(aggregateCategories(rows, { mode: 'all' })[0].category, '交通費');
    assert.deepEqual(aggregateCategories([], { mode: 'all' }), []);
    const yearly = categoryExpensesByYear(rows);
    assert.deepEqual(yearly.years, [2025, 2024]);
    assert.deepEqual(yearly.rows.map(r => [r.category, r.amounts, r.total]), [['交通費', [600, 0], 600], ['食費', [200, 300], 500], ['未分類', [200, 0], 200]]);
    assert.deepEqual(yearly.yearTotals, [1000, 300]);
});
