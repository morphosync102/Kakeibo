import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Unique row id column (Data / Yahoo_Data column H: RowId). Synthetic data only.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');

const DATA_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type'];
const DATA_HEADER_WITH_ID = [...DATA_HEADER, 'RowId'];
const FIXED_HEADER = ['Type', 'Name', 'Amount', 'Day', 'Category'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Fixed RowIds for fixtures (synthetic)
const ROW_1 = '00000000-0000-4000-8000-000000000001';
const ROW_2 = '00000000-0000-4000-8000-000000000002';
const ROW_A = '00000000-0000-4000-8000-00000000000a';
const EXISTING_B = '00000000-0000-4000-8000-00000000000b';
const UNKNOWN = '00000000-0000-4000-8000-0000000000ff';

function createSheet(name, rows, events, maxColumns = 26) {
  const sheet = {
    rows,
    maxColumns,
    getDataRange: () => {
      const width = Math.max(...rows.map(r => r.length));
      return { getValues: () => rows.map(row => Array.from({ length: width }, (_, i) => (row[i] === undefined ? '' : row[i]))) };
    },
    getLastRow: () => rows.length,
    getMaxColumns: () => sheet.maxColumns,
    insertColumnsAfter: (after, count) => { events.push(`insertColumns:${name}:${after}:${count}`); sheet.maxColumns += count; },
    getRange: (row, column, numRows = 1, numColumns = 1) => {
      if (column + numColumns - 1 > sheet.maxColumns) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      return {
        getValues: () => rows.slice(row - 1, row - 1 + numRows)
          .map(r => Array.from({ length: numColumns }, (_, i) => (r[column - 1 + i] === undefined ? '' : r[column - 1 + i]))),
        setValue: (value) => {
          events.push(`write:${name}`);
          rows[row - 1][column - 1] = value;
        },
        setValues: (values) => {
          events.push(`write:${name}`);
          values.forEach((value, offset) => {
            const target = rows[row - 1 + offset] || (rows[row - 1 + offset] = []);
            value.forEach((cell, i) => { target[column - 1 + i] = cell; });
          });
        },
      };
    },
    appendRow: (row) => {
      events.push(`write:${name}`);
      if (row.length > sheet.maxColumns) sheet.maxColumns = row.length; // appendRow grows the sheet
      rows.push([...row]);
    },
    deleteRow: (row) => {
      events.push(`write:${name}`);
      rows.splice(row - 1, 1);
    },
  };
  return sheet;
}

function loadGas({ sheets = {}, gmail, maxColumns = {}, lockAvailable = true } = {}) {
  const events = [];
  const sheetObjects = {};
  for (const [name, rows] of Object.entries(sheets)) sheetObjects[name] = createSheet(name, rows, events, maxColumns[name]);
  const store = new Map();
  let uuidCount = 0;
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (store.has(key) ? store.get(key) : null),
        getAll: (keys) => Object.fromEntries(keys.filter(k => store.has(k)).map(k => [k, store.get(k)])),
        put: (key, value) => { events.push(`cache:put:${key}`); store.set(key, String(value)); },
        putAll: (values) => Object.entries(values).forEach(([k, v]) => store.set(k, String(v))),
        removeAll: (keys) => keys.forEach(k => store.delete(k)),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { events.push('lock:try'); if (lockAvailable) events.push('lock:acquired'); return lockAvailable; },
        releaseLock: () => events.push('lock:released'),
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (body) => ({ body, setMimeType: () => ({ body }) }),
    },
    GmailApp: gmail || { search: () => [], getMessagesForThreads: () => [] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => (key === 'SHEET_ID' ? 'sheet-id' : undefined) }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (name) => sheetObjects[name] || null }), flush: () => {} },
    UrlFetchApp: {},
    Utilities: {
      getUuid: () => { uuidCount += 1; return randomUUID(); },
      formatDate: (date) => `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  return { gas: sandbox, events, sheets: sheetObjects, store, uuidCount: () => uuidCount };
}

const post = (gas, payload) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(payload) } }).body);
const get = (gas, parameter = {}) => JSON.parse(gas.doGet({ parameter }).body);

function message(id, subject, body) {
  return { getId: () => id, getSubject: () => subject, getPlainBody: () => body };
}
const gmailWith = (messages) => ({ search: () => [{}], getMessagesForThreads: () => [messages] });
const RAKUTEN = message('rakuten-1', 'カード利用のお知らせ', '2026/07/03 TEST SHOP R 1,234円\n');
const OLIVE = message('olive-1', 'ご利用のお知らせ', '◇利用日：2026/07/03 12:00\n◇利用先：TEST SHOP O\n◇利用金額：2,345円\n');
const JCB = message('jcb-1', 'JCBカード／ショッピングご利用のお知らせ', '【ご利用日時(日本時間)】 2026/07/03 12:00\n【ご利用金額】 3,456円\n【ご利用先】 TEST SHOP J\n');

const allSheets = () => ({
  Data: [[...DATA_HEADER_WITH_ID]],
  Config: [['支払い先', '分類']],
  Fixed: [[...FIXED_HEADER], ['Expense', 'Daily main', 100, new Date().getDate(), '固定費']],
  Yahoo_Data: [[...DATA_HEADER_WITH_ID]],
  Yahoo_Config: [['支払い先', '分類']],
  Yahoo_Fixed: [[...FIXED_HEADER], ['Expense', 'Daily yahoo', 200, new Date().getDate(), '固定費']],
});

// ---------------------------------------------------------------- numbering on every write path

test('every path that appends to Data / Yahoo_Data writes a unique RowId into column H', () => {
  const { gas, sheets } = loadGas({ sheets: allSheets(), gmail: gmailWith([RAKUTEN, OLIVE, JCB]) });

  assert.equal(post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'Manual main', amount: 10, category: '食費' }).success, true);
  assert.equal(post(gas, { action: 'addTransaction', source: 'yahoo', date: '2026/07/05', merchant: 'Manual yahoo', amount: 20, category: '食費' }).success, true);
  gas.processFixedCostsForSource('main');
  gas.processFixedCostsForSource('yahoo');
  gas.extractRakutenEmails();
  gas.extractOliveEmails();
  gas.extractJcbEmails();

  const merchants = (rows) => rows.slice(1).map(r => r[1]).sort();
  assert.deepEqual(merchants(sheets.Data.rows), ['Daily main', 'Manual main', 'TEST SHOP R']);
  assert.deepEqual(merchants(sheets.Yahoo_Data.rows), ['Daily yahoo', 'Manual yahoo', 'TEST SHOP J', 'TEST SHOP O']);

  const ids = [];
  for (const sheet of [sheets.Data, sheets.Yahoo_Data]) {
    assert.deepEqual(sheet.rows[0], DATA_HEADER_WITH_ID, 'header untouched');
    for (const row of sheet.rows.slice(1)) {
      assert.equal(row.length, 8, `row ${row[1]} has 8 columns`);
      assert.match(String(row[7]), UUID, `row ${row[1]} has a RowId value`);
      assert.ok(row[6] === 'Expense' || row[6] === 'Income', 'Type stays in column G');
      ids.push(row[7]);
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'RowIds are unique');
});

test('a sheet narrower than 8 columns is widened before RowId is written', () => {
  const { gas, sheets, events } = loadGas({ sheets: { ...allSheets(), Yahoo_Data: [[...DATA_HEADER]] }, maxColumns: { Yahoo_Data: 7 }, gmail: gmailWith([JCB]) });
  gas.extractJcbEmails();
  assert.ok(events.some(e => e.startsWith('insertColumns:Yahoo_Data:7:1')));
  assert.match(String(sheets.Yahoo_Data.rows[1][7]), UUID);
});

// ---------------------------------------------------------------- doGet

test('doGet returns rowId when column H has a value and keeps id = MessageId', () => {
  const { gas } = loadGas({
    sheets: { Data: [[...DATA_HEADER_WITH_ID], ['2026/07/01', 'A', 1, '食費', 'msg-1', 'ts', 'Expense', ROW_A], ['2026/07/02', 'B', 2, '食費', 'msg-1', 'ts', 'Expense']] },
  });
  const list = get(gas);
  assert.equal(list[0].id, 'msg-1');
  assert.equal(list[0].rowId, ROW_A);
  assert.equal(list[1].id, 'msg-1');
  assert.equal('rowId' in list[1], false, 'empty RowId is omitted');
});

// ---------------------------------------------------------------- backfill

test('backfillRowIds fills only empty cells, writes the header, is idempotent and keeps sources apart', () => {
  const data = [
    [...DATA_HEADER],
    ['2026/07/01', 'A', 1, '食費', 'msg-1', 'ts', 'Expense'],
    ['2026/07/02', 'B', 2, '食費', 'msg-1', 'ts', 'Expense', EXISTING_B],
    ['2026/07/03', 'C', 3, '食費', 'msg-2', 'ts', 'Expense', ''],
  ];
  const yahoo = [[...DATA_HEADER_WITH_ID], ['2026/07/04', 'Y', 4, '食費', 'y-1', 'ts', 'Expense']];
  const { gas, sheets, events, store } = loadGas({ sheets: { Data: data, Yahoo_Data: yahoo } });
  store.set('kakeibo_main_gen', 'g-main');
  store.set('kakeibo_yahoo_gen', 'g-yahoo');

  const first = gas.backfillRowIds();
  assert.equal(first.main, 2);
  assert.equal(first.yahoo, 1);
  assert.equal(sheets.Data.rows[0][7], 'RowId');
  assert.match(String(sheets.Data.rows[1][7]), UUID);
  assert.equal(sheets.Data.rows[2][7], EXISTING_B, 'an existing RowId is never overwritten');
  assert.match(String(sheets.Data.rows[3][7]), UUID);
  assert.match(String(sheets.Yahoo_Data.rows[1][7]), UUID);
  assert.deepEqual(sheets.Data.rows.map(r => r.slice(0, 7)), data.map(r => r.slice(0, 7)), 'columns A-G untouched');
  assert.notEqual(store.get('kakeibo_main_gen'), 'g-main', 'main cache invalidated');
  assert.notEqual(store.get('kakeibo_yahoo_gen'), 'g-yahoo', 'yahoo cache invalidated');
  const writes = events.filter(e => e.startsWith('write:'));
  assert.ok(writes.every(e => events.indexOf(e) > events.indexOf('lock:acquired')), 'written under the lock');
  assert.equal(writes.filter(e => e === 'write:Data').length, 1, 'one batched setValues per sheet');

  const snapshot = JSON.stringify([sheets.Data.rows, sheets.Yahoo_Data.rows]);
  const second = gas.backfillRowIds();
  assert.equal(second.main, 0);
  assert.equal(second.yahoo, 0);
  assert.equal(JSON.stringify([sheets.Data.rows, sheets.Yahoo_Data.rows]), snapshot, 'idempotent');
});

test('backfillRowIds widens a sheet that has no column H yet', () => {
  const { gas, sheets, events } = loadGas({ sheets: { Data: [[...DATA_HEADER], ['2026/07/01', 'A', 1, '食費', 'm', 'ts', 'Expense']] }, maxColumns: { Data: 7 } });
  assert.equal(gas.backfillRowIds().main, 1);
  assert.ok(events.some(e => e.startsWith('insertColumns:Data:7:1')));
  assert.equal(sheets.Data.rows[0][7], 'RowId');
  assert.match(sheets.Data.rows[1][7], UUID);
});

test('backfillRowIds refuses to run without the lock', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: [[...DATA_HEADER], ['2026/07/01', 'A', 1, '食費', 'm', 'ts', 'Expense']] }, lockAvailable: false });
  assert.throws(() => gas.backfillRowIds(), /lock/i);
  assert.equal(sheets.Data.rows[1][7], undefined);
});

// ---------------------------------------------------------------- update / delete by rowId

const twins = () => [
  [...DATA_HEADER_WITH_ID],
  ['2026/07/01', 'Same', 500, '食費', 'shared', 'ts', 'Expense', ROW_1],
  ['2026/07/01', 'Same', 500, '食費', 'shared', 'ts', 'Expense', ROW_2],
  ['2026/07/02', 'Legacy', 700, '食費', 'legacy-msg', 'ts', 'Expense', ''],
];

test('identical rows sharing a MessageId are told apart by rowId on delete', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: twins() } });
  const result = post(gas, { action: 'deleteTransaction', id: 'shared', date: '2026/07/01', merchant: 'Same', amount: 500, rowId: ROW_2 });
  assert.equal(result.success, true);
  assert.deepEqual(sheets.Data.rows.map(r => r[7]), ['RowId', ROW_1, '']);
});

test('updateTransaction and updateTransactionDate use rowId and still verify the content', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: twins() } });
  assert.equal(post(gas, {
    action: 'updateTransaction', id: 'shared', currentDate: '2026/07/01', currentMerchant: 'Same', currentAmount: 500, amount: 900, rowId: ROW_2,
  }).success, true);
  assert.equal(sheets.Data.rows[1][2], 500, 'the twin is untouched');
  assert.equal(sheets.Data.rows[2][2], 900);

  assert.equal(post(gas, {
    action: 'updateTransactionDate', id: 'shared', currentDate: '2026/07/01', merchant: 'Same', amount: 900, date: '2026/07/09', rowId: ROW_2,
  }).success, true);
  assert.equal(sheets.Data.rows[2][0], '2026/07/09');
  assert.equal(sheets.Data.rows[1][0], '2026/07/01');
});

test('a rowId match with different content is not found (no fallback to another row)', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: twins() } });
  const before = JSON.stringify(sheets.Data.rows);
  // row-2 exists but its amount is 500, not 700; the Legacy row would match the content
  for (const payload of [
    { action: 'deleteTransaction', id: 'shared', date: '2026/07/01', merchant: 'Same', amount: 999, rowId: ROW_2 },
    { action: 'deleteTransaction', id: 'legacy-msg', date: '2026/07/02', merchant: 'Legacy', amount: 700, rowId: ROW_2 },
    { action: 'updateTransaction', id: 'shared', currentDate: '2026/07/01', currentMerchant: 'Other', currentAmount: 500, amount: 1, rowId: ROW_1 },
    { action: 'updateTransactionDate', id: 'shared', currentDate: '2026/07/05', merchant: 'Same', amount: 500, date: '2026/07/09', rowId: ROW_1 },
  ]) {
    assert.deepEqual(post(gas, payload), { error: 'Transaction not found' }, JSON.stringify(payload));
  }
  assert.equal(JSON.stringify(sheets.Data.rows), before);
});

test('without rowId (old clients) the strict content match is used as before', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: twins() } });
  assert.equal(post(gas, { action: 'deleteTransaction', id: 'shared', date: '2026/07/01', merchant: 'Same', amount: 500 }).success, true);
  assert.deepEqual(sheets.Data.rows.map(r => r[7]), ['RowId', ROW_2, ''], 'first strict match, as before');
  assert.equal(post(gas, { action: 'deleteTransaction', id: 'legacy-msg' }).success, true, 'id-only legacy delete still works');
  assert.equal(sheets.Data.rows.length, 2);
});

test('an unknown rowId falls back to the strict match among rows without a RowId only', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: twins() } });
  // The Legacy row has no RowId yet (not backfilled): reachable
  assert.equal(post(gas, {
    action: 'updateTransaction', id: 'legacy-msg', currentDate: '2026/07/02', currentMerchant: 'Legacy', currentAmount: 700, amount: 701, rowId: UNKNOWN,
  }).success, true);
  assert.equal(sheets.Data.rows[3][2], 701);
  // Rows that already have a different RowId are never picked by the fallback
  assert.deepEqual(post(gas, { action: 'deleteTransaction', id: 'shared', date: '2026/07/01', merchant: 'Same', amount: 500, rowId: UNKNOWN }), { error: 'Transaction not found' });
  assert.equal(sheets.Data.rows.length, 4);
});

test('a non-string rowId is rejected', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: twins() } });
  for (const rowId of [1, {}, [ROW_1], true]) {
    assert.deepEqual(post(gas, { action: 'deleteTransaction', id: 'shared', date: '2026/07/01', merchant: 'Same', amount: 500, rowId }), { error: 'Invalid rowId' });
  }
  assert.equal(sheets.Data.rows.length, 4);
});

// ---------------------------------------------------------------- non-UUID values in column H

const withManualH = () => [
  [...DATA_HEADER, 'メモ'],
  ['2026/07/01', 'Memo row', 500, '食費', 'msg-m', 'ts', 'Expense', '立替'],
  ['2026/07/02', 'Id row', 600, '食費', 'msg-i', 'ts', 'Expense', ROW_1],
];

test('a non-UUID value in column H is not a RowId: not returned, and the row is reachable by the strict match', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: withManualH() } });
  const list = get(gas);
  assert.equal('rowId' in list[0], false, 'a manual memo is never exposed as rowId');
  assert.equal(list[1].rowId, ROW_1);

  // Old client (no rowId) and new client with an unknown rowId both reach the memo row
  assert.equal(post(gas, { action: 'updateTransaction', id: 'msg-m', currentDate: '2026/07/01', currentMerchant: 'Memo row', currentAmount: 500, amount: 550 }).success, true);
  assert.equal(post(gas, { action: 'updateTransactionDate', id: 'msg-m', currentDate: '2026/07/01', merchant: 'Memo row', amount: 550, date: '2026/07/03', rowId: UNKNOWN }).success, true);
  assert.equal(sheets.Data.rows[1][7], '立替', 'the manual value is left alone');
  assert.equal(post(gas, { action: 'deleteTransaction', id: 'msg-m', date: '2026/07/03', merchant: 'Memo row', amount: 550, rowId: UNKNOWN }).success, true);
  assert.deepEqual(sheets.Data.rows.map(r => r[1]), ['Merchant', 'Id row']);
});

test('a request rowId that is not a UUID is rejected', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: withManualH() } });
  for (const rowId of ['立替', 'row-1', ROW_1 + 'x', ROW_1.replace(/-/g, '')]) {
    assert.deepEqual(post(gas, { action: 'deleteTransaction', id: 'msg-m', date: '2026/07/01', merchant: 'Memo row', amount: 500, rowId }), { error: 'Invalid rowId' }, rowId);
  }
  assert.equal(sheets.Data.rows.length, 3);
});

test('backfillRowIds aborts without writing anything when column H is already used', () => {
  const clean = () => [[...DATA_HEADER], ['2026/07/01', 'A', 1, '食費', 'm', 'ts', 'Expense']];
  const cases = [
    { label: 'H1 has another heading', data: [[...DATA_HEADER, 'メモ'], ['2026/07/01', 'A', 1, '食費', 'm', 'ts', 'Expense']], yahoo: clean(), sheet: 'Data' },
    { label: 'non-UUID values below the header', data: withManualH().map((r, i) => (i === 0 ? [...DATA_HEADER, 'RowId'] : r)), yahoo: clean(), sheet: 'Data' },
    { label: 'only the yahoo sheet has a problem', data: clean(), yahoo: [[...DATA_HEADER, 'RowId'], ['2026/07/04', 'Y', 4, '食費', 'y', 'ts', 'Expense', '済'], ['2026/07/05', 'Z', 5, '食費', 'z', 'ts', 'Expense', 'メモ']], sheet: 'Yahoo_Data' },
  ];
  for (const { label, data, yahoo, sheet } of cases) {
    const { gas, sheets, events, uuidCount } = loadGas({ sheets: { Data: data, Yahoo_Data: yahoo } });
    const before = JSON.stringify([sheets.Data.rows, sheets.Yahoo_Data.rows]);
    const error = (() => { try { gas.backfillRowIds(); return null; } catch (e) { return e; } })();
    assert.ok(error, `${label}: must abort`);
    assert.match(error.message, new RegExp(sheet), `${label}: names the sheet`);
    assert.match(error.message, /\d/, `${label}: reports a count`);
    for (const secret of ['立替', 'メモ', '済']) assert.ok(!error.message.includes(secret), `${label}: cell values are not echoed`);
    assert.equal(JSON.stringify([sheets.Data.rows, sheets.Yahoo_Data.rows]), before, `${label}: nothing written in either sheet`);
    assert.ok(!events.some(e => e.startsWith('write:') || e.startsWith('insertColumns:')), `${label}: no writes`);
    assert.equal(uuidCount(), 0);
    assert.ok(events.includes('lock:released'));
  }
});

test('backfillRowIds accepts an H1 of "RowId" and existing UUIDs', () => {
  const { gas, sheets } = loadGas({ sheets: { Data: [[...DATA_HEADER_WITH_ID], ['2026/07/01', 'A', 1, '食費', 'm', 'ts', 'Expense', ROW_1], ['2026/07/02', 'B', 2, '食費', 'n', 'ts', 'Expense', '']] } });
  assert.equal(gas.backfillRowIds().main, 1);
  assert.equal(sheets.Data.rows[1][7], ROW_1);
  assert.match(sheets.Data.rows[2][7], UUID);
});
