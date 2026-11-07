import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// LINE linking (design 2026-11-yuki-and-passkeys §5.4, §8.4, §11 G4).
// Every id, token, name and key below is synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');

const KEY = 'dummy-proxy-secret-for-tests';
const AUTH_KEY = 'dummy-auth-proxy-secret-for-tests';
const TOKEN = 'dummy-line-channel-token';
const ORIGIN = 'https://kakeibo.example.test';
const LINE_YUKI = 'U' + 'a'.repeat(32);
const LINE_OTHER = 'U' + 'b'.repeat(32);
const lineUser = (n) => 'U' + String(n).padStart(32, 'c').slice(-32).replace(/[^0-9a-f]/g, 'c');
const DISPLAY_NAME = 'Dummy Display Name';
const MINUTE = 60 * 1000;
const CODE_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
const LINKS_HEADER = ['linkId', 'userId', 'source', 'codeHash', 'status', 'expiresAt', 'candidateExpiresAt', 'createdAt', 'resolvedAt'];

function createSheet(name, rows, events) {
  return {
    rows,
    getDataRange: () => {
      events.push(`read:${name}`);
      const width = Math.max(1, ...rows.map(r => r.length));
      return { getValues: () => rows.map(row => Array.from({ length: width }, (_, i) => (row[i] === undefined ? '' : row[i]))) };
    },
    getLastRow: () => rows.length,
    getMaxColumns: () => 26,
    insertColumnsAfter: () => {},
    getRange: (row, column, numRows = 1, numColumns = 1) => ({
      setValue: (value) => { events.push(`write:${name}`); (rows[row - 1] || (rows[row - 1] = []))[column - 1] = value; },
      setValues: (values) => {
        events.push(`write:${name}`);
        values.forEach((value, offset) => {
          const target = rows[row - 1 + offset] || (rows[row - 1 + offset] = []);
          value.forEach((cell, i) => { target[column - 1 + i] = cell; });
        });
      },
      getValues: () => rows.slice(row - 1, row - 1 + numRows).map(r => Array.from({ length: numColumns }, (_, i) => r[column - 1 + i] ?? '')),
    }),
    appendRow: (row) => { events.push(`write:${name}`); rows.push([...row]); },
  };
}

function loadGas({ profileStatus = 200 } = {}) {
  const events = [];
  const logs = [];
  const sheetObjects = {};
  const store = new Map();
  const props = {
    SHEET_ID: 'sheet-id', PROXY_SECRET: KEY, AUTH_PROXY_SECRET: AUTH_KEY, APP_ORIGIN: ORIGIN,
    LINE_CHANNEL_ACCESS_TOKEN: TOKEN, LINE_DESTINATION_MAIN: 'dummy-main-group', LINE_DESTINATION_YAHOO: 'dummy-yahoo-user',
  };
  const fetches = [];
  const clock = { now: Date.UTC(2026, 10, 8, 3, 0, 0) };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }
  const spreadsheet = {
    getSheetByName: (name) => sheetObjects[name] || null,
    insertSheet: (name) => { sheetObjects[name] = createSheet(name, [], events); return sheetObjects[name]; },
  };
  const sandbox = {
    Date: FakeDate,
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
        remove: (key) => store.delete(key),
        removeAll: (keys) => keys.forEach(k => store.delete(k)),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => { events.push('lock'); return true; }, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (body) => ({ body, setMimeType: () => ({ body }) }) },
    GmailApp: {},
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => props[key],
        setProperty: (key, value) => { events.push(`setProperty:${key}`); props[key] = value; },
      }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { openById: () => spreadsheet, flush: () => {} },
    UrlFetchApp: {
      fetch: (url, options = {}) => {
        fetches.push({ url, options });
        if (url.includes('/v2/bot/profile/')) {
          if (profileStatus === 'throw') throw new Error(`Exception: Request failed for ${url}`);
          return { getResponseCode: () => profileStatus, getContentText: () => (profileStatus === 200 ? JSON.stringify({ displayName: DISPLAY_NAME, userId: url.split('/').pop() }) : '{"message":"Not found"}') };
        }
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => randomUUID(),
      computeDigest: (_a, value) => [...createHash('sha256').update(String(value), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map(b => b & 0xff)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: (date) => date.toISOString(),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  sandbox.setupAuthSheets();
  const admin = JSON.parse(JSON.stringify(sandbox.listUsers())).find(u => u.role === 'admin');
  const yukiId = sandbox.addUser('Yuki', ['yuki', 'main'], 'yuki');
  const post = (payload, { authKey = AUTH_KEY } = {}) => JSON.parse(sandbox.doPost({
    postData: { contents: JSON.stringify({ key: KEY, ...(authKey === null ? {} : { authKey }), ...payload }) },
  }).body);
  const yuki = { actorUserId: yukiId, actorEpoch: 0 };
  const adminActor = { actorUserId: admin.userId, actorEpoch: 0 };
  const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(sheetObjects).map(([k, s]) => [k, s.rows])));
  return { gas: sandbox, events, logs, sheets: sheetObjects, store, props, fetches, clock, post, yuki, yukiId, adminActor, admin, snapshot };
}

const sha256hex = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex');
const createCode = (env, extra = {}) => env.post({ action: 'authCreateLineLinkCode', ...env.yuki, ...extra });
const link = (env, code, lineUserId = LINE_YUKI) => env.post({ action: 'authLinkLine', code, lineUserId });
const candidate = (env) => env.post({ action: 'authGetLineLinkCandidate', ...env.yuki });
const decide = (env, decision) => env.post({ action: 'authConfirmLineLink', ...env.yuki, decision });

// ---------------------------------------------------------------- code issuance

test('setupAuthSheets also creates Auth_LineLinks', () => {
  const env = loadGas();
  assert.deepEqual(env.sheets.Auth_LineLinks.rows[0], LINKS_HEADER);
});

test('a link code is 10 unambiguous characters, valid 10 minutes, stored only as a hash, for the user\'s own source', () => {
  const env = loadGas();
  const result = createCode(env);
  assert.equal(result.success, true);
  assert.match(result.code, CODE_PATTERN);
  assert.equal(result.source, 'yuki');
  assert.equal(Date.parse(result.expiresAt) - env.clock.now, 10 * MINUTE);
  const row = env.sheets.Auth_LineLinks.rows[1];
  assert.equal(row[1], env.yukiId);
  assert.equal(row[2], 'yuki');
  assert.equal(row[3], sha256hex(result.code));
  assert.equal(row[4], 'pending');
  assert.ok(!env.snapshot().includes(result.code), 'raw code not stored');
  assert.ok(!env.logs.some(l => l.includes(result.code)), 'code not logged');
  const codes = new Set(Array.from({ length: 30 }, () => createCode(env).code));
  assert.equal(codes.size, 30);
  for (const code of codes) assert.match(code, CODE_PATTERN, 'no 0 O 1 I l');
});

test('main / yahoo destinations can never be linked: admin has no linkable source, Yuki cannot pick main', () => {
  const env = loadGas();
  assert.deepEqual(env.post({ action: 'authCreateLineLinkCode', ...env.adminActor }), { error: 'Forbidden' });
  assert.deepEqual(env.post({ action: 'authCreateLineLinkCode', ...env.adminActor, source: 'main' }), { error: 'Forbidden' });
  assert.deepEqual(createCode(env, { source: 'main' }), { error: 'Forbidden' });
  assert.deepEqual(createCode(env, { source: 'yahoo' }), { error: 'Forbidden' });
  assert.deepEqual(createCode(env, { source: 'other' }), { error: 'Forbidden' });
  assert.equal(createCode(env, { source: 'yuki' }).source, 'yuki');
  assert.equal(env.sheets.Auth_LineLinks.rows.length, 2, 'only the yuki code was created');
});

test('a tampered link row for main is refused at confirmation and main\'s destination is untouched', () => {
  const env = loadGas();
  const { code } = createCode(env);
  assert.equal(link(env, code).success, true);
  env.sheets.Auth_LineLinks.rows[1][2] = 'main';
  assert.deepEqual(decide(env, 'confirm'), { error: 'Forbidden' });
  assert.equal(env.props.LINE_DESTINATION_MAIN, 'dummy-main-group');
  assert.equal(env.props.LINE_DESTINATION_YAHOO, 'dummy-yahoo-user');
  assert.equal(env.props.LINE_DESTINATION_YUKI, undefined);
  assert.ok(!env.events.some(e => e.startsWith('setProperty:')));
});

test('one code per user: a new code invalidates the previous one', () => {
  const env = loadGas();
  const first = createCode(env).code;
  const second = createCode(env).code;
  assert.deepEqual(link(env, first), { error: 'LinkCodeInvalid' });
  assert.equal(link(env, second).success, true);
});

test('a code expires after 10 minutes', () => {
  const env = loadGas();
  const { code } = createCode(env);
  env.clock.now += 10 * MINUTE;
  assert.deepEqual(link(env, code), { error: 'LinkCodeInvalid' });
});

test('a code links once: the same code from another LINE user is invalid', () => {
  const env = loadGas();
  const { code } = createCode(env);
  assert.deepEqual(link(env, code), { success: true });
  assert.deepEqual(link(env, code, LINE_OTHER), { error: 'LinkCodeInvalid' });
});

test('codes are matched case-insensitively after trimming; malformed input is rejected', () => {
  const env = loadGas();
  const { code } = createCode(env);
  for (const bad of [{ code: 'SHORT', lineUserId: LINE_YUKI }, { code, lineUserId: 'not-a-line-id' }, { code: 123, lineUserId: LINE_YUKI }, { code: code + 'X', lineUserId: LINE_YUKI }]) {
    assert.deepEqual(env.post({ action: 'authLinkLine', ...bad }), { error: 'Invalid input' }, JSON.stringify(bad));
  }
  assert.deepEqual(link(env, `  ${code.toLowerCase()} `), { success: true });
});

// ---------------------------------------------------------------- candidate and confirmation

test('a linked LINE account stays a candidate; the destination changes only on the user\'s confirmation', () => {
  const env = loadGas();
  assert.deepEqual(candidate(env), { success: true, status: 'none' });
  const { code } = createCode(env);
  assert.deepEqual(candidate(env).status, 'pending');
  assert.deepEqual(link(env, code), { success: true });
  assert.equal(env.props.LINE_DESTINATION_YUKI, undefined, 'not yet a destination');

  const shown = candidate(env);
  assert.equal(shown.status, 'candidate');
  assert.equal(shown.displayName, DISPLAY_NAME, 'from the LINE profile API');
  assert.equal(shown.source, 'yuki');
  const profileCall = env.fetches.find(f => f.url.includes('/v2/bot/profile/'));
  assert.equal(profileCall.url, `https://api.line.me/v2/bot/profile/${LINE_YUKI}`);
  assert.equal(profileCall.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(shown).includes(LINE_YUKI), 'the LINE userId is not returned');

  assert.deepEqual(decide(env, 'confirm'), { success: true, decision: 'confirm' });
  assert.equal(env.props.LINE_DESTINATION_YUKI, LINE_YUKI);
  assert.equal(env.props.LINE_DESTINATION_MAIN, 'dummy-main-group');
  assert.equal(env.props.LINE_DESTINATION_YAHOO, 'dummy-yahoo-user');
  const push = env.fetches.find(f => f.url.endsWith('/v2/bot/message/push'));
  assert.equal(JSON.parse(push.options.payload).to, LINE_YUKI, 'confirmation pushed to the linked account');
  assert.equal(env.sheets.Auth_LineLinks.rows[1][4], 'confirmed');
  assert.deepEqual(candidate(env), { success: true, status: 'none' });
  assert.deepEqual(decide(env, 'confirm'), { error: 'NoCandidate' });
});

test('cancel discards the candidate and the code', () => {
  const env = loadGas();
  const { code } = createCode(env);
  link(env, code);
  assert.deepEqual(decide(env, 'cancel'), { success: true, decision: 'cancel' });
  assert.equal(env.props.LINE_DESTINATION_YUKI, undefined);
  assert.equal(env.sheets.Auth_LineLinks.rows[1][4], 'cancelled');
  assert.deepEqual(candidate(env), { success: true, status: 'none' });
  assert.deepEqual(link(env, code), { error: 'LinkCodeInvalid' });
  assert.ok(![...env.store.values()].some(v => v.includes(LINE_YUKI)), 'candidate removed from the cache');
});

test('a candidate expires 10 minutes after linking', () => {
  const env = loadGas();
  const { code } = createCode(env);
  env.clock.now += 9 * MINUTE;
  link(env, code);
  env.clock.now += 9 * MINUTE;
  assert.equal(candidate(env).status, 'candidate', 'its own 10 minutes, not the code\'s');
  env.clock.now += 2 * MINUTE;
  assert.deepEqual(candidate(env), { success: true, status: 'none' });
  assert.deepEqual(decide(env, 'confirm'), { error: 'NoCandidate' });
  assert.equal(env.props.LINE_DESTINATION_YUKI, undefined);
});

test('a lost candidate (cache eviction) cannot be confirmed', () => {
  const env = loadGas();
  link(env, createCode(env).code);
  for (const key of [...env.store.keys()]) if (key.startsWith('kakeibo_line_candidate_')) env.store.delete(key);
  assert.deepEqual(decide(env, 'confirm'), { error: 'NoCandidate' });
  assert.equal(env.props.LINE_DESTINATION_YUKI, undefined);
});

test('a profile API failure is reported without exposing ids', () => {
  const env = loadGas({ profileStatus: 404 });
  link(env, createCode(env).code);
  assert.deepEqual(candidate(env), { error: 'ProfileUnavailable' });
  assert.ok(!env.logs.some(l => l.includes(LINE_YUKI) || l.includes(TOKEN)));
});

test('a profile API network failure does not log the request URL (LINE userId)', () => {
  const env = loadGas({ profileStatus: 'throw' });
  link(env, createCode(env).code);
  assert.deepEqual(candidate(env), { error: 'ProfileUnavailable' });
  assert.ok(!env.logs.some(l => l.includes(LINE_YUKI) || l.includes(TOKEN)));
});

test('invalid decisions, revoked sessions and missing authKey are refused', () => {
  const env = loadGas();
  link(env, createCode(env).code);
  assert.deepEqual(decide(env, 'maybe'), { error: 'Invalid input' });
  assert.deepEqual(env.post({ action: 'authConfirmLineLink', ...env.yuki, decision: 'confirm' }, { authKey: null }), { error: 'Unauthorized' });
  assert.deepEqual(env.post({ action: 'authLinkLine', code: 'ABCDEFGHJK', lineUserId: LINE_YUKI }, { authKey: null }), { error: 'Unauthorized' });
  assert.deepEqual(env.post({ action: 'authCreateLineLinkCode', ...env.yuki }, { authKey: null }), { error: 'Unauthorized' });
  env.gas.bumpEpoch('Yuki');
  assert.deepEqual(decide(env, 'confirm'), { error: 'SessionRevoked' });
  assert.deepEqual(candidate(env), { error: 'SessionRevoked' });
  assert.deepEqual(createCode(env), { error: 'SessionRevoked' });
  assert.equal(env.props.LINE_DESTINATION_YUKI, undefined);
});

test('the admin cannot see or confirm Yuki\'s candidate', () => {
  const env = loadGas();
  link(env, createCode(env).code);
  assert.deepEqual(env.post({ action: 'authGetLineLinkCandidate', ...env.adminActor }), { success: true, status: 'none' });
  assert.deepEqual(env.post({ action: 'authConfirmLineLink', ...env.adminActor, decision: 'confirm' }), { error: 'NoCandidate' });
  assert.equal(env.props.LINE_DESTINATION_YUKI, undefined);
});

// ---------------------------------------------------------------- failures and rate limits

test('3 failed attempts block that LINE user, without invalidating the real user\'s code', () => {
  const env = loadGas();
  const { code } = createCode(env);
  for (const guess of ['ZZZZZZZZZ2', 'ZZZZZZZZZ3', 'ZZZZZZZZZ4']) assert.deepEqual(link(env, guess, LINE_OTHER), { error: 'LinkCodeInvalid' });
  assert.deepEqual(link(env, code, LINE_OTHER), { error: 'RateLimited' }, 'the blocked user cannot even use a right code');
  assert.deepEqual(link(env, code, LINE_YUKI), { success: true }, 'Yuki\'s code is still valid');
});

test('per LINE user: at most 5 attempts per 10 minutes', () => {
  const env = loadGas();
  for (let i = 0; i < 5; i++) assert.deepEqual(link(env, createCode(env).code, LINE_YUKI), { success: true }, `attempt ${i + 1}`);
  const { code } = createCode(env);
  assert.deepEqual(link(env, code, LINE_YUKI), { error: 'RateLimited' });
  env.clock.now += 10 * MINUTE + 1000;
  assert.deepEqual(link(env, createCode(env).code, LINE_YUKI), { success: true }, 'allowed again after the window');
});

test('overall: at most 20 attempts per 10 minutes', () => {
  const env = loadGas();
  for (let i = 0; i < 20; i++) assert.deepEqual(link(env, 'ABCDEFGHJK', lineUser(i)), { error: 'LinkCodeInvalid' });
  const { code } = createCode(env);
  assert.deepEqual(link(env, code, LINE_YUKI), { error: 'RateLimited' }, 'over the global limit nothing is matched');
  env.clock.now += 10 * MINUTE + 1000;
  assert.deepEqual(link(env, code, LINE_YUKI), { error: 'LinkCodeInvalid' }, 'the code expired meanwhile');
  assert.deepEqual(link(env, createCode(env).code, LINE_YUKI), { success: true });
});

test('a rate-limited attempt is not matched (does not consume a code)', () => {
  const env = loadGas();
  for (let i = 0; i < 3; i++) link(env, 'ABCDEFGHJK', LINE_OTHER);
  const { code } = createCode(env);
  assert.deepEqual(link(env, code, LINE_OTHER), { error: 'RateLimited' });
  assert.equal(env.sheets.Auth_LineLinks.rows.at(-1)[4], 'pending');
});

test('no secret, code, LINE userId, display name or token appears in logs, sheets or cache keys', () => {
  const env = loadGas();
  const { code } = createCode(env);
  link(env, 'ABCDEFGHJK', LINE_OTHER);
  link(env, code);
  candidate(env);
  decide(env, 'confirm');
  const logs = env.logs.join('\n');
  for (const secret of [code, LINE_YUKI, LINE_OTHER, DISPLAY_NAME, TOKEN, KEY, AUTH_KEY, sha256hex(code)]) {
    assert.ok(!logs.includes(secret), `log leaks ${secret.slice(0, 6)}`);
  }
  const sheets = env.snapshot();
  for (const secret of [code, LINE_YUKI, LINE_OTHER, DISPLAY_NAME]) assert.ok(!sheets.includes(secret), `sheet leaks ${secret.slice(0, 6)}`);
  assert.ok(![...env.store.keys()].some(k => k.includes(LINE_YUKI) || k.includes(LINE_OTHER)), 'cache keys hash the LINE userId');
});
