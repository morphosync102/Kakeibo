import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression tests for GAS write safety (IMPROVEMENTS 4-2, 4-4, 4-5, 4-6).
// All data below is synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');

const DATA_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type'];
const FIXED_HEADER = ['Type', 'Name', 'Amount', 'Day', 'Category'];
const CACHE_VALUE_LIMIT = 100 * 1024; // bytes, as in Apps Script CacheService

function createSheet(name, rows, events) {
  return {
    rows,
    getDataRange: () => {
      events.push(`read:${name}`);
      return { getValues: () => rows.map(row => [...row]) };
    },
    getLastRow: () => rows.length,
    getMaxColumns: () => 26,
    insertColumnsAfter: () => {},
    getRange: (row, column, numRows = 1, numColumns = 1) => ({
      getValues: () => {
        events.push(`read:${name}`);
        return rows.slice(row - 1, row - 1 + numRows).map(r => r.slice(column - 1, column - 1 + numColumns));
      },
      setValue: (value) => {
        events.push(`write:${name}`);
        rows[row - 1][column - 1] = value;
      },
      setValues: (values) => {
        events.push(`write:${name}`);
        values.forEach((value, offset) => { rows[row - 1 + offset] = [...value]; });
      },
    }),
    appendRow: (row) => {
      events.push(`write:${name}`);
      rows.push([...row]);
    },
    deleteRow: (row) => {
      events.push(`write:${name}`);
      if (row < 1 || row > rows.length) throw new Error('Row out of range');
      rows.splice(row - 1, 1);
    },
  };
}

function createCache(events) {
  const store = new Map();
  const assertSize = (value) => {
    if (Buffer.byteLength(String(value), 'utf8') > CACHE_VALUE_LIMIT) throw new Error('Argument too large: value');
  };
  return {
    store,
    failPutAll: false,
    failGenPut: false,
    failRemoveAll: false,
    get(key) { return store.has(key) ? store.get(key) : null; },
    getAll(keys) {
      const out = {};
      keys.forEach(key => { if (store.has(key)) out[key] = store.get(key); });
      return out;
    },
    put(key, value) {
      if (this.failGenPut && key.endsWith('_gen')) throw new Error('Cache put failure');
      assertSize(value);
      events.push(`cache:put:${key}`);
      store.set(key, String(value));
    },
    putAll(values) {
      if (this.failPutAll) throw new Error('Cache service failure');
      Object.values(values).forEach(assertSize);
      Object.entries(values).forEach(([key, value]) => store.set(key, String(value)));
    },
    remove(key) { store.delete(key); },
    removeAll(keys) {
      if (this.failRemoveAll) throw new Error('Cache remove failure');
      events.push('cache:clear');
      keys.forEach(key => store.delete(key));
    },
  };
}

function loadGas({ sheets = {}, lockAvailable = true, onLock, gmail } = {}) {
  const events = [];
  const sheetObjects = {};
  for (const [name, rows] of Object.entries(sheets)) sheetObjects[name] = createSheet(name, rows, events);
  const cache = createCache(events);
  const lock = {
    tryLock: (ms) => {
      events.push('lock:try');
      events.push(`lock:wait:${ms}`);
      if (onLock) onLock();
      if (!lockAvailable) return false;
      events.push('lock:acquired');
      return true;
    },
    waitLock: () => { throw new Error('use tryLock'); },
    releaseLock: () => events.push('lock:released'),
  };
  const sandbox = {
    console: { log: () => {}, warn: (...args) => events.push(`warn:${args.join(' ')}`), error: () => {} },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => lock },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (body) => ({ body, setMimeType: () => ({ body }) }),
    },
    GmailApp: gmail || { search: () => [], getMessagesForThreads: () => [] },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (key) => key === 'SHEET_ID' ? 'sheet-id' : undefined }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (name) => sheetObjects[name] || null }),
      flush: () => events.push('flush'),
    },
    UrlFetchApp: {},
    Utilities: {
      getUuid: () => '00000000-0000-4000-8000-000000000000',
      formatDate: (date) => `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  return { gas: sandbox, events, cache, sheets: sheetObjects };
}

const post = (gas, payload) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(payload) } }).body);
const get = (gas, parameter) => JSON.parse(gas.doGet({ parameter }).body);

const dataRows = () => [
  [...DATA_HEADER],
  ['2026/07/01', 'Store A', 1000, '食費', 'msg-1', 'ts', 'Expense'],
];
const fixedRows = () => [
  [...FIXED_HEADER],
  ['Expense', 'Rent', 80000, 27, '住居費'],
  ['Expense', 'Phone', 3000, 10, 'インフラ'],
  ['Income', 'Salary', 300000, 25, '給料'],
];

// ---------------------------------------------------------------- 4-5 lock

test('doPost writes run inside the script lock: read and write happen after acquiring, then flush and release', () => {
  const { gas, events } = loadGas({ sheets: { Data: dataRows() } });
  const result = post(gas, {
    action: 'updateTransaction', id: 'msg-1', currentDate: '2026/07/01',
    currentMerchant: 'Store A', currentAmount: 1000, amount: 1200,
  });
  assert.equal(result.success, true);
  const acquired = events.indexOf('lock:acquired');
  assert.ok(acquired !== -1);
  assert.ok(events.indexOf('read:Data') > acquired, 'rows must be (re)read after the lock is held');
  assert.ok(events.indexOf('write:Data') > acquired);
  assert.ok(events.indexOf('cache:clear') > acquired && events.indexOf('cache:clear') < events.indexOf('lock:released'));
  assert.ok(events.indexOf('flush') < events.indexOf('lock:released'));
  assert.equal(events.filter(e => e === 'lock:released').length, 1);
});

test('every doPost write action takes the lock', () => {
  const payloads = [
    { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' },
    { action: 'deleteTransaction', id: 'msg-1', date: '2026/07/01', merchant: 'Store A', amount: 1000 },
    { action: 'updateTransactionDate', id: 'msg-1', currentDate: '2026/07/01', merchant: 'Store A', amount: 1000, date: '2026/07/02' },
    { action: 'updateCategory', merchant: 'Store A', category: 'カフェ' },
    { action: 'addFixedCost', type: 'Expense', name: 'Gym', amount: 5000, day: 1, category: 'その他' },
    { action: 'deleteFixedCost', id: 0, type: 'Expense', name: 'Rent', amount: 80000, day: 27 },
  ];
  for (const payload of payloads) {
    const { gas, events } = loadGas({
      sheets: { Data: dataRows(), Config: [['支払い先', '分類']], Fixed: fixedRows(), Yahoo_Data: [[...DATA_HEADER]], Yahoo_Config: [['支払い先', '分類']] },
    });
    const result = post(gas, payload);
    assert.equal(result.success, true, `${payload.action}: ${JSON.stringify(result)}`);
    const writes = events.map((e, i) => [e, i]).filter(([e]) => e.startsWith('write:'));
    assert.ok(writes.length > 0, payload.action);
    for (const [, index] of writes) {
      assert.ok(index > events.indexOf('lock:acquired') && index < events.indexOf('lock:released'), `${payload.action} wrote outside the lock`);
    }
  }
});

test('a busy lock returns {error: "Busy"} without touching the sheet', () => {
  const { gas, events, sheets } = loadGas({ sheets: { Data: dataRows() }, lockAvailable: false });
  const result = post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' });
  assert.deepEqual(result, { error: 'Busy' });
  assert.equal(sheets.Data.rows.length, 2);
  assert.ok(!events.some(e => e.startsWith('write:') || e.startsWith('read:')));
  assert.ok(!events.includes('lock:released'), 'a lock that was not acquired is not released');
});

test('the lock is released even when the write throws', () => {
  const { gas, events, sheets } = loadGas({ sheets: { Data: dataRows() } });
  sheets.Data.appendRow = () => { throw new Error('Service error'); };
  const result = post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' });
  assert.match(result.error, /Service error/);
  assert.equal(events.filter(e => e === 'lock:released').length, 1);
});

test('processFixedCosts waits longer for the lock (trigger run) and logs that a skipped day is not retried', () => {
  const today = new Date();
  const fixed = [[...FIXED_HEADER], ['Expense', 'Daily', 100, today.getDate(), '固定費']];
  const busy = loadGas({ sheets: { Data: [[...DATA_HEADER]], Fixed: fixed }, lockAvailable: false });
  busy.gas.processFixedCostsForSource('main'); // the source whose sheets exist (a missing one is skipped before the lock)
  assert.ok(busy.events.includes('lock:wait:120000'));
  const warning = busy.events.find(e => e.startsWith('warn:'));
  assert.match(warning, /not retried/);

  const web = loadGas({ sheets: { Data: dataRows() } });
  post(web.gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' });
  assert.ok(web.events.includes('lock:wait:20000'), 'web app writes keep the shorter wait');
});

test('processFixedCosts takes the lock per source and skips (logged) when busy', () => {
  const today = new Date();
  const fixed = [[...FIXED_HEADER], ['Expense', 'Daily', 100, today.getDate(), '固定費']];
  const busy = loadGas({ sheets: { Data: [[...DATA_HEADER]], Fixed: fixed.map(r => [...r]) }, lockAvailable: false });
  busy.gas.processFixedCostsForSource('main');
  assert.equal(busy.sheets.Data.rows.length, 1);
  assert.ok(busy.events.some(e => e.startsWith('warn:')), 'a skipped run is logged');

  const ok = loadGas({ sheets: { Data: [[...DATA_HEADER]], Fixed: fixed.map(r => [...r]) } });
  ok.gas.processFixedCostsForSource('main');
  ok.gas.processFixedCostsForSource('main'); // second run must not duplicate
  assert.equal(ok.sheets.Data.rows.length, 2);
  assert.ok(ok.events.indexOf('read:Data') > ok.events.indexOf('lock:acquired'));
});

function jcbGmail(messageId) {
  const message = {
    getId: () => messageId,
    getSubject: () => 'JCBカード／ショッピングご利用のお知らせ',
    getPlainBody: () => '【ご利用日時(日本時間)】 2026/07/03 12:00\n【ご利用金額】 1,234円\n【ご利用先】 TEST SHOP\n',
  };
  return { search: () => [{}], getMessagesForThreads: () => [[message]] };
}

test('email import checks duplicates inside the lock (a concurrent import cannot double-insert)', () => {
  const yahooData = [[...DATA_HEADER]];
  const { gas, events, sheets } = loadGas({
    sheets: { Yahoo_Data: yahooData, Yahoo_Config: [['支払い先', '分類']] },
    gmail: jcbGmail('jcb-1'),
    // Another execution imports the same message while this one waits for the lock
    onLock: () => yahooData.push(['2026/07/03', 'TEST SHOP', 1234, '未分類', 'jcb-1', 'ts', 'Expense']),
  });
  gas.extractJcbEmails();
  assert.equal(sheets.Yahoo_Data.rows.length, 2, 'the row inserted by the other run is not duplicated');
  assert.equal(events.filter(e => e === 'lock:released').length, 1);
});

test('email import appends new rows under the lock and skips when busy', () => {
  const ok = loadGas({ sheets: { Yahoo_Data: [[...DATA_HEADER]], Yahoo_Config: [['支払い先', '分類']] }, gmail: jcbGmail('jcb-2') });
  ok.gas.extractJcbEmails();
  assert.equal(ok.sheets.Yahoo_Data.rows.length, 2);
  assert.equal(ok.sheets.Yahoo_Data.rows[1][4], 'jcb-2');
  const writeAt = ok.events.indexOf('write:Yahoo_Data');
  assert.ok(writeAt > ok.events.indexOf('lock:acquired') && writeAt < ok.events.indexOf('lock:released'));

  const busy = loadGas({ sheets: { Yahoo_Data: [[...DATA_HEADER]], Yahoo_Config: [['支払い先', '分類']] }, gmail: jcbGmail('jcb-3'), lockAvailable: false });
  busy.gas.extractJcbEmails();
  assert.equal(busy.sheets.Yahoo_Data.rows.length, 1);
  assert.ok(busy.events.some(e => e.startsWith('warn:')));
});

test('LINE webhook payloads are still acknowledged without a lock or source', () => {
  const { gas, events } = loadGas({ sheets: { Data: dataRows() } });
  const result = post(gas, { destination: 'synthetic-destination', events: [] });
  assert.deepEqual(result, { success: true, ignored: 'lineWebhook' });
  assert.ok(!events.includes('lock:try'));
});

// ---------------------------------------------------------------- 4-2 cache

function bigDataRows(count) {
  const rows = [[...DATA_HEADER]];
  for (let i = 0; i < count; i++) {
    rows.push(['2026/07/01', `テスト店舗${i}の長い名前`.repeat(3), 1000 + i, '食費', `msg-${i}`, 'ts', 'Expense']);
  }
  return rows;
}

test('a list larger than one cache value is chunked, served from cache, and still answers if caching fails', () => {
  const rows = bigDataRows(1500);
  const { gas, events, cache } = loadGas({ sheets: { Data: rows } });
  const first = get(gas, {});
  assert.equal(first.length, 1500);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') > CACHE_VALUE_LIMIT, 'fixture must exceed a single cache value');
  for (const value of cache.store.values()) assert.ok(Buffer.byteLength(value, 'utf8') <= CACHE_VALUE_LIMIT);

  const readsBefore = events.filter(e => e === 'read:Data').length;
  const second = get(gas, { source: 'main' });
  assert.deepEqual(second, first);
  assert.equal(events.filter(e => e === 'read:Data').length, readsBefore, 'second read is served from the chunked cache');

  const failing = loadGas({ sheets: { Data: bigDataRows(10) } });
  failing.cache.failPutAll = true;
  assert.equal(get(failing.gas, {}).length, 10, 'a cache failure must not fail doGet');
  assert.equal(get(failing.gas, { action: 'getFixedCosts' }).length, 0);
});

test('a missing chunk is treated as a cache miss', () => {
  const { gas, events, cache } = loadGas({ sheets: { Data: bigDataRows(1500) } });
  get(gas, {});
  const chunkKey = [...cache.store.keys()].find(key => /^kakeibo_main_data_.+_\d+$/.test(key));
  assert.ok(chunkKey, 'expected chunk keys');
  cache.store.delete(chunkKey);
  const readsBefore = events.filter(e => e === 'read:Data').length;
  assert.equal(get(gas, {}).length, 1500);
  assert.equal(events.filter(e => e === 'read:Data').length, readsBefore + 1);
});

test('writes clear every chunk, and main/yahoo use separate cache keys', () => {
  const { gas, cache } = loadGas({ sheets: { Data: bigDataRows(1500), Yahoo_Data: [[...DATA_HEADER], ['2026/07/09', 'Y', 1, '食費', 'y-1', 'ts', 'Expense']] } });
  get(gas, {});
  const yahoo = get(gas, { source: 'yahoo' });
  assert.equal(yahoo.length, 1);
  assert.equal(get(gas, { source: '' }).length, 1500, "'' shares the main cache");
  assert.ok([...cache.store.keys()].some(key => key.startsWith('kakeibo_yahoo_data')));

  assert.equal(post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' }).success, true);
  assert.ok(![...cache.store.keys()].some(key => key.startsWith('kakeibo_main_data')), 'old main chunks are removed (best effort)');
  assert.ok([...cache.store.keys()].some(key => key.startsWith('kakeibo_yahoo_data')), 'the yahoo cache is untouched by a main write');
  assert.equal(get(gas, {}).length, 1501);
});

test('a legacy single-value cache entry is ignored instead of being misread', () => {
  const { gas, cache } = loadGas({ sheets: { Data: dataRows() } });
  cache.store.set('kakeibo_main_data', JSON.stringify([{ id: 'stale' }]));
  const result = get(gas, {});
  assert.equal(result[0].id, 'msg-1');
});

// ---------------------------------------------------------------- 4-4 deleteFixedCost

test('deleteFixedCost with match fields deletes the row at id when it matches', () => {
  const { gas, sheets } = loadGas({ sheets: { Fixed: fixedRows() } });
  const result = post(gas, { action: 'deleteFixedCost', id: 1, type: 'Expense', name: 'Phone', amount: 3000, day: 10, category: 'インフラ' });
  assert.equal(result.success, true);
  assert.deepEqual(sheets.Fixed.rows.map(r => r[1]), ['Name', 'Rent', 'Salary']);
});

test('deleteFixedCost with a stale id finds the matching row instead of deleting a neighbour', () => {
  const { gas, sheets } = loadGas({ sheets: { Fixed: fixedRows() } });
  // id 0 is now Rent, but the client's list still shows Salary at id 0
  const result = post(gas, { action: 'deleteFixedCost', id: 0, type: 'Income', name: 'Salary', amount: 300000, day: 25 });
  assert.equal(result.success, true);
  assert.deepEqual(sheets.Fixed.rows.map(r => r[1]), ['Name', 'Rent', 'Phone']);
});

test('deleteFixedCost returns "Fixed cost not found" when no row matches', () => {
  const { gas, sheets } = loadGas({ sheets: { Fixed: fixedRows() } });
  for (const payload of [
    { id: 0, type: 'Expense', name: 'Rent', amount: 99999, day: 27 },
    { id: 0, type: 'Expense', name: 'Rent', amount: 80000, day: 27, category: '違うカテゴリ' },
    { id: 'abc', type: 'Expense', name: 'Nothing', amount: 1, day: 1 },
  ]) {
    assert.deepEqual(post(gas, { action: 'deleteFixedCost', ...payload }), { error: 'Fixed cost not found' });
  }
  assert.equal(sheets.Fixed.rows.length, 4);
});

test('legacy id-only deleteFixedCost still works for valid ids and never deletes the header', () => {
  const ok = loadGas({ sheets: { Fixed: fixedRows() } });
  assert.equal(post(ok.gas, { action: 'deleteFixedCost', id: 2 }).success, true);
  assert.deepEqual(ok.sheets.Fixed.rows.map(r => r[1]), ['Name', 'Rent', 'Phone']);
  assert.equal(post(ok.gas, { action: 'deleteFixedCost', id: '0' }).success, true);
  assert.deepEqual(ok.sheets.Fixed.rows.map(r => r[1]), ['Name', 'Phone']);

  for (const id of [-1, -2, 1.5, '1abc', '', null, undefined, 3, 100, 'NaN', true]) {
    const { gas, sheets } = loadGas({ sheets: { Fixed: fixedRows() } });
    const result = post(gas, { action: 'deleteFixedCost', id });
    assert.ok(result.error, `id ${JSON.stringify(id)} must be rejected`);
    assert.equal(sheets.Fixed.rows.length, 4);
    assert.deepEqual(sheets.Fixed.rows[0], FIXED_HEADER);
  }
});

// ---------------------------------------------------------------- 4-6 source

test('only undefined, "", "main" and "yahoo" are accepted as source', () => {
  for (const source of ['Yahoo', 'MAIN', 'other', 'yahoo ', 1, {}]) {
    const { gas, sheets, events } = loadGas({ sheets: { Data: dataRows(), Yahoo_Data: [[...DATA_HEADER]] } });
    assert.deepEqual(post(gas, { action: 'addTransaction', source, date: '2026/07/05', merchant: 'X', amount: 100 }), { error: 'Invalid source' });
    assert.equal(sheets.Data.rows.length, 2);
    assert.equal(sheets.Yahoo_Data.rows.length, 1);
    assert.ok(!events.includes('lock:try'));
    if (typeof source === 'string') {
      assert.deepEqual(get(gas, { source }), { error: 'Invalid source' });
      assert.deepEqual(get(gas, { source, action: 'getFixedCosts' }), { error: 'Invalid source' });
    }
  }
});

test('valid sources keep writing to their own sheets', () => {
  for (const [source, sheet] of [[undefined, 'Data'], ['', 'Data'], ['main', 'Data'], ['yahoo', 'Yahoo_Data']]) {
    const { gas, sheets } = loadGas({ sheets: { Data: [[...DATA_HEADER]], Yahoo_Data: [[...DATA_HEADER]] } });
    assert.equal(post(gas, { action: 'addTransaction', source, date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' }).success, true);
    assert.equal(sheets[sheet].rows.length, 2, `source ${JSON.stringify(source)} -> ${sheet}`);
    assert.equal(sheets[sheet === 'Data' ? 'Yahoo_Data' : 'Data'].rows.length, 1);
  }
});

// ---------------------------------------------------------------- cache generation (stale-save race)

const genOf = (cache, source) => cache.store.get(`kakeibo_${source}_gen`);

test('a read that started before a write does not cache its stale list', () => {
  const { gas, cache, sheets } = loadGas({ sheets: { Data: dataRows() } });
  const original = sheets.Data.getDataRange;
  let raced = true; // armed after warm-up
  sheets.Data.getDataRange = () => {
    const values = original().getValues(); // the read sees the pre-write sheet
    if (!raced) {
      raced = true;
      // A write (and its clearCache) lands before this read stores its result
      assert.equal(post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'New', amount: 100, category: '食費' }).success, true);
    }
    return { getValues: () => values };
  };
  get(gas, {}); // warm: creates the generation and caches
  cache.store.forEach((_, key) => { if (key.startsWith('kakeibo_main_data_')) cache.store.delete(key); });
  raced = false;

  const stale = get(gas, {});
  assert.equal(stale.length, 1, 'the racing read itself still answers with what it read');
  const fresh = get(gas, {});
  assert.equal(fresh.length, 2, 'the next read must not be served the stale list');
  assert.ok(fresh.some(row => row.merchant === 'New'));
});

test('chunks stored under another generation are never read', () => {
  const { gas, cache, events } = loadGas({ sheets: { Data: dataRows() } });
  get(gas, {});
  get(gas, {}); // cached now
  const reads = () => events.filter(e => e === 'read:Data').length;
  const before = reads();
  get(gas, {});
  assert.equal(reads(), before, 'served from cache under the current generation');

  cache.store.set('kakeibo_main_gen', 'other-generation');
  cache.store.set('kakeibo_main_data_other-generation_chunks', '1');
  cache.store.set('kakeibo_main_data_other-generation_0', JSON.stringify([{ id: 'planted' }]));
  cache.store.set('kakeibo_main_gen', 'another-generation');
  const result = get(gas, {});
  assert.equal(result[0].id, 'msg-1');
  assert.equal(reads(), before + 1);
});

test('a missing generation key is recreated before reading and old chunks are not trusted', () => {
  const { gas, cache, events } = loadGas({ sheets: { Data: dataRows() } });
  const reads = () => events.filter(e => e === 'read:Data').length;
  get(gas, {});
  const firstGen = genOf(cache, 'main');
  assert.ok(firstGen, 'the first read creates the generation');
  assert.ok(events.indexOf('read:Data') > -1);
  get(gas, {});
  assert.equal(reads(), 1, 'cached under the created generation');

  cache.store.delete('kakeibo_main_gen'); // evicted while chunks survive
  assert.equal(get(gas, {})[0].id, 'msg-1');
  assert.equal(reads(), 2, 'chunks of a lost generation are not trusted');
  assert.notEqual(genOf(cache, 'main'), firstGen);
  get(gas, {});
  assert.equal(reads(), 2);
});

test('every clear path rotates the generation of the affected source only', () => {
  const sheets = {
    Data: dataRows(), Config: [['支払い先', '分類']], Fixed: fixedRows(),
    Yahoo_Data: [[...DATA_HEADER]], Yahoo_Config: [['支払い先', '分類']], Yahoo_Fixed: [[...FIXED_HEADER], ['Expense', 'Daily', 100, new Date().getDate(), '固定費']],
  };
  const { gas, cache } = loadGas({ sheets, gmail: jcbGmail('jcb-gen') });
  get(gas, {});
  get(gas, { source: 'yahoo' });
  const snapshot = () => ({ main: genOf(cache, 'main'), yahoo: genOf(cache, 'yahoo') });
  let previous = snapshot();
  assert.ok(previous.main && previous.yahoo && previous.main !== previous.yahoo);

  const expectRotation = (label, main, yahoo) => {
    const now = snapshot();
    assert.equal(now.main !== previous.main, main, `${label}: main generation`);
    assert.equal(now.yahoo !== previous.yahoo, yahoo, `${label}: yahoo generation`);
    previous = now;
  };

  post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' });
  expectRotation('addTransaction main', true, false);
  post(gas, { action: 'addFixedCost', source: 'yahoo', type: 'Expense', name: 'Gym', amount: 5000, day: 1, category: 'その他' });
  expectRotation('addFixedCost yahoo', false, true);
  post(gas, { action: 'updateCategory', merchant: 'Store A', category: 'カフェ' });
  expectRotation('updateCategory', true, true);
  gas.processFixedCostsForSource('yahoo');
  expectRotation('processFixedCosts yahoo', false, true);
  gas.extractJcbEmails();
  expectRotation('JCB import', false, true);
});

// ---------------------------------------------------------------- clearCache ordering and failures

test('clearCache flushes the sheet before rotating the generation', () => {
  const { gas, events } = loadGas({ sheets: { Data: dataRows() } });
  post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'X', amount: 100, category: '食費' });
  const write = events.indexOf('write:Data');
  const rotate = events.indexOf('cache:put:kakeibo_main_gen');
  const flushBeforeRotate = events.slice(write, rotate).includes('flush');
  assert.ok(write !== -1 && rotate > write);
  assert.ok(flushBeforeRotate, `expected flush between the write and the generation rotation: ${events.join(', ')}`);
});

test('a cache invalidation failure after a successful write still reports success and drops current chunks', () => {
  const { gas, cache, sheets, events } = loadGas({ sheets: { Data: dataRows() } });
  get(gas, {});
  get(gas, {}); // cached under the current generation
  assert.ok([...cache.store.keys()].some(key => key.endsWith('_chunks')));

  cache.failGenPut = true;
  const result = post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'Once', amount: 100, category: '食費' });
  assert.equal(result.success, true, 'the row was written; reporting failure would make the UI resend it');
  assert.equal(sheets.Data.rows.filter(row => row[1] === 'Once').length, 1);
  assert.ok(events.some(e => e.startsWith('warn:') && e.includes('rotation failed')), 'the invalidation failure is logged');
  assert.ok(![...cache.store.keys()].some(key => key.endsWith('_chunks')), 'fallback removes the current generation chunks');
  assert.equal(get(gas, {}).length, 2, 'the next read sees the new row');

  cache.failRemoveAll = true;
  const second = post(gas, { action: 'addTransaction', date: '2026/07/06', merchant: 'Twice', amount: 100, category: '食費' });
  assert.equal(second.success, true, 'even a failed fallback does not turn a write into an error');
});

test('trigger writes survive a cache invalidation failure', () => {
  const { gas, cache, sheets } = loadGas({ sheets: { Yahoo_Data: [[...DATA_HEADER]], Yahoo_Config: [['支払い先', '分類']] }, gmail: jcbGmail('jcb-cachefail') });
  cache.failGenPut = true;
  cache.failRemoveAll = true;
  assert.doesNotThrow(() => gas.extractJcbEmails());
  assert.equal(sheets.Yahoo_Data.rows.length, 2);
});
