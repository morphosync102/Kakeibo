import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoriesForType } from '../lib/categories.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modalSource = fs.readFileSync(join(__dirname, '..', 'components/ExpenseDetailModal.tsx'), 'utf8');

test('expense categories include housing, infrastructure and travel', () => {
  for (const name of ['住居費', 'インフラ', '旅行']) {
    assert.ok(EXPENSE_CATEGORIES.includes(name), name);
  }
  assert.ok(!EXPENSE_CATEGORIES.includes('光熱費'));
});

test('income categories include reimbursement', () => {
  assert.ok(INCOME_CATEGORIES.includes('立て替え'));
});

test('category choices follow the transaction type', () => {
  assert.equal(categoriesForType('Income'), INCOME_CATEGORIES);
  assert.equal(categoriesForType('Expense'), EXPENSE_CATEGORIES);
  assert.equal(categoriesForType(undefined), EXPENSE_CATEGORIES);
});

test('expense detail modal offers income categories for income rows', () => {
  assert.match(modalSource, /categoriesForType\(expense\.type\)/);
});
