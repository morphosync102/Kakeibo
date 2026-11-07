import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Actor verification and updateCategory scope (design 2026-11-yuki-and-passkeys
// §5.5, §5.7, §8.3/8.4, §11 G2). All ids, secrets and rows are synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');

const KEY = 'dummy-proxy-secret-for-tests';
const AUTH_KEY = 'dummy-auth-proxy-secret-for-tests';
const BOTH = { PROXY_SECRET: KEY, AUTH_PROXY_SECRET: AUTH_KEY };
const DATA_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type', 'RowId'];
const CONFIG_HEADER = ['支払い先', '分類'];
const FIXED_HEADER = ['Type', 'Name', 'Amount', 'Day', 'Category'];
const USERS_HEADER = ['userId', 'displayName', 'role', 'sources', 'homeSource', 'epoch', 'status', 'createdAt', 'updatedAt'];
const ADMIN = { actorUserId: 'u_dummyAdmin', actorEpoch: 2 };
const YUKI = { actorUserId: 'u_dummyYuki', actorEpoch: 5 };
const GONE = { actorUserId: 'u_dummyGone', actorEpoch: 1 };
const ROW_ID = '00000000-0000-4000-8000-000000000001';

const usersRows = () => [
  [...USERS_HEADER],
  ['u_dummyAdmin', '管理者', 'admin', 'main,yahoo', 'main', 2, 'active', 'ts', 'ts'],
  ['u_dummyYuki', 'Yuki', 'member', 'yuki, main', 'yuki', 5, 'active', 'ts', 'ts'],
  ['u_dummyGone', 'Gone', 'member', 'main', 'main', 1, 'disabled', 'ts', 'ts'],
];

const dataRow = (merchant, id) => ['2026/07/01', merchant, 100, '食費', id, 'ts', 'Expense', ROW_ID];
const allSheets = ({ users = usersRows() } = {}) => {
  const sheets = {
    Data: [[...DATA_HEADER], dataRow('Shared shop', 'm-1')],
    Config: [[...CONFIG_HEADER]],
    Fixed: [[...FIXED_HEADER], ['Expense', 'Rent', 1000, 1, '住居']],
    Yahoo_Data: [[...DATA_HEADER], dataRow('Shared shop', 'y-1')],
    Yahoo_Config: [[...CONFIG_HEADER]],
    Yahoo_Fixed: [[...FIXED_HEADER], ['Expense', 'Gym', 2000, 2, 'その他']],
    Yuki_Data: [[...DATA_HEADER], dataRow('Shared shop', 'k-1')],
    Yuki_Config: [[...CONFIG_HEADER]],
    Yuki_Fixed: [[...FIXED_HEADER], ['Expense', 'Phone', 3000, 3, '通信']],
  };
  if (users) sheets.Auth_Users = users;
  return sheets;
};

function createSheet(name, rows, events) {
  return {
    rows,
    getDataRange: () => { events.push(`read:${name}`); return { getValues: () => rows.map(row => [...row]) }; },
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

function loadGas({ sheets = allSheets(), properties = BOTH } = {}) {
  const events = [];
  const logs = [];
  const sheetObjects = {};
  for (const [name, rows] of Object.entries(sheets)) sheetObjects[name] = createSheet(name, rows, events);
  const store = new Map();
  const cacheFaults = { genPut: false };
  const props = { SHEET_ID: 'sheet-id', ...properties };
  const sandbox = {
    console: {
      log: () => {},
      warn: (...args) => logs.push(`warn:${args.join(' ')}`),
      error: (...args) => logs.push(`error:${args.join(' ')}`),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (store.has(key) ? store.get(key) : null),
        getAll: (keys) => Object.fromEntries(keys.filter(k => store.has(k)).map(k => [k, store.get(k)])),
        put: (key, value) => {
          if (cacheFaults.genPut && key === 'kakeibo_auth_users_gen') throw new Error('Synthetic cache put failure');
          events.push(`cache:put:${key}`);
          store.set(key, String(value));
        },
        putAll: (values) => Object.entries(values).forEach(([k, v]) => store.set(k, String(v))),
        remove: (key) => store.delete(key),
        removeAll: (keys) => keys.forEach(k => store.delete(k)),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (body) => ({ body, setMimeType: () => ({ body }) }),
    },
    GmailApp: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => props[key] }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (name) => sheetObjects[name] || null }), flush: () => events.push('flush') },
    UrlFetchApp: {},
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => randomUUID(),
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      formatDate: (date) => `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(sheetObjects).map(([k, s]) => [k, s.rows])));
  return { gas: sandbox, events, logs, sheets: sheetObjects, store, props, snapshot, cacheFaults };
}

// The new proxy (U2) adds authKey whenever it adds an actor; the old proxy
// only ever adds key. Requests with actor fields get authKey unless the test
// sets it (or `authKey: undefined`) explicitly.
const hasActor = (payload) => 'actorUserId' in payload || 'actorEpoch' in payload;
const withKeys = (payload) => ({ key: KEY, ...(hasActor(payload) ? { authKey: AUTH_KEY } : {}), ...payload });
const post = (gas, payload) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(withKeys(payload)) } }).body);
// doGet receives every query value as a string
const get = (gas, parameter = {}) => JSON.parse(gas.doGet({
  parameter: Object.fromEntries(Object.entries(withKeys(parameter)).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])),
}).body);
const writesTo = (events) => [...new Set(events.filter(e => e.startsWith('write:')).map(e => e.slice(6)))].sort();
const gens = (store) => ({ main: store.get('kakeibo_main_gen'), yahoo: store.get('kakeibo_yahoo_gen'), yuki: store.get('kakeibo_yuki_gen') });

function primeGens(store) {
  store.set('kakeibo_main_gen', 'g-main');
  store.set('kakeibo_yahoo_gen', 'g-yahoo');
  store.set('kakeibo_yuki_gen', 'g-yuki');
}

// One request per write action, each matching a row of the target sheet
const writeActions = (source) => [
  { action: 'addTransaction', source, date: '2026/07/05', merchant: 'New', amount: 1, category: '食費' },
  { action: 'updateTransaction', source, id: { main: 'm-1', yahoo: 'y-1', yuki: 'k-1' }[source], currentDate: '2026/07/01', currentMerchant: 'Shared shop', currentAmount: 100, amount: 150, rowId: ROW_ID },
  { action: 'updateTransactionDate', source, id: { main: 'm-1', yahoo: 'y-1', yuki: 'k-1' }[source], currentDate: '2026/07/01', date: '2026/07/02', merchant: 'Shared shop', amount: 100, rowId: ROW_ID },
  { action: 'deleteTransaction', source, id: { main: 'm-1', yahoo: 'y-1', yuki: 'k-1' }[source], date: '2026/07/01', merchant: 'Shared shop', amount: 100, rowId: ROW_ID },
  { action: 'addFixedCost', source, type: 'Expense', name: 'New fixed', amount: 10, day: 9, category: 'その他' },
  { action: 'deleteFixedCost', source, id: 0, ...{ main: { type: 'Expense', name: 'Rent', amount: 1000, day: 1 }, yahoo: { type: 'Expense', name: 'Gym', amount: 2000, day: 2 }, yuki: { type: 'Expense', name: 'Phone', amount: 3000, day: 3 } }[source] },
];
const SHEETS_OF = { main: ['Data', 'Fixed'], yahoo: ['Yahoo_Data', 'Yahoo_Fixed'], yuki: ['Yuki_Data', 'Yuki_Fixed'] };

// ---------------------------------------------------------------- §8.3 matrix (GAS part): reads

test('GET matrix: admin reads main / yahoo, Yuki reads yuki / main; everything else is Forbidden', () => {
  const { gas } = loadGas();
  const cases = [
    [ADMIN, 'main', true], [ADMIN, 'yahoo', true], [ADMIN, 'yuki', false],
    [YUKI, 'main', true], [YUKI, 'yahoo', false], [YUKI, 'yuki', true],
  ];
  for (const [actor, source, allowed] of cases) {
    for (const action of [undefined, 'getFixedCosts']) {
      const result = get(gas, { source, ...actor, ...(action ? { action } : {}) });
      const label = `${actor.actorUserId} ${source} ${action || 'list'}`;
      if (allowed) assert.ok(Array.isArray(result) && result.length === 1, label);
      else assert.deepEqual(result, { error: 'Forbidden' }, label);
    }
  }
  assert.equal(get(gas, { source: 'yuki', ...YUKI })[0].id, 'k-1', 'yuki reads Yuki_Data');
});

// ---------------------------------------------------------------- §8.3 matrix (GAS part): writes

test('POST matrix: every write action is allowed only on the actor\'s sources and touches only that source', () => {
  const cases = [
    [ADMIN, 'main', true], [ADMIN, 'yahoo', true], [ADMIN, 'yuki', false],
    [YUKI, 'main', true], [YUKI, 'yahoo', false], [YUKI, 'yuki', true],
  ];
  for (const [actor, source, allowed] of cases) {
    for (const payload of writeActions(source)) {
      const { gas, events, store, snapshot } = loadGas();
      primeGens(store);
      const before = snapshot();
      const result = post(gas, { ...payload, ...actor });
      const label = `${actor.actorUserId} ${payload.action} ${source}`;
      if (allowed) {
        assert.equal(result.success, true, `${label}: ${JSON.stringify(result)}`);
        const written = writesTo(events);
        assert.ok(written.length === 1 && SHEETS_OF[source].includes(written[0]), `${label}: wrote ${written}`);
        const after = gens(store);
        for (const other of ['main', 'yahoo', 'yuki']) {
          assert.equal(after[other] !== `g-${other}`, other === source, `${label}: ${other} cache`);
        }
      } else {
        assert.deepEqual(result, { error: 'Forbidden' }, label);
        assert.equal(snapshot(), before, `${label}: nothing written`);
        assert.deepEqual(gens(store), { main: 'g-main', yahoo: 'g-yahoo', yuki: 'g-yuki' }, `${label}: no cache cleared`);
      }
    }
  }
});

// ---------------------------------------------------------------- updateCategory (§5.5)

function categoryRun(actor, source) {
  const { gas, events, store, sheets } = loadGas();
  primeGens(store);
  const result = post(gas, { action: 'updateCategory', source, merchant: 'Shared shop', category: 'カフェ', ...(actor || {}) });
  const changed = gens(store);
  return {
    result,
    written: writesTo(events),
    cleared: Object.keys(changed).filter(k => changed[k] !== `g-${k}`).sort(),
    sheets,
  };
}

test('updateCategory: the category group of the source ∩ the actor\'s sources (§5.5 table)', () => {
  const cases = [
    { who: 'admin', actor: ADMIN, source: 'main', sheets: ['Config', 'Data', 'Yahoo_Config', 'Yahoo_Data'], cleared: ['main', 'yahoo'] },
    { who: 'admin', actor: ADMIN, source: 'yahoo', sheets: ['Config', 'Data', 'Yahoo_Config', 'Yahoo_Data'], cleared: ['main', 'yahoo'] },
    { who: 'Yuki', actor: YUKI, source: 'main', sheets: ['Config', 'Data'], cleared: ['main'] },
    { who: 'Yuki', actor: YUKI, source: 'yuki', sheets: ['Yuki_Config', 'Yuki_Data'], cleared: ['yuki'] },
    { who: 'no actor (old UI)', actor: null, source: 'main', sheets: ['Config', 'Data', 'Yahoo_Config', 'Yahoo_Data'], cleared: ['main', 'yahoo'] },
    { who: 'no actor (old UI)', actor: null, source: 'yahoo', sheets: ['Config', 'Data', 'Yahoo_Config', 'Yahoo_Data'], cleared: ['main', 'yahoo'] },
  ];
  for (const c of cases) {
    const run = categoryRun(c.actor, c.source);
    const label = `${c.who} on ${c.source}`;
    assert.equal(run.result.success, true, label);
    assert.deepEqual(run.written, c.sheets, `${label}: sheets written`);
    assert.deepEqual(run.cleared, c.cleared, `${label}: caches cleared`);
    for (const name of c.sheets.filter(n => n.endsWith('Data'))) assert.equal(run.sheets[name].rows[1][3], 'カフェ', `${label}: ${name}`);
    for (const name of c.sheets.filter(n => n.endsWith('Config'))) assert.deepEqual(run.sheets[name].rows.at(-1), ['Shared shop', 'カフェ'], `${label}: ${name}`);
  }
  for (const [actor, source] of [[ADMIN, 'yuki'], [YUKI, 'yahoo'], [null, 'yuki']]) {
    const run = categoryRun(actor, source);
    assert.deepEqual(run.result, { error: 'Forbidden' }, `${actor ? actor.actorUserId : 'no actor'} on ${source}`);
    assert.deepEqual(run.written, []);
    assert.deepEqual(run.cleared, []);
  }
});

test('Yuki changing a household category leaves Yahoo_Data / Yahoo_Config and the yahoo cache untouched', () => {
  const run = categoryRun(YUKI, 'main');
  assert.equal(run.sheets.Yahoo_Data.rows[1][3], '食費');
  assert.deepEqual(run.sheets.Yahoo_Config.rows, [CONFIG_HEADER]);
  assert.equal(run.sheets.Yuki_Data.rows[1][3], '食費', 'yuki is in another group');
  assert.ok(!run.cleared.includes('yahoo'));
});

// ---------------------------------------------------------------- revocation

test('epoch mismatch, unknown user and disabled user get SessionRevoked and nothing is read or written', () => {
  const cases = [
    { ...ADMIN, actorEpoch: 1 },
    { ...ADMIN, actorEpoch: 3 },
    { ...YUKI, actorEpoch: '4' },
    { actorUserId: 'u_dummyNobody', actorEpoch: 0 },
    GONE,
  ];
  for (const actor of cases) {
    const { gas, events, snapshot } = loadGas();
    const before = snapshot();
    const label = JSON.stringify(actor);
    assert.deepEqual(get(gas, { source: 'main', ...actor }), { error: 'SessionRevoked' }, `GET ${label}`);
    assert.deepEqual(post(gas, { ...writeActions('main')[0], ...actor }), { error: 'SessionRevoked' }, `POST ${label}`);
    assert.deepEqual(post(gas, { action: 'updateCategory', source: 'main', merchant: 'Shared shop', category: 'x', ...actor }), { error: 'SessionRevoked' });
    assert.equal(snapshot(), before);
    assert.ok(!events.some(e => /^read:(Data|Yahoo_Data|Fixed)/.test(e)), `${label}: no data sheet read`);
  }
});

test('an epoch sent as a query string matches the numeric epoch in the sheet', () => {
  const { gas } = loadGas();
  assert.equal(get(gas, { source: 'main', actorUserId: 'u_dummyAdmin', actorEpoch: '2' }).length, 1);
});

test('malformed actor fields are rejected with Invalid actor', () => {
  const { gas, snapshot } = loadGas();
  const before = snapshot();
  const bad = [
    { actorUserId: 'u_dummyAdmin' },
    { actorEpoch: 2 },
    { actorUserId: 'u_dummyAdmin', actorEpoch: 'x' },
    { actorUserId: 'u_dummyAdmin', actorEpoch: -1 },
    { actorUserId: 'u_dummyAdmin', actorEpoch: 2.5 },
    { actorUserId: 'u dummy', actorEpoch: 2 },
    { actorUserId: 'a'.repeat(65), actorEpoch: 2 },
    { actorUserId: ['u_dummyAdmin'], actorEpoch: 2 },
  ];
  for (const actor of bad) {
    assert.deepEqual(post(gas, { ...writeActions('main')[0], ...actor }), { error: 'Invalid actor' }, JSON.stringify(actor));
  }
  assert.deepEqual(get(gas, { source: 'main', actorUserId: 'u_dummyAdmin' }), { error: 'Invalid actor' });
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- AUTHZ_ENFORCE / PROXY_SECRET (migration)

test('AUTHZ_ENFORCE unset: requests without actor keep working for main / yahoo (old UI), yuki is Forbidden', () => {
  const { gas, sheets } = loadGas();
  assert.equal(get(gas).length, 1);
  assert.equal(get(gas, { source: 'yahoo' }).length, 1);
  assert.equal(post(gas, writeActions('main')[0]).success, true);
  assert.equal(post(gas, writeActions('yahoo')[0]).success, true);
  assert.deepEqual(get(gas, { source: 'yuki' }), { error: 'Forbidden' });
  assert.deepEqual(post(gas, writeActions('yuki')[0]), { error: 'Forbidden' });
  assert.equal(sheets.Yuki_Data.rows.length, 2);
});

test('AUTHZ_ENFORCE=1: every data request needs an actor; with one the matrix applies as before', () => {
  const { gas, snapshot } = loadGas({ properties: { ...BOTH, AUTHZ_ENFORCE: '1' } });
  const before = snapshot();
  for (const source of [undefined, 'main', 'yahoo', 'yuki']) {
    const params = source ? { source } : {};
    assert.deepEqual(get(gas, params), { error: 'Forbidden' }, `GET ${source}`);
    assert.deepEqual(post(gas, { ...writeActions(source || 'main')[0], ...params }), { error: 'Forbidden' }, `POST ${source}`);
    assert.deepEqual(post(gas, { action: 'updateCategory', merchant: 'Shared shop', category: 'x', ...params }), { error: 'Forbidden' });
  }
  assert.equal(snapshot(), before);
  assert.equal(get(gas, { source: 'main', ...ADMIN }).length, 1);
  assert.equal(get(gas, { source: 'yuki', ...YUKI }).length, 1);
  assert.deepEqual(get(gas, { source: 'yahoo', ...YUKI }), { error: 'Forbidden' });
});

test('AUTHZ_ENFORCE values other than "1" keep the migration behaviour', () => {
  for (const value of ['', '0', 'true', 'yes']) {
    const { gas } = loadGas({ properties: { ...BOTH, AUTHZ_ENFORCE: value } });
    assert.equal(get(gas).length, 1, `AUTHZ_ENFORCE=${JSON.stringify(value)}`);
  }
});

test('an actor is trusted only after the PROXY_SECRET check: unset secret + actor -> Unauthorized', () => {
  const { gas, snapshot, events } = loadGas({ properties: {} });
  const before = snapshot();
  assert.deepEqual(get(gas, { source: 'yuki', ...YUKI }), { error: 'Unauthorized' });
  assert.deepEqual(get(gas, { source: 'main', ...ADMIN }), { error: 'Unauthorized' });
  assert.deepEqual(post(gas, { ...writeActions('yuki')[0], ...YUKI }), { error: 'Unauthorized' });
  assert.equal(snapshot(), before);
  assert.ok(!events.includes('read:Auth_Users'), 'the user table is not even consulted');
  // Old UI (no actor) still works during the migration period; yuki never does
  assert.equal(get(gas).length, 1);
  assert.deepEqual(get(gas, { source: 'yuki' }), { error: 'Forbidden' });
});

test('an actor is trusted only with authKey (the old proxy forwards bodies but only ever adds key)', () => {
  const { gas, snapshot, events, logs } = loadGas();
  const before = snapshot();
  const keyOnly = { authKey: undefined };
  for (const authKey of [undefined, '', 'wrong', KEY, AUTH_KEY + 'x', 123]) {
    const label = `authKey ${JSON.stringify(authKey)}`;
    assert.deepEqual(get(gas, { source: 'yuki', ...YUKI, ...keyOnly, ...(authKey === undefined ? {} : { authKey }) }), { error: 'Unauthorized' }, `GET ${label}`);
    assert.deepEqual(get(gas, { source: 'main', ...ADMIN, ...keyOnly, ...(authKey === undefined ? {} : { authKey }) }), { error: 'Unauthorized' }, `GET main ${label}`);
    assert.deepEqual(post(gas, { ...writeActions('yuki')[0], ...YUKI, authKey }), { error: 'Unauthorized' }, `POST ${label}`);
    assert.deepEqual(post(gas, { action: 'updateCategory', source: 'main', merchant: 'Shared shop', category: 'x', ...YUKI, authKey }), { error: 'Unauthorized' }, `updateCategory ${label}`);
  }
  // A single actor field is enough to require authKey
  assert.deepEqual(post(gas, { ...writeActions('main')[0], actorUserId: 'u_dummyAdmin', authKey: undefined }), { error: 'Unauthorized' });
  assert.equal(snapshot(), before, 'nothing written');
  assert.ok(!events.some(e => e.startsWith('read:')), 'nothing read');
  assert.ok(!logs.some(l => l.includes(AUTH_KEY) || l.includes(KEY)), 'keys never logged');
  // With the right authKey the actor is checked as usual
  assert.ok(Array.isArray(get(gas, { source: 'yuki', ...YUKI })));
});

test('without AUTH_PROXY_SECRET every actor request is Unauthorized; requests without actor are unaffected', () => {
  const { gas, snapshot } = loadGas({ properties: { PROXY_SECRET: KEY } });
  const before = snapshot();
  assert.deepEqual(get(gas, { source: 'yuki', ...YUKI }), { error: 'Unauthorized' });
  assert.deepEqual(post(gas, { ...writeActions('main')[0], ...ADMIN }), { error: 'Unauthorized' });
  assert.equal(snapshot(), before);
  assert.equal(get(gas).length, 1);
  assert.equal(post(gas, writeActions('yahoo')[0]).success, true);
});

test('authKey is a separate field even when AUTH_PROXY_SECRET has the same value as PROXY_SECRET', () => {
  const { gas, snapshot } = loadGas({ properties: { PROXY_SECRET: KEY, AUTH_PROXY_SECRET: KEY } });
  const before = snapshot();
  // The old proxy sends key=<PROXY_SECRET> only: never accepted as authKey
  assert.deepEqual(post(gas, { ...writeActions('yuki')[0], ...YUKI, authKey: undefined }), { error: 'Unauthorized' });
  assert.equal(snapshot(), before);
  assert.ok(Array.isArray(get(gas, { source: 'yuki', ...YUKI, authKey: KEY })));
});

test('a forged actor with a wrong key is Unauthorized before anything else', () => {
  const { gas, events } = loadGas();
  const body = { ...writeActions('yuki')[0], ...YUKI, key: 'wrong' };
  assert.deepEqual(JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).body), { error: 'Unauthorized' });
  assert.ok(!events.some(e => e.startsWith('read:')));
});

// ---------------------------------------------------------------- user table (boundary with G3)

test('without the Auth_Users sheet (before setupAuthSheets) actor requests fail closed; old UI is unaffected', () => {
  const { gas, logs, store } = loadGas({ sheets: allSheets({ users: null }) });
  assert.deepEqual(get(gas, { source: 'main', ...ADMIN }), { error: 'AuthUnavailable' });
  assert.deepEqual(post(gas, { ...writeActions('yuki')[0], ...YUKI }), { error: 'AuthUnavailable' });
  assert.ok(logs.some(l => l.startsWith('error:') && l.includes('Auth_Users')));
  assert.ok(![...store.keys()].some(k => k.startsWith('kakeibo_auth_users_v1')), 'absence is not cached');
  assert.equal(get(gas).length, 1);
  assert.equal(post(gas, writeActions('yahoo')[0]).success, true);
});

test('an Auth_Users sheet without a required column fails closed', () => {
  const users = usersRows().map(row => row.filter((_, i) => i !== 5)); // drop epoch
  const { gas } = loadGas({ sheets: allSheets({ users }) });
  assert.deepEqual(get(gas, { source: 'main', ...ADMIN }), { error: 'AuthUnavailable' });
});

test('columns are found by header name, sources are trimmed, unknown source names ignored', () => {
  const users = [
    ['status', 'epoch', 'sources', 'userId'],
    ['active', '7', ' yuki ,  main , Yahoo, other', 'u_dummyReordered'],
  ];
  const { gas } = loadGas({ sheets: allSheets({ users }) });
  const actor = { actorUserId: 'u_dummyReordered', actorEpoch: 7 };
  assert.equal(get(gas, { source: 'yuki', ...actor }).length, 1);
  assert.equal(get(gas, { source: 'main', ...actor }).length, 1);
  assert.deepEqual(get(gas, { source: 'yahoo', ...actor }), { error: 'Forbidden' });
});

test('a duplicated userId is not trusted at all; invalid rows are ignored without logging cell values', () => {
  const users = [
    ...usersRows(),
    ['u_dummyYuki', 'Copy', 'member', 'yuki,main,yahoo', 'yuki', 5, 'active', 'ts', 'ts'],
    ['u_dummyBadEpoch', 'Bad', 'member', 'main', 'main', 'abc', 'active', 'ts', 'ts'],
    ['__proto__', 'Proto', 'member', 'main', 'main', 0, 'active', 'ts', 'ts'],
  ];
  const { gas, logs } = loadGas({ sheets: allSheets({ users }) });
  assert.deepEqual(get(gas, { source: 'yuki', ...YUKI }), { error: 'SessionRevoked' });
  assert.deepEqual(get(gas, { source: 'main', actorUserId: 'u_dummyBadEpoch', actorEpoch: 0 }), { error: 'SessionRevoked' });
  assert.equal(get(gas, { source: 'main', actorUserId: '__proto__', actorEpoch: 0 }).length, 1, '"__proto__" is an ordinary id');
  assert.equal(get(gas, { source: 'main', ...ADMIN }).length, 1);
  assert.ok(!logs.some(l => l.includes('u_dummyYuki') || l.includes('Copy')), 'no cell values in logs');
});

test('the user table is served from the Script Cache; clearAuthUsersCache makes changes visible', () => {
  const { gas, events, sheets } = loadGas();
  const userReads = () => events.filter(e => e === 'read:Auth_Users').length;
  assert.equal(get(gas, { source: 'main', ...ADMIN }).length, 1);
  assert.equal(post(gas, { ...writeActions('main')[0], ...ADMIN }).success, true);
  assert.equal(get(gas, { source: 'yahoo', ...ADMIN }).length, 1);
  assert.equal(userReads(), 1, 'the sheet is read once, then the cache is used');

  sheets.Auth_Users.rows[1][5] = 3; // bumpEpoch (G3) would do this and clear the cache
  gas.clearAuthUsersCache();
  assert.deepEqual(get(gas, { source: 'main', ...ADMIN }), { error: 'SessionRevoked' });
  assert.ok(Array.isArray(get(gas, { source: 'main', ...ADMIN, actorEpoch: 3 })), 'the new epoch is accepted');
  assert.equal(userReads(), 2);
});

test('a userId repeated on an invalid row also disables the valid row (fail closed)', () => {
  const cases = [
    ['bad epoch', ['u_dummyYuki', 'Copy', 'member', 'yuki,main', 'yuki', 'abc', 'active', 'ts', 'ts']],
    ['empty epoch', ['u_dummyYuki', 'Copy', 'member', 'yuki,main', 'yuki', '', 'disabled', 'ts', 'ts']],
    ['padded id', ['  u_dummyYuki ', 'Copy', 'member', 'yuki,main', 'yuki', 5, 'active', 'ts', 'ts']],
  ];
  for (const [label, extra] of cases) {
    for (const users of [[...usersRows(), extra], [usersRows()[0], extra, ...usersRows().slice(1)]]) {
      const { gas } = loadGas({ sheets: allSheets({ users }) });
      assert.deepEqual(get(gas, { source: 'yuki', ...YUKI }), { error: 'SessionRevoked' }, `${label}: either row order`);
      assert.ok(Array.isArray(get(gas, { source: 'main', ...ADMIN })), `${label}: other users unaffected`);
    }
  }
});

// ---------------------------------------------------------------- user table cache generation

test('clearAuthUsersCache flushes pending sheet writes before rotating the generation', () => {
  const { gas, events, store } = loadGas();
  get(gas, { source: 'main', ...ADMIN }); // creates the generation and caches the table
  const before = store.get('kakeibo_auth_users_gen');
  const mark = events.length;
  assert.equal(gas.clearAuthUsersCache(), true);
  const after = events.slice(mark);
  const flush = after.indexOf('flush');
  const rotate = after.indexOf('cache:put:kakeibo_auth_users_gen');
  assert.ok(flush !== -1 && rotate > flush, `flush before rotation: ${after.join(', ')}`);
  assert.notEqual(store.get('kakeibo_auth_users_gen'), before);
  assert.equal(store.has(`kakeibo_auth_users_v1_${before}`), false, 'previous table removed');
});

test('a read that overlaps an Auth_Users write never caches the old table', () => {
  const { gas, sheets, events, store } = loadGas();
  const sheet = sheets.Auth_Users;
  const original = sheet.getDataRange;
  let raced = false;
  sheet.getDataRange = () => {
    const values = original().getValues(); // read before the write below
    const stale = { getValues: () => values };
    if (!raced) {
      raced = true;
      // An editor function (G3 bumpEpoch) writes and invalidates meanwhile
      sheet.rows[1][5] = 3;
      gas.clearAuthUsersCache();
    }
    return stale;
  };
  // The racing request itself saw the old sheet, as any read may
  assert.ok(Array.isArray(get(gas, { source: 'main', ...ADMIN })));
  // ...and stored nothing: no table under any generation (the old one is dead,
  // the live one was created after the read started)
  assert.ok(![...store.keys()].some(k => k.startsWith('kakeibo_auth_users_v1_')), 'the old table is not stored');
  // ...but did not store it: the next request reads the new epoch
  assert.deepEqual(get(gas, { source: 'main', ...ADMIN }), { error: 'SessionRevoked' });
  assert.ok(Array.isArray(get(gas, { source: 'main', ...ADMIN, actorEpoch: 3 })));
  assert.equal(events.filter(e => e === 'read:Auth_Users').length, 2, 'the fresh table is cached afterwards');
});

test('if the generation cannot be rotated, the current table is removed instead (never throws)', () => {
  const { gas, sheets, store, cacheFaults } = loadGas();
  get(gas, { source: 'main', ...ADMIN });
  const gen = store.get('kakeibo_auth_users_gen');
  assert.ok(store.has(`kakeibo_auth_users_v1_${gen}`));
  cacheFaults.genPut = true;
  sheets.Auth_Users.rows[1][5] = 3;
  assert.equal(gas.clearAuthUsersCache(), false);
  assert.equal(store.has(`kakeibo_auth_users_v1_${gen}`), false);
  assert.deepEqual(get(gas, { source: 'main', ...ADMIN }), { error: 'SessionRevoked' });
});

test('clearAuthUsersCache never throws when the cache service fails', () => {
  const { gas } = loadGas();
  gas.CacheService.getScriptCache = () => { throw new Error('Synthetic cache failure'); };
  assert.doesNotThrow(() => gas.clearAuthUsersCache());
  assert.equal(gas.clearAuthUsersCache(), false);
  // Without a cache the user table is still read from the sheet
  const table = gas.getAuthUsers();
  assert.equal(table.error, undefined);
  assert.equal(table.users.u_dummyAdmin.epoch, 2);
});

test('time-driven functions are not affected by AUTHZ_ENFORCE or the user table', () => {
  const { gas, events } = loadGas({ sheets: allSheets({ users: null }), properties: { ...BOTH, AUTHZ_ENFORCE: '1' } });
  assert.doesNotThrow(() => gas.processFixedCosts());
  assert.ok(!events.includes('read:Auth_Users'));
});
