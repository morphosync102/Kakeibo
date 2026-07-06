import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadGasWithRows(rows) {
  const source = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');
  const sheet = {
    getDataRange: () => ({ getValues: () => rows }),
    getRange: (row, column) => ({
      setValue: (value) => {
        rows[row - 1][column - 1] = value;
      },
    }),
    deleteRow: (row) => {
      rows.splice(row - 1, 1);
    },
  };
  const sandbox = {
    console,
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, removeAll: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (body) => ({ body, setMimeType: () => ({ body }) }),
    },
    GmailApp: {},
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => key === 'SHEET_ID' ? 'sheet-id' : undefined,
      }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: () => sheet,
      }),
    },
    UrlFetchApp: {},
    Utilities: {
      formatDate: (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}/${month}/${day}`;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

const header = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type'];

function sharedIdRows() {
  return [
    [...header],
    ['2026/07/01', 'Store A', 1000, '食費', 'shared-message-id', 'ts', 'Expense'],
    ['2026/07/02', 'Store B', 2500, 'カフェ', 'shared-message-id', 'ts', 'Expense'],
    ['2026/07/03', 'Store C', 800, '日用品', 'unique-id', 'ts', 'Expense'],
  ];
}

function post(gas, payload) {
  const response = gas.doPost({ postData: { contents: JSON.stringify(payload) } });
  return JSON.parse(response.body);
}

test('updateTransaction updates only the exact matching row among shared MessageIds', () => {
  const rows = sharedIdRows();
  const gas = loadGasWithRows(rows);
  const result = post(gas, {
    action: 'updateTransaction',
    source: 'main',
    id: 'shared-message-id',
    currentDate: '2026/07/02',
    currentMerchant: 'Store B',
    currentAmount: 2500,
    amount: 3000,
    category: '交際費',
  });

  assert.equal(result.success, true);
  assert.deepEqual(rows[1], ['2026/07/01', 'Store A', 1000, '食費', 'shared-message-id', 'ts', 'Expense']);
  assert.equal(rows[2][2], 3000);
  assert.equal(rows[2][3], '交際費');
  assert.equal(rows[2][1], 'Store B');
});

test('updateTransaction can update the merchant name', () => {
  const rows = sharedIdRows();
  const gas = loadGasWithRows(rows);
  const result = post(gas, {
    action: 'updateTransaction',
    source: 'main',
    id: 'unique-id',
    currentDate: '2026/07/03',
    currentMerchant: 'Store C',
    currentAmount: 800,
    merchant: 'Store C 支店',
  });

  assert.equal(result.success, true);
  assert.equal(rows[3][1], 'Store C 支店');
});

test('updateTransaction rejects an invalid amount', () => {
  const gas = loadGasWithRows(sharedIdRows());
  const result = post(gas, {
    action: 'updateTransaction',
    source: 'main',
    id: 'unique-id',
    currentDate: '2026/07/03',
    currentMerchant: 'Store C',
    currentAmount: 800,
    amount: 0,
  });

  assert.equal(result.error, 'Invalid amount');
});

test('updateTransaction requires at least one field to update', () => {
  const gas = loadGasWithRows(sharedIdRows());
  const result = post(gas, {
    action: 'updateTransaction',
    source: 'main',
    id: 'unique-id',
    currentDate: '2026/07/03',
    currentMerchant: 'Store C',
    currentAmount: 800,
  });

  assert.equal(result.error, 'No fields to update');
});

test('updateTransaction reports when no row matches strictly', () => {
  const rows = sharedIdRows();
  const gas = loadGasWithRows(rows);
  const result = post(gas, {
    action: 'updateTransaction',
    source: 'main',
    id: 'shared-message-id',
    currentDate: '2026/07/02',
    currentMerchant: 'Store B',
    currentAmount: 9999,
    amount: 3000,
  });

  assert.equal(result.error, 'Transaction not found');
  assert.equal(rows[2][2], 2500);
});

test('deleteTransaction deletes only the strictly matching row when fields are provided', () => {
  const rows = sharedIdRows();
  const gas = loadGasWithRows(rows);
  const result = post(gas, {
    action: 'deleteTransaction',
    source: 'main',
    id: 'shared-message-id',
    date: '2026/07/02',
    merchant: 'Store B',
    amount: 2500,
  });

  assert.equal(result.success, true);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'Store A'); // first shared row remains
  assert.equal(rows[2][1], 'Store C');
});

test('deleteTransaction keeps legacy first-match behavior when only id is provided', () => {
  const rows = sharedIdRows();
  const gas = loadGasWithRows(rows);
  const result = post(gas, {
    action: 'deleteTransaction',
    source: 'main',
    id: 'shared-message-id',
  });

  assert.equal(result.success, true);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'Store B'); // legacy: first match (Store A) removed
});

test('deleteTransaction reports when strict fields do not match any row', () => {
  const rows = sharedIdRows();
  const gas = loadGasWithRows(rows);
  const result = post(gas, {
    action: 'deleteTransaction',
    source: 'main',
    id: 'shared-message-id',
    date: '2026/07/02',
    merchant: 'Store B',
    amount: 1,
  });

  assert.equal(result.error, 'Transaction not found');
  assert.equal(rows.length, 4);
});
