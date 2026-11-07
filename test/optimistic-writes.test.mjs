import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => fs.readFileSync(join(__dirname, '..', path), 'utf8');

const modalSource = read('components/ExpenseDetailModal.tsx');
const manageSource = read('components/ManageView.tsx');
const queueSource = read('lib/write-queue.ts');

const body = (source, name) => {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} not found`);
  const next = source.indexOf('\n    const ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};

test('every modal edit applies locally and closes without waiting for GAS', () => {
  for (const name of ['handleUpdateDate', 'handleUpdateAmount', 'handleUpdateCategory', 'handleDelete']) {
    const fn = body(modalSource, name);
    assert.doesNotMatch(fn, /await fetch/, `${name} must not block on the network`);
    assert.match(fn, /onClose\(\)/, `${name} must close immediately`);
  }
  assert.match(body(modalSource, 'handleUpdateDate'), /onLocalUpdate\?\.\(expense, \{ date: newDate \}\)/);
  assert.match(body(modalSource, 'handleUpdateAmount'), /onLocalUpdate\?\.\(expense, \{ amount \}\)/);
});

test('modal writes go through the serial write queue and always reconcile', () => {
  const helper = body(modalSource, 'sendInBackground');
  assert.match(helper, /postWrite\(/);
  assert.match(helper, /finally\(\(\) => onUpdate\(\)\)/);
  assert.doesNotMatch(modalSource, /fetch\(/, 'the modal must not POST outside the queue');
  for (const name of ['handleUpdateDate', 'handleUpdateAmount', 'handleUpdateCategory', 'handleDelete']) {
    assert.match(body(modalSource, name), /sendInBackground\(/);
  }
});

test('manage view writes (manual entry, fixed cost add/delete) all use the write queue', () => {
  for (const name of ['handleSubmit', 'handleAdd', 'handleDelete']) {
    assert.match(body(manageSource, name), /postWrite\(/, `${name} must use postWrite`);
  }
  assert.doesNotMatch(manageSource, /method: 'POST'/, 'no POST may bypass the queue');
});

test('the queued POST uses keepalive and rejects on a GAS failure', () => {
  const fn = queueSource.slice(queueSource.indexOf('export function postWrite'));
  assert.match(fn, /keepalive: true/);
  assert.match(fn, /data\?\.success/);
  assert.match(fn, /enqueueWrite\(/);
});

test('manual entry clears the form immediately and never overwrites a newer input on failure', () => {
  const fn = body(manageSource, 'handleSubmit');
  assert.doesNotMatch(fn, /await fetch/);
  assert.match(fn, /setFormData\(prev => \(\{ \.\.\.prev, merchant: '', amount: '' \}\)\)/);
  // Restore only while mounted and only when the merchant/amount inputs are empty
  assert.match(fn, /mountedRef\.current/);
  assert.match(fn, /isEntryEmpty\(formRef\.current\)/);
  assert.match(fn, /setFormData\(submitted\)/);
  // A timeout is not a definite failure: never restore (a resend could duplicate)
  const timeoutAt = fn.indexOf('isWriteTimeout(e)');
  assert.ok(timeoutAt !== -1 && timeoutAt < fn.indexOf('setFormData(submitted)'), 'timeout is handled before the restore branch');
  assert.match(fn, /反映されている可能性があります。一覧で確認してください/);
  // Otherwise tell the user what failed instead of clobbering the form
  assert.match(fn, /toast\.error\(`追加に失敗しました: \$\{describe\}`\)/);
});

test('fixed cost delete sends the identifying fields so GAS can match the row', () => {
  const fn = body(manageSource, 'handleDelete');
  for (const field of ['id: item.id', 'type: item.type', 'name: item.name', 'amount: item.amount', 'day: item.day', 'category: item.category']) {
    assert.ok(fn.includes(field), `deleteFixedCost must send ${field}`);
  }
});

test('fixed cost writes check the GAS result instead of assuming success', () => {
  assert.doesNotMatch(manageSource, /alert\(/);
});

test('the modal reports a timeout as possibly applied, then reconciles', () => {
  const helper = body(modalSource, 'sendInBackground');
  assert.match(helper, /isWriteTimeout\(e\)/);
  assert.match(helper, /反映されている可能性があります/);
  assert.match(helper, /finally\(\(\) => onUpdate\(\)\)/);
});

test('fixed cost writes treat a timeout as possibly applied and refetch fresh data', () => {
  for (const name of ['handleAdd', 'handleDelete']) {
    assert.match(body(manageSource, name), /isWriteTimeout\(/, `${name} must handle timeouts`);
    assert.match(body(manageSource, name), /fetchFixedCosts\(true\)/, `${name} must refetch fresh`);
  }
  assert.match(manageSource, /params\.set\('fresh', '1'\)/);
});
