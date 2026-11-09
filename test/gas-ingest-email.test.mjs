import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ingestEmail (design docs/design/2026-11-yuki-phase2-card-import.md §5, §8.1):
// card notices sent by the relay script, authenticated by INGEST_SECRET only,
// written to the yuki kakeibo with Ingest_Log. All secrets, ids, mail texts,
// merchants and amounts below are synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');

const KEY = 'dummyProxySecretForTests';
const AUTH_KEY = 'dummyAuthProxySecretForTests';
const INGEST = 'dummyIngestSecretForTests0123456789abcdef';
const DATA_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type', 'RowId'];
const CONFIG_HEADER = ['支払い先', '分類'];
const LOG_HEADER = ['id', 'source', 'receivedAt', 'processedAt', 'result', 'parsed', 'added', 'workerVersion'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hex64 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ID_A = hex64('mid:synthetic-a@example.invalid');
const ID_B = hex64('mid:synthetic-b@example.invalid');

// Synthetic bodies in the three supported layouts
const BODIES = {
  rakuten: ['■利用日: 2026/11/05', '■利用先: 架空マート', '■利用金額: 1,980円'].join('\n'),
  vpass: ['ご利用日時：2026/11/05 22:55', '架空商店（買物）', '150円'].join('\n'),
  jcb: ['【ご利用日時(日本時間)】 2026/11/06 10:00', '【ご利用金額】 3,000円', '【ご利用先】 架空ストア'].join('\n'),
};
const EXPECTED = {
  rakuten: [['2026/11/05', '架空マート', 1980]],
  vpass: [['2026/11/05', '架空商店', 150]],
  jcb: [['2026/11/06', '架空ストア', 3000]],
};

function createSheet(name, rows, events) {
  return {
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

const baseSheets = () => ({
  Data: [[...DATA_HEADER]],
  Config: [[...CONFIG_HEADER]],
  Yahoo_Data: [[...DATA_HEADER]],
  Yahoo_Config: [[...CONFIG_HEADER]],
  Yuki_Data: [[...DATA_HEADER]],
  Yuki_Config: [[...CONFIG_HEADER], ['架空マート', '食費'], ['架空ストア', '日用品']],
  Ingest_Log: [[...LOG_HEADER]],
});

function loadGas({ properties = {}, sheets = baseSheets(), lockAvailable = true } = {}) {
  const events = [];
  const logs = [];
  const sheetObjects = {};
  for (const [name, rows] of Object.entries(sheets)) sheetObjects[name] = createSheet(name, rows, events);
  const store = new Map();
  const props = { SHEET_ID: 'sheet-id', PROXY_SECRET: KEY, AUTH_PROXY_SECRET: AUTH_KEY, INGEST_SECRET: INGEST, INGEST_PARSER_YUKI: 'rakuten', ...properties };
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  const sandbox = {
    console: {
      log: (...a) => logs.push(`log:${a.join(' ')}`),
      warn: (...a) => logs.push(`warn:${a.join(' ')}`),
      error: (...a) => logs.push(`error:${a.join(' ')}`),
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (store.has(k) ? store.get(k) : null),
        getAll: keys => Object.fromEntries(keys.filter(k => store.has(k)).map(k => [k, store.get(k)])),
        put: (k, v) => { events.push(`cache:put:${k}`); store.set(k, String(v)); },
        putAll: values => Object.entries(values).forEach(([k, v]) => store.set(k, String(v))),
        remove: k => store.delete(k),
        removeAll: keys => keys.forEach(k => store.delete(k)),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { events.push('lock:try'); return lockAvailable; },
        releaseLock: () => events.push('lock:released'),
      }),
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: body => ({ body, setMimeType: () => ({ body }) }) },
    GmailApp: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => (Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null) }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: name => sheetObjects[name] || null,
        insertSheet: name => { events.push(`insert:${name}`); sheets[name] = []; sheetObjects[name] = createSheet(name, sheets[name], events); return sheetObjects[name]; },
      }),
      flush: () => events.push('flush'),
    },
    UrlFetchApp: {},
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => randomUUID(),
      computeDigest: (_a, value) => [...createHash('sha256').update(String(value), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      formatDate: d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  const raw = body => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(sheetObjects).map(([k, s]) => [k, s.rows])));
  return { gas: sandbox, events, logs, sheets: sheetObjects, store, props, raw, snapshot };
}

const message = (over = {}) => ({
  id: ID_A,
  receivedAt: '2026-11-05T22:56:00+09:00',
  subject: '架空の利用通知',
  text: BODIES.rakuten,
  html: '',
  ...over,
});
const ingestBody = (over = {}, msg = {}) => ({
  action: 'ingestEmail', ingestKey: INGEST, source: 'yuki', dryRun: false,
  message: message(msg), worker: { name: 'card-notice-relay', version: 'relay-v1' },
  ...over,
});
const writesTo = events => [...new Set(events.filter(e => e.startsWith('write:')).map(e => e.slice(6)))].sort();
const dataRows = env => env.sheets.Yuki_Data.rows.slice(1);
const logRows = env => env.sheets.Ingest_Log.rows.slice(1);

// ---------------------------------------------------------------- authentication

test('INGEST_SECRET unset, wrong, missing or not a string -> Unauthorized; nothing is read or written', () => {
  const cases = [
    [{ INGEST_SECRET: undefined }, {}],
    [{ INGEST_SECRET: '' }, { ingestKey: '' }],
    [{}, { ingestKey: 'wrongIngestSecretForTests0123456789abcdef' }],
    [{}, { ingestKey: undefined }],
    [{}, { ingestKey: 12345 }],
    [{}, { ingestKey: INGEST + 'x' }],
  ];
  for (const [properties, over] of cases) {
    const env = loadGas({ properties });
    const before = env.snapshot();
    const body = ingestBody(over);
    if (over.ingestKey === undefined && 'ingestKey' in over) delete body.ingestKey;
    assert.deepEqual(env.raw(body), { error: 'Unauthorized' }, JSON.stringify(over));
    assert.equal(env.snapshot(), before);
    assert.deepEqual(env.events.filter(e => e !== 'lock:released'), [], 'no lock, cache or sheet access');
  }
});

test('the proxy key (key / authKey) cannot call ingestEmail, even when it equals INGEST_SECRET', () => {
  const env = loadGas();
  const body = ingestBody({ key: KEY, authKey: AUTH_KEY });
  delete body.ingestKey;
  assert.deepEqual(env.raw(body), { error: 'Unauthorized' });
  const same = loadGas({ properties: { PROXY_SECRET: INGEST } });
  const b2 = ingestBody({ key: INGEST });
  delete b2.ingestKey;
  assert.deepEqual(same.raw(b2), { error: 'Unauthorized' });
  assert.equal(dataRows(env).length + dataRows(same).length, 0);
});

test('ingestKey cannot call any other action (it is not a proxy key)', () => {
  const env = loadGas();
  const before = env.snapshot();
  for (const action of ['addTransaction', 'deleteTransaction', 'updateCategory', 'authGetAdminUser', 'authPeekInvite']) {
    const result = env.raw({ action, ingestKey: INGEST, source: 'yuki', date: '2026/11/05', merchant: 'x', amount: 1 });
    assert.deepEqual(result, { error: 'Unauthorized' }, action);
  }
  assert.equal(env.snapshot(), before);
});

test('ingestEmail is dispatched before the PROXY_SECRET check and the actor check (yuki requiresActor)', () => {
  const env = loadGas();
  const result = env.raw(ingestBody());
  assert.deepEqual(result, { success: true, parsed: 1, added: 1 });
  // a LINE webhook payload is still handled first
  assert.deepEqual(env.raw({ destination: 'Uxxxxxxxx', events: [], action: 'ingestEmail' }), { success: true, ignored: 'lineWebhook' });
});

test('ingestEmail is not a proxy WRITE_ACTION (the browser proxy cannot forward it)', () => {
  const block = /const WRITE_ACTIONS = \[([^\]]*)\]/.exec(gasSource)[1];
  assert.ok(!block.includes('ingestEmail'));
  const proxy = fs.readFileSync(join(__dirname, '../lib/expenses-proxy.ts'), 'utf8');
  assert.ok(!proxy.includes('ingestEmail'));
});

// ---------------------------------------------------------------- source and parser settings

test('only yuki is accepted: main / yahoo / unknown -> Forbidden and Data / Yahoo_Data are never written', () => {
  for (const source of ['main', 'yahoo', 'Yuki', '', undefined, 'constructor', 'toString', ['yuki'], 1]) {
    const env = loadGas();
    const before = env.snapshot();
    const body = ingestBody({ source });
    assert.deepEqual(env.raw(body), { error: 'Forbidden' }, String(source));
    assert.equal(env.snapshot(), before);
  }
});

test('INGEST_PARSER_YUKI unset or unknown -> Forbidden', () => {
  for (const parser of [undefined, '', 'unknown', 'RAKUTEN', 'constructor', '__proto__', 'toString']) {
    const env = loadGas({ properties: { INGEST_PARSER_YUKI: parser } });
    assert.deepEqual(env.raw(ingestBody()), { error: 'Forbidden' }, String(parser));
    assert.equal(dataRows(env).length, 0);
  }
});

test('each configured parser reads its synthetic body; rows go to Yuki_Data with category, gm_ id and RowId', () => {
  for (const parser of ['rakuten', 'vpass', 'jcb']) {
    const env = loadGas({ properties: { INGEST_PARSER_YUKI: parser } });
    const result = env.raw(ingestBody({}, { text: BODIES[parser] }));
    assert.deepEqual(result, { success: true, parsed: 1, added: 1 }, parser);
    const rows = dataRows(env);
    assert.equal(rows.length, 1);
    const [date, merchant, amount, category, messageId, timestamp, type, rowId] = rows[0];
    assert.deepEqual([date, merchant, amount], EXPECTED[parser][0]);
    assert.equal(category, { rakuten: '食費', vpass: '未分類', jcb: '日用品' }[parser]);
    assert.equal(messageId, `gm_${ID_A.slice(0, 32)}`);
    assert.ok(timestamp instanceof Date || typeof timestamp === 'object');
    assert.equal(type, 'Expense');
    assert.match(rowId, UUID_PATTERN);
    assert.deepEqual(writesTo(env.events), ['Ingest_Log', 'Yuki_Data']);
  }
});

// ---------------------------------------------------------------- message format and limits

test('malformed messages -> InvalidMessage, nothing written', () => {
  const cases = [
    { id: 'abc' }, { id: ID_A.toUpperCase() }, { id: ID_A + '0' }, { id: 42 },
    { receivedAt: 'not a date' }, { receivedAt: '' }, { receivedAt: 1730000000 },
    { subject: 42 }, { text: 42 }, { html: {} },
  ];
  for (const over of cases) {
    const env = loadGas();
    const before = env.snapshot();
    assert.deepEqual(env.raw(ingestBody({}, over)), { error: 'InvalidMessage' }, JSON.stringify(over));
    assert.equal(env.snapshot(), before);
  }
  for (const body of [ingestBody({ message: null }), ingestBody({ message: 'x' }), ingestBody({ message: [] }), ingestBody({ dryRun: 'yes' })]) {
    const env = loadGas();
    assert.deepEqual(env.raw(body), { error: 'InvalidMessage' });
  }
});

test('INGEST_SUBJECT_INCLUDES_YUKI: a subject without the word -> InvalidMessage', () => {
  const env = loadGas({ properties: { INGEST_SUBJECT_INCLUDES_YUKI: '利用通知' } });
  assert.deepEqual(env.raw(ingestBody({}, { subject: '別の件名' })), { error: 'InvalidMessage' });
  assert.deepEqual(env.raw(ingestBody({}, { subject: undefined })), { error: 'InvalidMessage' });
  assert.deepEqual(env.raw(ingestBody({}, { subject: '架空の利用通知' })), { success: true, parsed: 1, added: 1 });
});

test('size limits: text / html over 200,000 or total over 450,000 characters -> TooLarge', () => {
  const big = n => 'あ'.repeat(n);
  for (const over of [{ text: big(200001) }, { html: big(200001) }, { text: big(200000), html: big(200000), subject: big(50001) }]) {
    const env = loadGas();
    assert.deepEqual(env.raw(ingestBody({}, over)), { error: 'TooLarge' });
    assert.equal(dataRows(env).length, 0);
  }
  const ok = loadGas();
  assert.equal(ok.raw(ingestBody({}, { text: `${BODIES.rakuten}\n${big(190000)}` })).success, true);
});

// Multi-transaction bodies for the parsers that read several transactions per mail
const MULTI = {
  rakuten: (n, at = i => `架空店${i}`) => Array.from({ length: n }, (_, i) => `■利用日: 2026/11/05\n■利用先: ${at(i)}\n■利用金額: ${100 + i}円`).join('\n'),
  vpass: (n, at = i => `架空店${i}`) => Array.from({ length: n }, (_, i) => `ご利用日時：2026/11/05 10:00\n${at(i)}\n${100 + i}円`).join('\n'),
};

test('more than 20 transactions in one mail -> InvalidMessage; 20 are accepted (every multi-transaction parser)', () => {
  for (const parser of Object.keys(MULTI)) {
    const env = loadGas({ properties: { INGEST_PARSER_YUKI: parser } });
    assert.deepEqual(env.raw(ingestBody({}, { text: MULTI[parser](21) })), { error: 'InvalidMessage' }, parser);
    assert.equal(dataRows(env).length, 0);
    assert.deepEqual(env.raw(ingestBody({}, { text: MULTI[parser](20) })), { success: true, parsed: 20, added: 20 }, parser);
  }
});

test('a bad date -> InvalidMessage, nothing written', () => {
  const env = loadGas();
  assert.deepEqual(env.raw(ingestBody({}, { text: '■利用日: 2026/13/05\n■利用先: 架空マート\n■利用金額: 100円' })), { error: 'InvalidMessage' });
  assert.equal(dataRows(env).length, 0);
});

test('a merchant starting with = + - @ is stored as text with a leading quote; the mail is imported', () => {
  for (const merchant of ['=HYPERLINK("x")', '+架空', '-架空', '@架空']) {
    const env = loadGas();
    const text = `■利用日: 2026/11/05\n■利用先: ${merchant}\n■利用金額: 100円`;
    assert.deepEqual(env.raw(ingestBody({}, { text })), { success: true, parsed: 1, added: 1 }, merchant);
    assert.equal(dataRows(env)[0][1], `'${merchant}`);
  }
});

// ---------------------------------------------------------------- parsing

// html part only, with decoy transactions in <head>/<title>, <style>, <script>
// and a comment, written in each parser's own layout
const HTML_BODIES = {
  rakuten: (d, m, a) => `<p>■利用日: ${d}</p><p>■利用先: ${m}</p><p>■利用金額: ${a}円</p>`,
  vpass: (d, m, a) => `<table><tr><td>ご利用日時：${d}&nbsp;22:55</td></tr><tr><td>${m}（買物）</td><td>${a}円</td></tr></table>`,
  jcb: (d, m, a) => `<div>【ご利用日時(日本時間)】 ${d} 10:00</div><div>【ご利用金額】 ${a}円</div><div>【ご利用先】 ${m}</div>`,
};

test('html only: <head>, <style>, <script> and comments are removed before parsing (every parser)', () => {
  for (const [parser, layout] of Object.entries(HTML_BODIES)) {
    const decoy = layout('2099/01/01', '偽店', 1);
    const html = [
      `<html><head><title>${decoy}</title><style>.x{content:"${decoy}"}</style></head>`,
      `<body><script>var s = "${decoy}";</script><!-- ${decoy} -->`,
      layout('2026/11/05', '架空商店', 150),
      '</body></html>',
    ].join('\n');
    const env = loadGas({ properties: { INGEST_PARSER_YUKI: parser } });
    assert.deepEqual(env.raw(ingestBody({}, { text: '', html })), { success: true, parsed: 1, added: 1 }, parser);
    assert.deepEqual(dataRows(env)[0].slice(0, 3), ['2026/11/05', '架空商店', 150], parser);
  }
});

test('html is used when the text part has no transaction (every parser)', () => {
  for (const [parser, layout] of Object.entries(HTML_BODIES)) {
    const env = loadGas({ properties: { INGEST_PARSER_YUKI: parser } });
    const html = layout('2026/11/06', '架空ストア', 3000);
    assert.deepEqual(env.raw(ingestBody({}, { text: 'テキストパートに明細なし', html })), { success: true, parsed: 1, added: 1 }, parser);
  }
});

test('a forwarding preamble is tolerated', () => {
  const text = ['---------- Forwarded message ---------', 'From: 架空 <sender@example.invalid>', 'Subject: 架空の利用通知', '', BODIES.rakuten].join('\n');
  const env = loadGas();
  assert.deepEqual(env.raw(ingestBody({}, { text })), { success: true, parsed: 1, added: 1 });
});

test('no transaction -> noItems recorded in Ingest_Log; the same id is a duplicate afterwards', () => {
  const env = loadGas();
  assert.deepEqual(env.raw(ingestBody({}, { text: 'ご利用ありがとうございます。', html: '<p>明細なし</p>' })), { success: true, parsed: 0, result: 'noItems' });
  assert.equal(dataRows(env).length, 0);
  const log = logRows(env);
  assert.equal(log.length, 1);
  assert.equal(log[0][0], ID_A);
  assert.equal(log[0][1], 'yuki');
  assert.equal(log[0][4], 'noItems');
  assert.deepEqual(env.raw(ingestBody()), { success: true, duplicate: true });
});

// ---------------------------------------------------------------- idempotency, lock, rate limit

test('Ingest_Log records id, source, times, result, counts and worker version only', () => {
  const env = loadGas();
  env.raw(ingestBody());
  const log = logRows(env);
  assert.equal(log.length, 1);
  const [id, source, receivedAt, processedAt, result, parsed, added, version] = log[0];
  assert.equal(id, ID_A);
  assert.equal(source, 'yuki');
  assert.equal(receivedAt, new Date('2026-11-05T22:56:00+09:00').toISOString());
  assert.ok(!Number.isNaN(Date.parse(processedAt)));
  assert.equal(result, 'added');
  assert.equal(parsed, 1);
  assert.equal(added, 1);
  assert.equal(version, 'relay-v1');
  const logText = JSON.stringify(env.sheets.Ingest_Log.rows);
  for (const secret of ['架空マート', '1980', '架空の利用通知', INGEST]) assert.ok(!logText.includes(secret), secret);
});

test('worker version is stored only when it is a short plain token', () => {
  for (const [version, stored] of [['relay-v1', 'relay-v1'], ['=cmd()', ''], ['x'.repeat(41), ''], [42, ''], [undefined, '']]) {
    const env = loadGas();
    env.raw(ingestBody({ worker: { name: 'card-notice-relay', version } }));
    assert.equal(logRows(env)[0][7], stored, String(version));
  }
});

test('the same id again -> duplicate; a deleted row is not revived; a new id is added', () => {
  const env = loadGas();
  assert.deepEqual(env.raw(ingestBody()), { success: true, parsed: 1, added: 1 });
  assert.deepEqual(env.raw(ingestBody()), { success: true, duplicate: true });
  env.sheets.Yuki_Data.rows.splice(1, 1); // the user deleted the row
  assert.deepEqual(env.raw(ingestBody()), { success: true, duplicate: true });
  assert.equal(dataRows(env).length, 0);
  assert.deepEqual(env.raw(ingestBody({}, { id: ID_B })), { success: true, parsed: 1, added: 1 });
  assert.equal(logRows(env).length, 2);
});

test('several transactions of one mail share the MessageId (every multi-transaction parser)', () => {
  for (const parser of Object.keys(MULTI)) {
    const env = loadGas({ properties: { INGEST_PARSER_YUKI: parser } });
    assert.deepEqual(env.raw(ingestBody({}, { text: MULTI[parser](2) })), { success: true, parsed: 2, added: 2 }, parser);
    const ids = dataRows(env).map(r => r[4]);
    assert.deepEqual(ids, [`gm_${ID_A.slice(0, 32)}`, `gm_${ID_A.slice(0, 32)}`]);
    assert.notEqual(dataRows(env)[0][7], dataRows(env)[1][7]);
  }
});

test('dryRun parses without writing, locking or logging the id', () => {
  const env = loadGas();
  const before = env.snapshot();
  assert.deepEqual(env.raw(ingestBody({ dryRun: true })), { success: true, dryRun: true, parsed: 1 });
  assert.equal(env.snapshot(), before);
  assert.ok(!env.events.includes('lock:try'));
  assert.deepEqual(env.raw(ingestBody({ dryRun: true }, { text: 'なし' })), { success: true, dryRun: true, parsed: 0 });
  // the real request afterwards still adds
  assert.deepEqual(env.raw(ingestBody()), { success: true, parsed: 1, added: 1 });
});

test('lock unavailable -> Busy, nothing written', () => {
  const env = loadGas({ lockAvailable: false });
  const before = env.snapshot();
  assert.deepEqual(env.raw(ingestBody()), { error: 'Busy' });
  assert.equal(env.snapshot(), before);
});

test('only the yuki cache is cleared on add', () => {
  const env = loadGas();
  env.store.set('kakeibo_main_gen', 'g-main');
  env.store.set('kakeibo_yahoo_gen', 'g-yahoo');
  env.store.set('kakeibo_yuki_gen', 'g-yuki');
  env.raw(ingestBody());
  assert.equal(env.store.get('kakeibo_main_gen'), 'g-main');
  assert.equal(env.store.get('kakeibo_yahoo_gen'), 'g-yahoo');
  assert.notEqual(env.store.get('kakeibo_yuki_gen'), 'g-yuki');
});

test('rate limit: 60 requests per 10 minutes, then RateLimited', () => {
  const env = loadGas();
  for (let i = 0; i < 60; i++) {
    const r = env.raw(ingestBody({ dryRun: true }));
    assert.equal(r.success, true, `request ${i}`);
  }
  assert.deepEqual(env.raw(ingestBody({ dryRun: true })), { error: 'RateLimited' });
  assert.deepEqual(env.raw(ingestBody()), { error: 'RateLimited' });
  assert.equal(dataRows(env).length, 0);
});

test('missing Yuki_Data or Ingest_Log -> Forbidden (setup not done), nothing written', () => {
  for (const missing of ['Yuki_Data', 'Ingest_Log']) {
    const sheets = baseSheets();
    delete sheets[missing];
    const env = loadGas({ sheets });
    const before = env.snapshot();
    assert.deepEqual(env.raw(ingestBody()), { error: 'Forbidden' }, missing);
    assert.equal(env.snapshot(), before);
  }
});

// ---------------------------------------------------------------- logs and editor function

test('logs never contain the body, merchant, amount, subject, id or secrets', () => {
  const env = loadGas({ properties: { INGEST_SUBJECT_INCLUDES_YUKI: '利用通知' } });
  env.raw(ingestBody());
  env.raw(ingestBody());
  env.raw(ingestBody({ ingestKey: 'wrongIngestSecretForTests0123456789abcdef' }));
  env.raw(ingestBody({}, { id: ID_B, subject: '別件' }));
  env.raw(ingestBody({ dryRun: true }, { id: ID_B }));
  const logs = env.logs.join('\n');
  for (const secret of ['架空マート', '1980', '1,980', '架空の利用通知', '利用通知', ID_A, ID_A.slice(0, 32), ID_B.slice(0, 16), INGEST, KEY, 'wrongIngestSecret']) {
    assert.ok(!logs.includes(secret), `log leaks ${secret.slice(0, 8)}`);
  }
});

test('an unexpected exception returns IngestError without details', () => {
  const env = loadGas();
  env.gas.getCategoryMap = () => { throw new Error('synthetic failure 架空マート'); };
  assert.deepEqual(env.raw(ingestBody()), { error: 'IngestError' });
  assert.ok(!env.logs.join('\n').includes('架空マート'));
});

test('setupIngestSheet creates Ingest_Log once and warns (without values) about missing or shared secrets', () => {
  const sheets = baseSheets();
  delete sheets.Ingest_Log;
  const env = loadGas({ sheets, properties: { INGEST_SECRET: KEY, INGEST_PARSER_YUKI: undefined } });
  const first = env.gas.setupIngestSheet();
  assert.equal(first.created, true);
  assert.deepEqual(env.sheets.Ingest_Log.rows[0], LOG_HEADER);
  const second = env.gas.setupIngestSheet();
  assert.equal(second.created, false);
  assert.equal(env.sheets.Ingest_Log.rows.length, 1);
  const logs = env.logs.join('\n');
  assert.match(logs, /same value as PROXY_SECRET/);
  assert.match(logs, /INGEST_PARSER_YUKI/);
  assert.ok(!logs.includes(KEY));

  const unset = loadGas({ properties: { INGEST_SECRET: undefined } });
  unset.gas.setupIngestSheet();
  assert.match(unset.logs.join('\n'), /INGEST_SECRET is not set/);
});
