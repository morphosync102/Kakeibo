import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GAS proxy authentication (IMPROVEMENTS 4-1). Secrets below are dummies.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');
const DUMMY_SECRET = 'dummy-proxy-secret-for-tests';
const DATA_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type'];

function loadGas({ secret } = {}) {
  const rows = [[...DATA_HEADER], ['2026/07/01', 'Store A', 1000, '食費', 'msg-1', 'ts', 'Expense']];
  const warnings = [];
  const digests = [];
  const sheet = {
    getDataRange: () => ({ getValues: () => rows.map(row => [...row]) }),
    getLastRow: () => rows.length,
    getRange: (row, column) => ({ setValue: (value) => { rows[row - 1][column - 1] = value; } }),
    appendRow: (row) => rows.push([...row]),
    deleteRow: (row) => rows.splice(row - 1, 1),
  };
  const sandbox = {
    console: { log: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: () => {} },
    CacheService: { getScriptCache: () => ({ get: () => null, getAll: () => ({}), put: () => {}, putAll: () => {}, removeAll: () => {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (body) => ({ body, setMimeType: () => ({ body }) }),
    },
    GmailApp: {},
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => ({ SHEET_ID: 'sheet-id', PROXY_SECRET: secret })[key],
      }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (name) => (name === 'Data' ? sheet : null) }), flush: () => {} },
    UrlFetchApp: {},
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      // Apps Script returns signed bytes
      computeDigest: (algorithm, value) => {
        digests.push(algorithm);
        return [...createHash('sha256').update(String(value), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b));
      },
      formatDate: (date) => `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  return { gas: sandbox, rows, warnings, digests };
}

const post = (gas, payload) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(payload) } }).body);
const get = (gas, parameter) => JSON.parse(gas.doGet({ parameter }).body);
const addPayload = { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' };

test('without PROXY_SECRET requests pass (migration period) and a warning is logged', () => {
  const { gas, rows, warnings } = loadGas();
  assert.equal(get(gas, {}).length, 1);
  assert.equal(post(gas, addPayload).success, true);
  assert.equal(rows.length, 3);
  assert.ok(warnings.some(w => /PROXY_SECRET/.test(w)));
  assert.ok(!warnings.some(w => w.includes(DUMMY_SECRET)));
});

test('with PROXY_SECRET the correct key passes for doGet (query) and doPost (body)', () => {
  const { gas, rows, digests } = loadGas({ secret: DUMMY_SECRET });
  assert.equal(get(gas, { key: DUMMY_SECRET }).length, 1);
  assert.equal(get(gas, { key: DUMMY_SECRET, action: 'getFixedCosts' }).length, 0);
  assert.equal(post(gas, { ...addPayload, key: DUMMY_SECRET }).success, true);
  assert.equal(rows.length, 3);
  assert.ok(digests.length >= 2, 'keys are compared as digests');
});

test('with PROXY_SECRET a wrong or missing key is Unauthorized and nothing is read or written', () => {
  for (const key of [undefined, '', 'wrong', DUMMY_SECRET + 'x', DUMMY_SECRET.slice(0, -1), 123, null, ['x']]) {
    const { gas, rows } = loadGas({ secret: DUMMY_SECRET });
    assert.deepEqual(post(gas, { ...addPayload, key }), { error: 'Unauthorized' }, `POST key ${JSON.stringify(key)}`);
    assert.equal(rows.length, 2);
    if (typeof key === 'string' || key === undefined) {
      assert.deepEqual(get(gas, key === undefined ? {} : { key }), { error: 'Unauthorized' }, `GET key ${JSON.stringify(key)}`);
    }
  }
  // Authentication runs before source validation (no information leak)
  const { gas } = loadGas({ secret: DUMMY_SECRET });
  assert.deepEqual(get(gas, { source: 'Yahoo' }), { error: 'Unauthorized' });
  assert.deepEqual(post(gas, { ...addPayload, source: 'Yahoo' }), { error: 'Unauthorized' });
});

test('LINE webhook payloads stay unauthenticated but can never read or write transactions', () => {
  const { gas, rows } = loadGas({ secret: DUMMY_SECRET });
  const webhook = { destination: 'synthetic-destination', events: [] };
  assert.deepEqual(post(gas, webhook), { success: true, ignored: 'lineWebhook' });
  // Even with write fields mixed in, the webhook branch only acknowledges
  for (const extra of [addPayload, { action: 'deleteTransaction', id: 'msg-1' }, { action: 'updateCategory', merchant: 'Store A', category: 'x' }]) {
    const result = post(gas, { ...webhook, ...extra });
    assert.deepEqual(result, { success: true, ignored: 'lineWebhook' });
  }
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['2026/07/01', 'Store A', 1000, '食費', 'msg-1', 'ts', 'Expense']);
});

test('time-driven functions are not affected by PROXY_SECRET', () => {
  const { gas } = loadGas({ secret: DUMMY_SECRET });
  assert.doesNotThrow(() => gas.processFixedCostsForSource());
});
