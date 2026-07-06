import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => fs.readFileSync(join(__dirname, '..', path), 'utf8');

const modalSource = read('components/ExpenseDetailModal.tsx');
const calendarSource = read('components/CalendarView.tsx');
const dashboardSource = read('components/Dashboard.tsx');

test('expense detail modal sends strict match fields when deleting', () => {
  assert.match(modalSource, /action: 'deleteTransaction'/);
  assert.match(modalSource, /date: expense\.date/);
  assert.match(modalSource, /merchant: expense\.merchant/);
  assert.match(modalSource, /amount: expense\.amount/);
});

test('expense detail modal confirms destructive actions without blocking dialogs', () => {
  assert.match(modalSource, /confirmingDelete/);
  assert.match(modalSource, /confirmingCategory/);
  assert.doesNotMatch(modalSource, /\balert\(/);
  assert.doesNotMatch(modalSource, /\bconfirm\(/);
});

test('calendar opens the shared expense detail modal instead of inline delete', () => {
  assert.match(calendarSource, /ExpenseDetailModal/);
  assert.match(calendarSource, /setSelectedExpense\(item\)/);
  assert.match(calendarSource, /onLocalRemove=\{removeLocal\}/);
  assert.doesNotMatch(calendarSource, /action: 'deleteTransaction'/);
  assert.doesNotMatch(calendarSource, /\bconfirm\(/);
});

test('dashboard wires optimistic mutations into the detail modal', () => {
  assert.match(dashboardSource, /onLocalRemove=\{removeLocal\}/);
  assert.match(dashboardSource, /onLocalUpdate=\{updateLocal\}/);
});
