import assert from 'node:assert/strict';
import test from 'node:test';
import { isSameExpense } from '../lib/expense-identity.ts';

const row = (overrides = {}) => ({ id: 'shared', date: '2026/07/01', merchant: 'Same', amount: 500, category: '食費', ...overrides });

test('rows with rowIds are compared by rowId only', () => {
  assert.equal(isSameExpense(row({ rowId: 'r1' }), row({ rowId: 'r1', amount: 900 })), true, 'same row after an optimistic edit');
  assert.equal(isSameExpense(row({ rowId: 'r1' }), row({ rowId: 'r2' })), false, 'identical twins stay distinct');
});

test('without rowIds on both sides the old content comparison is used', () => {
  assert.equal(isSameExpense(row(), row()), true);
  assert.equal(isSameExpense(row(), row({ amount: 501 })), false);
  assert.equal(isSameExpense(row(), row({ date: '2026/07/02' })), false);
  assert.equal(isSameExpense(row(), row({ merchant: 'X' })), false);
  assert.equal(isSameExpense(row(), row({ id: 'other' })), false);
  // Old localStorage cache (no rowId) against a fresh list (rowId)
  assert.equal(isSameExpense(row(), row({ rowId: 'r1' })), true);
  assert.equal(isSameExpense(row({ rowId: '' }), row({ rowId: '' })), true, 'empty rowIds fall back too');
});
