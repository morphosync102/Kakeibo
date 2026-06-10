import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modalSource = fs.readFileSync(join(__dirname, '../components/ExpenseDetailModal.tsx'), 'utf8');

test('expense detail modal provides a separate transaction date save action', () => {
  assert.match(modalSource, /type="date"/);
  assert.match(modalSource, /action: 'updateTransactionDate'/);
  assert.match(modalSource, /currentDate: expense\.date/);
  assert.match(modalSource, /merchant: expense\.merchant/);
  assert.match(modalSource, /amount: expense\.amount/);
  assert.match(modalSource, /日付を保存/);
  assert.match(modalSource, /カテゴリ設定を保存/);
});
