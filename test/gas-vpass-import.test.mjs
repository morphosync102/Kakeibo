import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 三井住友カード (Vpass) notifications, IMPROVEMENTS 8-3: the 2025-03+ format
// ("ご利用日時："), the old format ("◇利用日："), re-import and the debug helper.
// All mail texts, merchants and amounts below are synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');
const DATA_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type', 'RowId'];

function createSheet(name, rows, events) {
  return {
    rows,
    getDataRange: () => ({ getValues: () => rows.map(row => [...row]) }),
    getLastRow: () => rows.length,
    getMaxColumns: () => 26,
    insertColumnsAfter: () => {},
    getRange: (row, column, numRows = 1, numColumns = 1) => ({
      getValues: () => rows.slice(row - 1, row - 1 + numRows).map(r => r.slice(column - 1, column - 1 + numColumns)),
      getValue: () => (rows[row - 1] || [])[column - 1],
      setValue: (value) => { events.push(`write:${name}`); rows[row - 1][column - 1] = value; },
      setValues: (values) => {
        events.push(`write:${name}`);
        values.forEach((value, offset) => { rows[row - 1 + offset] = [...value]; });
      },
    }),
  };
}

// Reading a body advances this fake clock by 1 s (re-import time budget tests)
const clock = { t: 0 };

function message(id, body) {
  return {
    getId: () => id,
    getSubject: () => 'ご利用のお知らせ【三井住友カード】',
    getPlainBody: () => { clock.t += 1000; return body; },
  };
}

// Gmail-style message ids (hex), as imported rows carry in column E
const mid = n => n.toString(16).padStart(16, '0');

// threads: arrays of messages (newest thread first, as Gmail search returns)
function gmailWith(threads, queries = []) {
  const threadObjects = threads.map(messages => ({ messages, getMessages: () => messages }));
  return {
    search: (query, start = 0, max = 500) => {
      queries.push({ query, start, max });
      return threadObjects.slice(start, start + max);
    },
    getMessagesForThreads: list => list.map(thread => thread.messages),
  };
}

function loadGas({ yahooData = [[...DATA_HEADER]], config = [['支払い先', '分類']], gmail, lockAvailable = true, onLock } = {}) {
  const events = [];
  const logs = [];
  const sheets = {
    Yahoo_Data: createSheet('Yahoo_Data', yahooData, events),
    Yahoo_Config: createSheet('Yahoo_Config', config, events),
    Data: createSheet('Data', [[...DATA_HEADER]], events),
  };
  const store = new Map();
  let uuid = 0;
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    CacheService: {
      getScriptCache: () => ({
        get: k => (store.has(k) ? store.get(k) : null), getAll: () => ({}), put: (k, v) => { events.push(`cache:put:${k}`); store.set(k, String(v)); },
        putAll: () => {}, remove: k => store.delete(k), removeAll: keys => keys.forEach(k => store.delete(k)),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { events.push('lock:try'); if (onLock) onLock(); if (!lockAvailable) return false; events.push('lock:acquired'); return true; },
        releaseLock: () => events.push('lock:released'),
      }),
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: body => ({ body, setMimeType: () => ({ body }) }) },
    GmailApp: gmail || gmailWith([]),
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => (key === 'SHEET_ID' ? 'synthetic-sheet-id' : null) }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets[name] || null }), flush: () => events.push('flush') },
    UrlFetchApp: {},
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      formatDate: d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  return { gas: sandbox, sheets, events, logs };
}

const plain = value => JSON.parse(JSON.stringify(value));
const { gas: pure } = loadGas();
const parse = body => plain(pure.parseVpassBody(body));
const parseEither = body => plain(pure.parseVpassEmail(body));

// ---------------------------------------------------------------- new format layouts

const NEW_STACKED = [
  '架空 太郎 様',
  'いつも三井住友カードをご利用いただきありがとうございます。',
  'ご利用内容',
  'ご利用日時：2026/11/05 22:55',
  'テスト商店（買物）',
  '150円',
  '',
  'ご利用いただいたカード：Ｏｌｉｖｅ',
].join('\n');

test('new format: date / merchant / amount on separate lines; usage type removed; date part only', () => {
  assert.deepEqual(parse(NEW_STACKED), [{ date: '2026/11/05', merchant: 'テスト商店', amount: 150 }]);
});

test('new format: merchant and amount on one line, table bars, comma amounts, full-width text', () => {
  const cases = [
    ['ご利用日時：2026/11/05 22:55\nテスト商店（買物） 150円', 'テスト商店', 150],
    ['ご利用日時：2026/11/05 22:55\n| テスト商店（買物） | 3,000円 |', 'テスト商店', 3000],
    ['| ご利用日時：2026/11/05 22:55 | | ＴＥＳＴ　ＳＨＯＰ　架空店（買物） | 12,345円 |', 'ＴＥＳＴ ＳＨＯＰ 架空店', 12345],
    ['ご利用日時：2026/11/05 22:55 架空カフェ（買物） 1,234,567円', '架空カフェ', 1234567],
    ['ご利用日時：2026/1/5\n架空ストア\n４８０円', '架空ストア', 480], // no time, short date, full-width digits
    ['ご利用日時 ： ２０２６/１１/０５ ２２：５５\n架空書店（買物）\n２，２００円', '架空書店', 2200],
    ['ご利用日時：2026/11/05 22:55\n架空100円ショップ（買物）\n330円', '架空100円ショップ', 330],
    ['ご利用日時：2026/11/05 22:55\n架空商会（新宿店）\n500円', '架空商会（新宿店）', 500], // not a usage type: kept
  ];
  for (const [body, merchant, amount] of cases) {
    const [item, ...rest] = parse(body);
    assert.equal(rest.length, 0, body);
    assert.equal(item.merchant, merchant, body);
    assert.equal(item.amount, amount, body);
    assert.match(item.date, /^\d{4}\/\d{2}\/\d{2}$/, body);
  }
  assert.equal(parse('ご利用日時：2026/1/5\n架空ストア\n480円')[0].date, '2026/01/05');
});

test('new format: HTML leftovers, NBSP, entities and CRLF are tolerated', () => {
  const html = '<table><tr><td>ご利用日時：2026/11/05&nbsp;22:55</td></tr>\r\n<tr><td>架空&amp;商店（買物）</td><td> 3,000円</td></tr></table>';
  assert.deepEqual(parse(html), [{ date: '2026/11/05', merchant: '架空&商店', amount: 3000 }]);
  const br = 'ご利用日時：2026/11/05 22:55<br>架空商店（買物）<br/>150円<br>';
  assert.deepEqual(parse(br), [{ date: '2026/11/05', merchant: '架空商店', amount: 150 }]);
});

test('forwarded mail: the forwarding header lines are ignored', () => {
  const forwarded = [
    '---------- 転送されたメッセージ ---------',
    '差出人: 三井住友カード <statement@vpass.ne.jp>',
    'Date: 2026年11月5日(木) 22:56',
    '件名: ご利用のお知らせ【三井住友カード】',
    'To: <someone@example.com>',
    '',
    NEW_STACKED,
  ].join('\n');
  assert.deepEqual(parse(forwarded), [{ date: '2026/11/05', merchant: 'テスト商店', amount: 150 }]);
});

test('several transactions in one mail are all returned, in order', () => {
  const body = [
    'ご利用内容',
    'ご利用日時：2026/11/05 10:00', '架空パン屋（買物）', '320円',
    'ご利用日時：2026/11/05 12:30 | 架空食堂（買物） | 1,100円 |',
    'ご利用日時：2026/11/06 08:15', '架空駅売店', '210円',
  ].join('\n');
  assert.deepEqual(parse(body), [
    { date: '2026/11/05', merchant: '架空パン屋', amount: 320 },
    { date: '2026/11/05', merchant: '架空食堂', amount: 1100 },
    { date: '2026/11/06', merchant: '架空駅売店', amount: 210 },
  ]);
});

test('invalid or unrelated bodies give no transaction', () => {
  for (const body of [
    '', null, undefined, 42, 'ご利用ありがとうございます。',
    'ご利用日時：2026/11/05 22:55\n架空商店（買物）', // no amount
    'ご利用日時：2026/11/05 22:55\n150円', // no merchant
    'ご利用日時：2026/13/05 22:55\n架空商店\n150円', // bad month
    'ご利用日時：2026/11/05\n架空商店\n0円',
    'ご利用日：2026/11/05\n架空商店\n150円', // wrong label
    `ご利用日時：2026/11/05\n${'長'.repeat(150)}\n150円`, // implausible merchant
  ]) {
    assert.deepEqual(parse(body), [], String(body));
  }
});

// ---------------------------------------------------------------- old format (regression)

const OLD_BODY = ['◇利用日：2025/02/10 12:00', '◇利用先：架空マート', '◇利用取引：買物', '◇利用金額：1,980円'].join('\n');

test('old format still parses (parseOliveBody unchanged) and parseVpassEmail accepts both', () => {
  assert.deepEqual(plain(pure.parseOliveBody(OLD_BODY)), [{ date: '2025/02/10', merchant: '架空マート', amount: 1980 }]);
  assert.deepEqual(parse(OLD_BODY), [], 'the new parser does not read the old format');
  assert.deepEqual(parseEither(OLD_BODY), [{ date: '2025/02/10', merchant: '架空マート', amount: 1980 }]);
  assert.deepEqual(parseEither(NEW_STACKED), [{ date: '2026/11/05', merchant: 'テスト商店', amount: 150 }]);
  assert.deepEqual(parseEither(''), []);
});

test('parseVpassBody is pure (no Apps Script service is touched)', () => {
  const forbidden = name => new Proxy({}, { get: () => { throw new Error(`${name} used`); } });
  const sandbox = {
    console,
    // the top level of the script reads SHEET_ID once; nothing else is available
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    GmailApp: forbidden('GmailApp'), SpreadsheetApp: forbidden('SpreadsheetApp'), CacheService: forbidden('CacheService'),
    LockService: forbidden('LockService'), Utilities: forbidden('Utilities'), UrlFetchApp: forbidden('UrlFetchApp'),
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  assert.deepEqual(plain(sandbox.parseVpassBody(NEW_STACKED)), [{ date: '2026/11/05', merchant: 'テスト商店', amount: 150 }]);
});

// ---------------------------------------------------------------- trigger import

test('the 5-day trigger imports new-format mails into Yahoo_Data with the Config category', () => {
  const { gas, sheets } = loadGas({
    config: [['支払い先', '分類'], ['テスト商', '食費']],
    gmail: gmailWith([[message('vp-1', NEW_STACKED)], [message('vp-old', OLD_BODY)]]),
  });
  gas.extractOliveEmails();
  const rows = sheets.Yahoo_Data.rows.slice(1);
  assert.deepEqual(rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[6]]), [
    ['2026/11/05', 'テスト商店', 150, '食費', 'vp-1', 'Expense'],
    ['2025/02/10', '架空マート', 1980, '未分類', 'vp-old', 'Expense'],
  ]);
  assert.ok(rows.every(r => /^[0-9a-f-]{36}$/.test(r[7])), 'RowIds assigned');
  assert.equal(sheets.Data.rows.length, 1, 'never written to main');
});

// ---------------------------------------------------------------- re-import

const MULTI = 'ご利用日時：2026/11/05 10:00\n架空パン屋（買物）\n320円\nご利用日時：2026/11/05 12:30\n架空食堂（買物）\n1,100円';

test('reimportVpassSince adds each message once (MessageId), under the lock, and logs counts only', () => {
  const queries = [];
  const threads = [[message(mid(1), NEW_STACKED)], [message(mid(2), MULTI)], [message(mid(3), 'お知らせのみ')]];
  const yahooData = [[...DATA_HEADER], ['2026/11/05', 'テスト商店', 150, '食費', mid(1), 'ts', 'Expense', '00000000-0000-4000-8000-00000000abcd']];
  const { gas, sheets, events, logs } = loadGas({ yahooData, gmail: gmailWith(threads, queries) });

  const first = plain(gas.reimportVpassSince('2025/03/01'));
  assert.deepEqual(first, {
    threads: 3, messages: 3, alreadyImportedMessages: 1, parsedMessages: 1, transactions: 2,
    alreadyImported: 0, matchedManual: 0, added: 2, wouldAdd: 0, complete: true, dryRun: false,
  });
  assert.equal(queries[0].query, 'from:statement@vpass.ne.jp subject:利用のお知らせ after:2025/03/01');
  assert.equal(sheets.Yahoo_Data.rows.length, 4);
  const writeAt = events.indexOf('write:Yahoo_Data');
  assert.ok(writeAt > events.indexOf('lock:acquired') && writeAt < events.indexOf('lock:released'), 'written inside the lock');
  assert.ok(events.includes('cache:put:kakeibo_yahoo_gen'), 'the yahoo cache is cleared');

  const second = plain(gas.reimportVpassSince('2025/03/01'));
  assert.equal(second.added, 0, 'a second run adds nothing');
  assert.equal(second.alreadyImportedMessages, 2);
  assert.equal(sheets.Yahoo_Data.rows.length, 4);

  // logs: counts only, never merchants / amounts / ids / bodies
  assert.ok(logs.length > 0);
  for (const secret of ['テスト商店', '架空パン屋', '架空食堂', '320', '1,100', '1100', mid(2), 'お知らせのみ']) {
    assert.ok(logs.every(line => !line.includes(secret)), `${secret}: ${logs.join(' | ')}`);
  }
});

test('reimportVpassSince pages through Gmail, validates the date and fails loudly when the lock is busy', () => {
  const many = Array.from({ length: 250 }, (_, i) => [message(mid(1000 + i), `ご利用日時：2026/10/01 10:00\n架空店${i}\n${100 + i}円`)]);
  const queries = [];
  const { gas, sheets } = loadGas({ gmail: gmailWith(many, queries) });
  const result = plain(gas.reimportVpassSince('2025/03/01'));
  assert.deepEqual(queries.map(q => [q.start, q.max]), [[0, 100], [100, 100], [200, 100]]);
  assert.equal(result.added, 250);
  assert.equal(sheets.Yahoo_Data.rows.length, 251);

  for (const bad of [undefined, '2025-03-01', '2025/3/1', 'after:2025/03/01 OR from:x', 20250301]) {
    assert.throws(() => gas.reimportVpassSince(bad), /YYYY\/MM\/DD/, String(bad));
  }

  const busy = loadGas({ gmail: gmailWith([[message(mid(9), NEW_STACKED)]]), lockAvailable: false });
  assert.throws(() => busy.gas.reimportVpassSince('2025/03/01'), /lock/);
  assert.equal(busy.sheets.Yahoo_Data.rows.length, 1);

  // a concurrent run that imports the same message while this one waits is not duplicated
  const yahooData = [[...DATA_HEADER]];
  const race = loadGas({
    yahooData,
    gmail: gmailWith([[message(mid(10), NEW_STACKED)]]),
    onLock: () => yahooData.push(['2026/11/05', 'テスト商店', 150, '未分類', mid(10), 'ts', 'Expense', '']),
  });
  const raced = plain(race.gas.reimportVpassSince('2025/03/01'));
  assert.equal(raced.added, 0);
  assert.equal(raced.alreadyImported, 1);
  assert.equal(race.sheets.Yahoo_Data.rows.length, 2);
});

// Rows entered by hand while the parser was broken (MessageId manual_..., fixed_..., empty)
const manualRow = (date, amount, id = 'manual_1760000000000', merchant = '手入力の店名') => [date, merchant, amount, '食費', id, 'ts', 'Expense', ''];

test('a transaction matching a hand-entered row (same date and amount, any merchant) is skipped and counted', () => {
  const yahooData = [
    [...DATA_HEADER],
    manualRow('2026/11/05', 150),
  ];
  const threads = [
    [message(mid(20), NEW_STACKED)], // 2026/11/05 150 -> hand-entered
    [message(mid(21), 'ご利用日時：2026/11/06 08:15\n架空駅売店\n210円')], // -> hand-entered (Date cell)
    [message(mid(22), 'ご利用日時：2026/11/07 09:00\n架空薬局\n150円')], // other day -> added
  ];
  const { gas, sheets, logs } = loadGas({ yahooData, gmail: gmailWith(threads) });
  // a Date cell (as Sheets returns it, created in the script's realm) and no MessageId
  yahooData.push(manualRow(vm.runInContext('new Date(2026, 10, 6)', gas), 210, ''));
  const result = plain(gas.reimportVpassSince('2025/03/01'));
  assert.equal(result.matchedManual, 2);
  assert.equal(result.added, 1);
  assert.deepEqual(sheets.Yahoo_Data.rows.slice(3).map(r => [r[0], r[2], r[4]]), [['2026/11/07', 150, mid(22)]]);
  assert.ok(logs.some(line => line.includes('2 skipped as matching a hand-entered row')));
  // idempotent: the skipped ones stay skipped
  assert.equal(plain(gas.reimportVpassSince('2025/03/01')).added, 0);
  assert.equal(sheets.Yahoo_Data.rows.length, 4);
});

test('matching is one to one: two same-day same-amount payments with one hand-entered row import one', () => {
  const yahooData = [[...DATA_HEADER], manualRow('2026/11/05', 150)];
  const twice = 'ご利用日時：2026/11/05 10:00\n架空自販機\n150円\nご利用日時：2026/11/05 15:00\n架空自販機\n150円';
  const { gas, sheets } = loadGas({ yahooData, gmail: gmailWith([[message(mid(30), twice)]]) });
  const result = plain(gas.reimportVpassSince('2025/03/01'));
  assert.equal(result.matchedManual, 1);
  assert.equal(result.added, 1);
  assert.equal(sheets.Yahoo_Data.rows.length, 3);

  // across pages too: one hand-entered row absorbs one transaction of the whole run
  const pages = Array.from({ length: 101 }, (_, i) => [message(mid(100 + i), i === 0 || i === 100 ? 'ご利用日時：2026/11/05 10:00\n架空自販機\n150円' : `ご利用日時：2026/10/01\n架空店${i}\n${1000 + i}円`)]);
  const across = loadGas({ yahooData: [[...DATA_HEADER], manualRow('2026/11/05', 150)], gmail: gmailWith(pages) });
  const acrossResult = plain(across.gas.reimportVpassSince('2025/03/01'));
  assert.equal(acrossResult.matchedManual, 1);
  assert.equal(acrossResult.added, 100);
});

test('mail-imported rows, income rows and other amounts are not treated as hand-entered', () => {
  const yahooData = [
    [...DATA_HEADER],
    ['2026/11/05', '別の取込', 150, '食費', mid(40), 'ts', 'Expense', ''], // imported from another mail
    ['2026/11/05', '返金', 150, '収入', 'manual_1', 'ts', 'Income', ''],
    manualRow('2026/11/05', 151),
  ];
  const { gas } = loadGas({ yahooData, gmail: gmailWith([[message(mid(41), NEW_STACKED)]]) });
  const result = plain(gas.reimportVpassSince('2025/03/01'));
  assert.equal(result.matchedManual, 0);
  assert.equal(result.added, 1);
});

test('previewVpassReimport writes nothing, takes no lock and reports the same counts', () => {
  const yahooData = [[...DATA_HEADER], manualRow('2026/11/05', 320), ['2026/11/05', 'テスト商店', 150, '食費', mid(50), 'ts', 'Expense', '']];
  const threads = [[message(mid(50), NEW_STACKED)], [message(mid(51), MULTI)], [message(mid(52), 'お知らせのみ')]];
  const { gas, sheets, events, logs } = loadGas({ yahooData, gmail: gmailWith(threads) });
  const before = JSON.stringify(sheets.Yahoo_Data.rows);
  const preview = plain(gas.previewVpassReimport('2025/03/01'));
  assert.deepEqual(preview, {
    threads: 3, messages: 3, alreadyImportedMessages: 1, parsedMessages: 1, transactions: 2,
    alreadyImported: 0, matchedManual: 1, added: 0, wouldAdd: 1, complete: true, dryRun: true,
  });
  assert.equal(JSON.stringify(sheets.Yahoo_Data.rows), before, 'no write');
  assert.ok(!events.some(e => e.startsWith('write:') || e.startsWith('lock:') || e.startsWith('cache:put')), events.join(','));
  assert.ok(logs.some(line => line.includes('1 would be added')));
  for (const secret of ['架空パン屋', '架空食堂', '320', '1100', mid(51)]) assert.ok(logs.every(line => !line.includes(secret)));

  // the real run then does exactly that
  assert.equal(plain(gas.reimportVpassSince('2025/03/01')).added, preview.wouldAdd);
  assert.throws(() => gas.previewVpassReimport('2025-03-01'), /YYYY\/MM\/DD/);
});

test('the re-import stops after its time budget and continues on the next run (idempotent)', () => {
  const many = Array.from({ length: 250 }, (_, i) => [message(mid(500 + i), `ご利用日時：2026/09/01\n架空店${i}\n${100 + i}円`)]);
  const { gas, sheets, logs } = loadGas({ gmail: gmailWith(many) });
  const options = { now: () => clock.t, budgetMs: 50 * 1000 }; // each body read takes 1 s

  const run1 = plain(gas.reimportVpassSince('2025/03/01', options));
  assert.equal(run1.complete, false);
  assert.equal(run1.added, 100);
  assert.ok(logs.some(line => line.includes('run it again to continue')));

  const run2 = plain(gas.reimportVpassSince('2025/03/01', options));
  assert.equal(run2.alreadyImportedMessages, 100, 'imported mails are not read again');
  assert.equal(run2.added, 100);
  assert.equal(run2.complete, false);

  const run3 = plain(gas.reimportVpassSince('2025/03/01', options));
  assert.equal(run3.added, 50);
  assert.equal(run3.complete, true);
  assert.equal(sheets.Yahoo_Data.rows.length, 251);
  assert.equal(new Set(sheets.Yahoo_Data.rows.slice(1).map(r => r[4])).size, 250, 'no duplicates');
});

test('the argument-free wrappers start at 2025/03/01', () => {
  for (const name of ['reimportVpassSince202503', 'previewVpassReimport202503']) {
    const queries = [];
    const { gas } = loadGas({ gmail: gmailWith([], queries) });
    assert.equal(plain(gas[name]()).added, 0, name);
    assert.match(queries[0].query, /after:2025\/03\/01$/, name);
  }
});

// ---------------------------------------------------------------- debug helper

test('debugLatestVpassParse logs counts and yes/no checks only, never values', () => {
  const latest = [message('vp-old-in-thread', OLD_BODY), message('vp-latest', MULTI)];
  const { gas, logs } = loadGas({ gmail: gmailWith([latest, [message('vp-older', NEW_STACKED)]]) });
  const result = plain(gas.debugLatestVpassParse());
  assert.equal(result.count, 2, 'the newest message of the newest thread');
  assert.equal(result.format, 'new (ご利用日時)');
  assert.deepEqual(result.checks, [
    { hasDate: true, hasMerchant: true, amountIsNumber: true },
    { hasDate: true, hasMerchant: true, amountIsNumber: true },
  ]);
  for (const secret of ['架空パン屋', '架空食堂', '320', '1100', '2026/11/05', 'vp-latest']) {
    assert.ok(logs.every(line => !line.includes(secret)), `${secret}: ${logs.join(' | ')}`);
  }
  const none = loadGas({ gmail: gmailWith([]) });
  assert.equal(plain(none.gas.debugLatestVpassParse()).found, false);
  const unknown = loadGas({ gmail: gmailWith([[message('vp-u', '新しいお知らせ')]]) });
  assert.equal(plain(unknown.gas.debugLatestVpassParse()).format, 'none');
});
