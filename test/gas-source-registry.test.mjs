import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source registry (design 2026-11-yuki-and-passkeys §5.1-5.3, §11 G1).
// All values below are synthetic: no real sheet id, LINE id or transactions.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');

const DATA_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type', 'RowId'];
const CONFIG_HEADER = ['支払い先', '分類'];
const FIXED_HEADER = ['Type', 'Name', 'Amount', 'Day', 'Category'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const today = () => new Date().getDate();

function createSheet(name, rows, events) {
  return {
    name,
    rows,
    getDataRange: () => ({ getValues: () => rows.map(row => [...row]) }),
    getLastRow: () => rows.length,
    getMaxColumns: () => 26,
    insertColumnsAfter: () => {},
    getRange: (row, column, numRows = 1, numColumns = 1) => ({
      getValues: () => rows.slice(row - 1, row - 1 + numRows)
        .map(r => Array.from({ length: numColumns }, (_, i) => (r[column - 1 + i] === undefined ? '' : r[column - 1 + i]))),
      setValue: (value) => { events.push(`write:${name}`); rows[row - 1][column - 1] = value; },
      setValues: (values) => {
        events.push(`write:${name}`);
        values.forEach((value, offset) => {
          const target = rows[row - 1 + offset] || (rows[row - 1 + offset] = []);
          value.forEach((cell, i) => { target[column - 1 + i] = cell; });
        });
      },
    }),
    appendRow: (row) => { events.push(`write:${name}`); rows.push([...row]); },
    deleteRow: (row) => { events.push(`write:${name}`); rows.splice(row - 1, 1); },
  };
}

function loadGas({ sheets = {}, properties = {}, lockAvailable = true, fetch } = {}) {
  const events = [];
  const logs = [];
  const sheetObjects = {};
  for (const [name, rows] of Object.entries(sheets)) sheetObjects[name] = createSheet(name, rows, events);
  const store = new Map();
  const pushes = [];
  const props = { SHEET_ID: 'sheet-id', LINE_CHANNEL_ACCESS_TOKEN: 'dummy-token', ...properties };
  const spreadsheet = {
    getSheetByName: (name) => sheetObjects[name] || null,
    insertSheet: (name) => {
      if (sheetObjects[name]) throw new Error(`A sheet with the name "${name}" already exists.`);
      events.push(`insertSheet:${name}`);
      sheetObjects[name] = createSheet(name, [], events);
      return sheetObjects[name];
    },
  };
  const sandbox = {
    console: {
      log: (...args) => logs.push(`log:${args.join(' ')}`),
      warn: (...args) => logs.push(`warn:${args.join(' ')}`),
      error: (...args) => logs.push(`error:${args.join(' ')}`),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (store.has(key) ? store.get(key) : null),
        getAll: (keys) => Object.fromEntries(keys.filter(k => store.has(k)).map(k => [k, store.get(k)])),
        put: (key, value) => store.set(key, String(value)),
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
    GmailApp: { search: () => [], getMessagesForThreads: () => [] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => props[key] }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { openById: () => spreadsheet, flush: () => {} },
    UrlFetchApp: {
      fetch: (url, options) => {
        const payload = JSON.parse(options.payload);
        pushes.push(payload);
        if (fetch) return fetch(payload);
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      },
    },
    Utilities: {
      getUuid: () => randomUUID(),
      formatDate: (date, _tz, format) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        if (format === 'yyyy/MM') return `${y}/${m}`;
        if (format === 'MM/dd') return `${m}/${d}`;
        return `${y}/${m}/${d}`;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  return { gas: sandbox, events, logs, sheets: sheetObjects, store, pushes };
}

const post = (gas, payload) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(payload) } }).body);
const get = (gas, parameter = {}) => JSON.parse(gas.doGet({ parameter }).body);
const plain = (value) => JSON.parse(JSON.stringify(value));

const allSheets = () => ({
  Data: [[...DATA_HEADER], ['2026/07/01', 'Main shop', 100, '食費', 'm-1', 'ts', 'Expense']],
  Config: [[...CONFIG_HEADER]],
  Fixed: [[...FIXED_HEADER], ['Expense', 'Daily main', 100, today(), '固定費']],
  Yahoo_Data: [[...DATA_HEADER], ['2026/07/01', 'Yahoo shop', 200, '食費', 'y-1', 'ts', 'Expense']],
  Yahoo_Config: [[...CONFIG_HEADER]],
  Yahoo_Fixed: [[...FIXED_HEADER], ['Expense', 'Daily yahoo', 200, today(), '固定費']],
  Yuki_Data: [[...DATA_HEADER], ['2026/07/01', 'Yuki shop', 300, '食費', 'k-1', 'ts', 'Expense']],
  Yuki_Config: [[...CONFIG_HEADER]],
  Yuki_Fixed: [[...FIXED_HEADER], ['Expense', 'Daily yuki', 300, today(), '固定費']],
});

// ---------------------------------------------------------------- registry and normalization

test('the registry lists main, yahoo and yuki with their own sheets, label and LINE property', () => {
  const { gas } = loadGas();
  assert.deepEqual(plain(vm.runInContext('SOURCE_IDS', gas)), ['main', 'yahoo', 'yuki']);
  assert.deepEqual(plain(gas.getTargetSheets('main')), { data: 'Data', config: 'Config', fixed: 'Fixed' });
  assert.deepEqual(plain(gas.getTargetSheets('yahoo')), { data: 'Yahoo_Data', config: 'Yahoo_Config', fixed: 'Yahoo_Fixed' });
  assert.deepEqual(plain(gas.getTargetSheets('yuki')), { data: 'Yuki_Data', config: 'Yuki_Config', fixed: 'Yuki_Fixed' });
  assert.equal(gas.getMonthlyReportDestinationPropertyKey('main'), 'LINE_DESTINATION_MAIN');
  assert.equal(gas.getMonthlyReportDestinationPropertyKey('yahoo'), 'LINE_DESTINATION_YAHOO');
  assert.equal(gas.getMonthlyReportDestinationPropertyKey('yuki'), 'LINE_DESTINATION_YUKI');
  assert.equal(gas.getMonthlyReportSourceLabel('main'), '家庭用');
  assert.equal(gas.getMonthlyReportSourceLabel('yahoo'), '個人用');
  assert.equal(gas.getMonthlyReportSourceLabel('yuki'), 'Yuki');
  const registry = vm.runInContext('SOURCES', gas);
  assert.deepEqual(['main', 'yahoo', 'yuki'].map(id => registry[id].lineOptional), [false, false, true], 'only yuki may lack a LINE destination');
  assert.deepEqual(['main', 'yahoo', 'yuki'].map(id => registry[id].requiresActor), [false, false, true]);
  assert.throws(() => { registry.yuki.data = 'Data'; }, TypeError, 'the registry is frozen');
  assert.throws(() => { registry.other = {}; }, TypeError, 'no source can be added at run time');
});

test('normalizeSource keeps the legacy "absent = main" and accepts only registry ids as strings', () => {
  const { gas } = loadGas();
  for (const absent of [undefined, null, '']) assert.equal(gas.normalizeSource(absent), 'main');
  for (const id of ['main', 'yahoo', 'yuki']) assert.equal(gas.normalizeSource(id), id);
  for (const bad of ['Yahoo', 'YUKI', 'other', 'constructor', '__proto__', 'toString', ['yahoo'], 1, {}]) {
    assert.equal(gas.normalizeSource(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('no lookup falls back to main: unknown or missing sources throw', () => {
  const { gas } = loadGas();
  for (const bad of [undefined, null, '', 'other', 'Yahoo', 'constructor', ['yahoo']]) {
    const label = JSON.stringify(bad) ?? 'undefined';
    assert.throws(() => gas.getTargetSheets(bad), /Unknown source/, `getTargetSheets(${label})`);
    assert.throws(() => gas.getMonthlyReportDestinationPropertyKey(bad), /Unknown source/, `destination(${label})`);
    assert.throws(() => gas.getMonthlyReportSourceLabel(bad), /Unknown source/, `label(${label})`);
  }
  for (const bad of [undefined, null, '', 'other', 'Yahoo', 'constructor', ['yahoo']]) {
    const label = JSON.stringify(bad) ?? 'undefined';
    assert.throws(() => gas.getCacheSourceKey(bad), /Unknown source/, `getCacheSourceKey(${label})`);
    assert.throws(() => gas.clearCache(bad), /Unknown source/, `clearCache(${label})`);
  }
});

test('cache keys are separated per source (exact ids only; the legacy main keys are unchanged)', () => {
  const { gas } = loadGas();
  assert.equal(gas.getCacheSourceKey('main'), 'kakeibo_main');
  assert.equal(gas.getCacheGenKey('main'), 'kakeibo_main_gen');
  assert.equal(gas.getCacheSourceKey('yahoo'), 'kakeibo_yahoo');
  assert.equal(gas.getCacheSourceKey('yuki'), 'kakeibo_yuki');
  assert.equal(gas.getCacheKey('yuki', 'data'), 'kakeibo_yuki_data');
  assert.equal(gas.getCacheKey('yuki', 'fixed'), 'kakeibo_yuki_fixed');
  assert.equal(gas.getCacheGenKey('yuki'), 'kakeibo_yuki_gen');
});

test('clearCache("yuki") rotates only the yuki generation', () => {
  const { gas, store } = loadGas();
  store.set('kakeibo_main_gen', 'g-main');
  store.set('kakeibo_yahoo_gen', 'g-yahoo');
  store.set('kakeibo_yuki_gen', 'g-yuki');
  assert.equal(gas.clearCache('yuki'), true);
  assert.notEqual(store.get('kakeibo_yuki_gen'), 'g-yuki');
  assert.equal(store.get('kakeibo_main_gen'), 'g-main');
  assert.equal(store.get('kakeibo_yahoo_gen'), 'g-yahoo');
});

// ---------------------------------------------------------------- web app access (old UI compatibility)

test('old UI requests keep working: source absent / main / yahoo read and write their own sheets', () => {
  const { gas, sheets } = loadGas({ sheets: allSheets() });
  assert.deepEqual(get(gas).map(r => r.merchant), ['Main shop']);
  assert.deepEqual(get(gas, { source: '' }).map(r => r.merchant), ['Main shop']);
  assert.deepEqual(get(gas, { source: 'main' }).map(r => r.merchant), ['Main shop']);
  assert.deepEqual(get(gas, { source: 'yahoo' }).map(r => r.merchant), ['Yahoo shop']);
  assert.deepEqual(get(gas, { action: 'getFixedCosts', source: 'yahoo' }).map(r => r.name), ['Daily yahoo']);

  assert.equal(post(gas, { action: 'addTransaction', date: '2026/07/05', merchant: 'New main', amount: 1, category: '食費' }).success, true);
  assert.equal(post(gas, { action: 'addTransaction', source: 'yahoo', date: '2026/07/05', merchant: 'New yahoo', amount: 2, category: '食費' }).success, true);
  assert.equal(sheets.Data.rows.at(-1)[1], 'New main');
  assert.equal(sheets.Yahoo_Data.rows.at(-1)[1], 'New yahoo');
  assert.equal(sheets.Yuki_Data.rows.length, 2, 'yuki untouched');
});

test('yuki is not reachable through the web app until actor verification exists (G2)', () => {
  const { gas, sheets, store } = loadGas({ sheets: allSheets() });
  const before = JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([k, s]) => [k, s.rows])));
  assert.deepEqual(get(gas, { source: 'yuki' }), { error: 'Forbidden' });
  assert.deepEqual(get(gas, { action: 'getFixedCosts', source: 'yuki' }), { error: 'Forbidden' });
  for (const action of ['addTransaction', 'addFixedCost', 'deleteFixedCost', 'deleteTransaction', 'updateTransaction', 'updateTransactionDate', 'updateCategory']) {
    assert.deepEqual(post(gas, { action, source: 'yuki', date: '2026/07/05', merchant: 'Yuki shop', amount: 1, category: '食費', id: 'k-1' }), { error: 'Forbidden' }, action);
  }
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([k, s]) => [k, s.rows]))), before, 'no sheet changed');
  assert.equal(store.has('kakeibo_yuki_gen'), false, 'yuki cache not touched');
});

test('unknown sources are still rejected with Invalid source and never reach main', () => {
  const { gas, sheets } = loadGas({ sheets: allSheets() });
  for (const source of ['Yuki', 'other', 'constructor']) {
    assert.deepEqual(get(gas, { source }), { error: 'Invalid source' });
    assert.deepEqual(post(gas, { action: 'addTransaction', source, date: '2026/07/05', merchant: 'X', amount: 1 }), { error: 'Invalid source' });
  }
  assert.equal(sheets.Data.rows.length, 2);
});

// ---------------------------------------------------------------- fixed costs

test('processFixedCosts adds each source\'s fixed costs to its own Data sheet with the legacy id format', () => {
  const { gas, sheets } = loadGas({ sheets: allSheets() });
  gas.processFixedCosts();
  const month = (() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  assert.deepEqual(sheets.Data.rows.slice(2).map(r => [r[1], r[4]]), [['Daily main', `fixed_${month}_Daily main_main`]]);
  assert.deepEqual(sheets.Yahoo_Data.rows.slice(2).map(r => [r[1], r[4]]), [['Daily yahoo', `fixed_${month}_Daily yahoo_yahoo`]]);
  assert.deepEqual(sheets.Yuki_Data.rows.slice(2).map(r => [r[1], r[4]]), [['Daily yuki', `fixed_${month}_Daily yuki_yuki`]]);
  for (const sheet of [sheets.Data, sheets.Yahoo_Data, sheets.Yuki_Data]) assert.match(String(sheet.rows.at(-1)[7]), UUID);

  gas.processFixedCosts(); // idempotent within the month
  assert.equal(sheets.Data.rows.length, 3);
  assert.equal(sheets.Yuki_Data.rows.length, 3);
});

test('processFixedCosts skips a source whose sheets do not exist yet (yuki before setupSourceSheets)', () => {
  const s = allSheets();
  delete s.Yuki_Data; delete s.Yuki_Config; delete s.Yuki_Fixed;
  const { gas, sheets, events } = loadGas({ sheets: s });
  assert.doesNotThrow(() => gas.processFixedCosts());
  assert.equal(sheets.Data.rows.length, 3);
  assert.equal(sheets.Yahoo_Data.rows.length, 3);
  assert.equal(events.filter(e => e === 'lock:try').length, 2, 'the missing source does not take the lock');

  const busy = loadGas({ sheets: {}, lockAvailable: false });
  busy.gas.processFixedCostsForSource('yuki');
  assert.ok(!busy.events.includes('lock:try'), 'no lock wait for a source without sheets');
});

test('processFixedCosts: one failing source does not stop the others, and the run still reports the failure', () => {
  const { gas, sheets, logs } = loadGas({ sheets: allSheets() });
  sheets.Data.getRange = () => { throw new Error('Synthetic main failure'); };
  assert.throws(() => gas.processFixedCosts(), /main/);
  assert.equal(sheets.Yahoo_Data.rows.length, 3, 'yahoo still processed');
  assert.equal(sheets.Yuki_Data.rows.length, 3, 'yuki still processed');
  assert.ok(logs.some(l => l.startsWith('error:') && l.includes('main')), 'failure is logged');
});

test('processFixedCostsForSource requires an explicit, known source', () => {
  const { gas, sheets } = loadGas({ sheets: allSheets() });
  for (const bad of [undefined, '', 'other']) {
    assert.throws(() => gas.processFixedCostsForSource(bad), /Unknown source/);
  }
  assert.equal(sheets.Data.rows.length, 2, 'nothing defaulted to main');
});

// ---------------------------------------------------------------- monthly LINE reports

const lastMonthRow = (merchant, amount) => {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 5);
  return [`${m.getFullYear()}/${String(m.getMonth() + 1).padStart(2, '0')}/05`, merchant, amount, '食費', `id-${merchant}`, 'ts', 'Expense'];
};

const reportSheets = () => ({
  Data: [[...DATA_HEADER], lastMonthRow('Main shop', 100)],
  Yahoo_Data: [[...DATA_HEADER], lastMonthRow('Yahoo shop', 200)],
  Yuki_Data: [[...DATA_HEADER], lastMonthRow('Yuki shop', 300)],
});
const DESTINATIONS = { LINE_DESTINATION_MAIN: 'dummy-main', LINE_DESTINATION_YAHOO: 'dummy-yahoo', LINE_DESTINATION_YUKI: 'dummy-yuki' };

test('monthly reports go to each source\'s own destination with that source\'s rows', () => {
  const { gas, pushes } = loadGas({ sheets: reportSheets(), properties: DESTINATIONS });
  gas.sendMonthlyKakeiboReports();
  assert.deepEqual(pushes.map(p => p.to), ['dummy-main', 'dummy-yahoo', 'dummy-yuki']);
  const text = (to) => pushes.find(p => p.to === to).messages[0].text;
  assert.match(text('dummy-main'), /¥100/);
  assert.doesNotMatch(text('dummy-main'), /¥300/);
  assert.match(text('dummy-yuki'), /¥300/);
  assert.doesNotMatch(text('dummy-yuki'), /¥100|¥200/);
});

test('the yuki report (lineOptional) without a destination is skipped with a warning, never sent to another destination', () => {
  const withoutYuki = { ...DESTINATIONS };
  delete withoutYuki.LINE_DESTINATION_YUKI;
  const { gas, pushes, logs } = loadGas({ sheets: reportSheets(), properties: withoutYuki });
  assert.doesNotThrow(() => gas.sendMonthlyKakeiboReports());
  assert.deepEqual(pushes.map(p => p.to), ['dummy-main', 'dummy-yahoo']);
  assert.ok(pushes.every(p => !p.messages[0].text.includes('¥300')), 'yuki rows are not sent anywhere');
  assert.ok(logs.some(l => l.startsWith('warn:') && l.includes('LINE_DESTINATION_YUKI')));
});

test('a missing main / yahoo destination is still a failure: the others are sent, then the run throws naming it', () => {
  for (const [missing, key, others] of [
    ['main', 'LINE_DESTINATION_MAIN', ['dummy-yahoo', 'dummy-yuki']],
    ['yahoo', 'LINE_DESTINATION_YAHOO', ['dummy-main', 'dummy-yuki']],
  ]) {
    const properties = { ...DESTINATIONS };
    delete properties[key];
    const { gas, pushes, logs } = loadGas({ sheets: reportSheets(), properties });
    assert.throws(() => gas.sendMonthlyKakeiboReports(), new RegExp(`Monthly LINE report failed for: ${missing} \\(`), `${missing}: run reports the failure`);
    assert.deepEqual(pushes.map(p => p.to), others, `${missing}: the other sources are still sent`);
    assert.ok(logs.some(l => l.startsWith('error:') && l.includes(key)), `${missing}: the missing property is logged`);
  }
});

test('monthly reports: one failing source does not stop the others, and the run still reports the failure', () => {
  const { gas, pushes, logs } = loadGas({
    sheets: reportSheets(),
    properties: DESTINATIONS,
    fetch: (payload) => (payload.to === 'dummy-main'
      ? { getResponseCode: () => 500, getContentText: () => 'synthetic error' }
      : { getResponseCode: () => 200, getContentText: () => '{}' }),
  });
  assert.throws(() => gas.sendMonthlyKakeiboReports(), /main/);
  assert.deepEqual(pushes.map(p => p.to), ['dummy-main', 'dummy-yahoo', 'dummy-yuki'], 'yahoo and yuki still sent');
  assert.ok(logs.some(l => l.startsWith('error:') && l.includes('main')));
});

test('sendMonthlyKakeiboReportForSource never defaults to main', () => {
  const { gas, pushes } = loadGas({ sheets: reportSheets(), properties: DESTINATIONS });
  for (const bad of [undefined, '', 'other']) assert.throws(() => gas.sendMonthlyKakeiboReportForSource(bad), /Unknown source/);
  assert.equal(pushes.length, 0);
  assert.equal(gas.sendMonthlyKakeiboReportForSource('yuki').source, 'yuki');
});

// ---------------------------------------------------------------- backfillRowIds

test('backfillRowIds covers every registry source and keeps them apart', () => {
  const { gas, sheets, store } = loadGas({
    sheets: {
      Data: [[...DATA_HEADER], ['2026/07/01', 'A', 1, '食費', 'm', 'ts', 'Expense']],
      Yahoo_Data: [[...DATA_HEADER]],
      Yuki_Data: [[...DATA_HEADER], ['2026/07/01', 'K', 1, '食費', 'k', 'ts', 'Expense'], ['2026/07/02', 'L', 2, '食費', 'l', 'ts', 'Expense']],
    },
  });
  store.set('kakeibo_main_gen', 'g-main');
  store.set('kakeibo_yahoo_gen', 'g-yahoo');
  store.set('kakeibo_yuki_gen', 'g-yuki');
  assert.deepEqual(plain(gas.backfillRowIds()), { main: 1, yahoo: 0, yuki: 2 });
  assert.match(String(sheets.Yuki_Data.rows[1][7]), UUID);
  assert.match(String(sheets.Yuki_Data.rows[2][7]), UUID);
  assert.notEqual(store.get('kakeibo_yuki_gen'), 'g-yuki');
  assert.equal(store.get('kakeibo_yahoo_gen'), 'g-yahoo', 'unchanged source keeps its cache');
});

test('backfillRowIds works before the yuki sheets exist', () => {
  const { gas } = loadGas({ sheets: { Data: [[...DATA_HEADER]], Yahoo_Data: [[...DATA_HEADER]] } });
  assert.deepEqual(plain(gas.backfillRowIds()), { main: 0, yahoo: 0, yuki: 0 });
});

// ---------------------------------------------------------------- setupSourceSheets

test('setupSourceSheets("yuki") creates Yuki_Data / Yuki_Config / Yuki_Fixed with the shared headers', () => {
  const s = allSheets();
  delete s.Yuki_Data; delete s.Yuki_Config; delete s.Yuki_Fixed;
  const { gas, sheets, events } = loadGas({ sheets: s });
  const result = plain(gas.setupSourceSheets('yuki'));
  assert.deepEqual(result, { yuki: ['Yuki_Data', 'Yuki_Config', 'Yuki_Fixed'] });
  assert.deepEqual(sheets.Yuki_Data.rows, [DATA_HEADER]);
  assert.deepEqual(sheets.Yuki_Config.rows, [CONFIG_HEADER]);
  assert.deepEqual(sheets.Yuki_Fixed.rows, [FIXED_HEADER]);
  assert.ok(events.indexOf('insertSheet:Yuki_Data') > events.indexOf('lock:acquired'), 'created under the lock');
  assert.ok(!events.some(e => /^write:(Data|Config|Fixed|Yahoo_)/.test(e)), 'other sources untouched');
});

test('setupSourceSheets is idempotent and never touches an existing sheet', () => {
  const s = allSheets();
  delete s.Yuki_Config;
  const { gas, sheets, events } = loadGas({ sheets: s });
  const yukiData = JSON.stringify(sheets.Yuki_Data.rows);
  assert.deepEqual(plain(gas.setupSourceSheets('yuki')), { yuki: ['Yuki_Config'] });
  assert.equal(JSON.stringify(sheets.Yuki_Data.rows), yukiData, 'existing Yuki_Data kept as is');

  const before = events.length;
  assert.deepEqual(plain(gas.setupSourceSheets('yuki')), { yuki: [] });
  assert.ok(!events.slice(before).some(e => e.startsWith('insertSheet:') || e.startsWith('write:')), 'second run writes nothing');
});

test('setupSourceSheets() without an argument (editor run) creates only the missing sheets of every source', () => {
  const s = allSheets();
  delete s.Yuki_Data; delete s.Yuki_Config; delete s.Yuki_Fixed;
  const { gas, events } = loadGas({ sheets: s });
  assert.deepEqual(plain(gas.setupSourceSheets()), { main: [], yahoo: [], yuki: ['Yuki_Data', 'Yuki_Config', 'Yuki_Fixed'] });
  assert.ok(!events.some(e => /^write:(Data|Config|Fixed|Yahoo_)/.test(e)));
});

test('setupSourceSheets rejects an unknown source and fails without the lock, creating nothing', () => {
  const { gas, events } = loadGas();
  assert.throws(() => gas.setupSourceSheets('other'), /Unknown source/);
  assert.ok(!events.some(e => e.startsWith('insertSheet:')));
  const busy = loadGas({ lockAvailable: false });
  assert.throws(() => busy.gas.setupSourceSheets('yuki'), /lock/i);
  assert.ok(!busy.events.some(e => e.startsWith('insertSheet:')));
});
