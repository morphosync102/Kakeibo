import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadGasWithRows(rows) {
  const source = fs.readFileSync(join(__dirname, '../public/GAS.txt'), 'utf8');
  const sheet = {
    getDataRange: () => ({ getValues: () => rows }),
    getRange: (row, column) => ({
      setValue: (value) => {
        rows[row - 1][column - 1] = value;
      },
    }),
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

function updateDate(gas, overrides = {}) {
  const response = gas.doPost({
    postData: {
      contents: JSON.stringify({
        action: 'updateTransactionDate',
        source: 'main',
        id: 'shared-message-id',
        currentDate: '2026/06/01',
        merchant: 'Target Store',
        amount: 1200,
        date: '2026/06/03',
        ...overrides,
      }),
    },
  });
  return JSON.parse(response.body);
}

test('updateTransactionDate updates only the exact matching transaction', () => {
  const rows = [
    ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type'],
    ['2026/06/01', 'Target Store', 1200, '食費', 'shared-message-id', new Date(), 'Expense'],
    ['2026/06/01', 'Other Store', 800, '日用品', 'shared-message-id', new Date(), 'Expense'],
  ];
  const gas = loadGasWithRows(rows);

  assert.deepEqual(updateDate(gas), {
    success: true,
    message: 'Updated transaction date',
  });
  assert.equal(rows[1][0], '2026/06/03');
  assert.equal(rows[2][0], '2026/06/01');
});

test('updateTransactionDate rejects invalid calendar dates', () => {
  const rows = [
    ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type'],
    ['2026/06/01', 'Target Store', 1200, '食費', 'shared-message-id', new Date(), 'Expense'],
  ];
  const gas = loadGasWithRows(rows);

  const result = updateDate(gas, { date: '2026/02/31' });

  assert.equal(result.error, 'Invalid transaction date');
  assert.equal(rows[1][0], '2026/06/01');
});

test('updateTransactionDate reports when the exact transaction is not found', () => {
  const rows = [
    ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type'],
    ['2026/06/01', 'Target Store', 1200, '食費', 'different-id', new Date(), 'Expense'],
  ];
  const gas = loadGasWithRows(rows);

  const result = updateDate(gas);

  assert.equal(result.error, 'Transaction not found');
  assert.equal(rows[1][0], '2026/06/01');
});
