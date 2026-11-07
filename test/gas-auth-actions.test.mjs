import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Auth sheets, auth actions and editor functions (design 2026-11-yuki-and-passkeys
// §3.3-3.10, §5.6, §8.4, §11 G3). Every id, key, token and origin is synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasSource = fs.readFileSync(join(__dirname, '../gas/コード.js'), 'utf8');

const KEY = 'dummy-proxy-secret-for-tests';
const AUTH_KEY = 'dummy-auth-proxy-secret-for-tests';
const ORIGIN = 'https://kakeibo.example.test';
const USERS_HEADER = ['userId', 'displayName', 'role', 'sources', 'homeSource', 'epoch', 'status', 'createdAt', 'updatedAt'];
const CREDENTIALS_HEADER = ['credentialId', 'userId', 'publicKey', 'counter', 'transports', 'deviceType', 'backedUp', 'label', 'createdAt', 'lastUsedAt', 'revokedAt'];
const INVITES_HEADER = ['inviteId', 'tokenHash', 'userId', 'purpose', 'expiresAt', 'createdBy', 'usedAt'];
const HOUR = 3600 * 1000;

const sha256hex = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const hashOf = (n) => sha256hex(`synthetic-challenge-${n}`);
const b64u = (n) => Buffer.from(`synthetic-${n}`).toString('base64url');
// A credential id that starts with "-" (valid base64url, dangerous as a sheet value)
const DASH_ID = '-' + b64u('dash');

function credential(n, overrides = {}) {
  return {
    credentialId: b64u(`cred-${n}`),
    publicKey: b64u(`public-key-${n}`),
    counter: 0,
    transports: ['internal', 'hybrid'],
    deviceType: 'multiDevice',
    backedUp: true,
    label: 'iPhone',
    ...overrides,
  };
}

function createSheet(name, rows, events) {
  const sheet = {
    name,
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
      getValues: () => rows.slice(row - 1, row - 1 + numRows)
        .map(r => Array.from({ length: numColumns }, (_, i) => (r[column - 1 + i] === undefined ? '' : r[column - 1 + i]))),
      setValue: (value) => {
        events.push(`write:${name}`);
        const target = rows[row - 1] || (rows[row - 1] = []);
        target[column - 1] = value;
      },
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
  return sheet;
}

function loadGas({ sheets = {}, properties = { PROXY_SECRET: KEY, AUTH_PROXY_SECRET: AUTH_KEY, APP_ORIGIN: ORIGIN }, lockAvailable = true } = {}) {
  const events = [];
  const logs = [];
  const sheetObjects = {};
  for (const [name, rows] of Object.entries(sheets)) sheetObjects[name] = createSheet(name, rows, events);
  const store = new Map();
  const ttls = new Map();
  const props = { SHEET_ID: 'sheet-id', ...properties };
  const clock = { now: Date.UTC(2026, 10, 8, 3, 0, 0) };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }
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
        put: (key, value, ttl) => { events.push(`cache:put:${key}`); ttls.set(key, ttl); store.set(key, String(value)); },
        putAll: (values) => Object.entries(values).forEach(([k, v]) => store.set(k, String(v))),
        remove: (key) => store.delete(key),
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
    GmailApp: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => props[key] }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { openById: () => spreadsheet, flush: () => events.push('flush') },
    UrlFetchApp: {},
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => randomUUID(),
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      // Apps Script: web-safe alphabet with "=" padding, input as (signed) bytes
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map(b => b & 0xff)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: (date) => date.toISOString(),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(sheetObjects).map(([k, s]) => [k, s.rows])));
  return { gas: sandbox, events, logs, sheets: sheetObjects, store, ttls, props, clock, snapshot };
}

// Auth actions come only from the new /api/auth/* routes, which add both keys
// Pass NO_AUTH_KEY to send the body without authKey (as the old proxy does)
const NO_AUTH_KEY = Symbol('no authKey');
const post = (gas, payload, key = KEY, authKey = AUTH_KEY) => JSON.parse(gas.doPost({
  postData: { contents: JSON.stringify({ key, ...(authKey === NO_AUTH_KEY ? {} : { authKey }), ...payload }) },
}).body);
const plain = (value) => JSON.parse(JSON.stringify(value));

// A ready system: auth sheets with the admin, Yuki added, one admin passkey
function ready({ adminPasskey = true } = {}) {
  const env = loadGas();
  env.gas.setupAuthSheets();
  const admin = plain(env.gas.listUsers()).find(u => u.role === 'admin');
  const yukiId = env.gas.addUser('Yuki', ['yuki', 'main'], 'yuki');
  if (adminPasskey) {
    assert.equal(post(env.gas, { action: 'authAddCredential', actorUserId: admin.userId, actorEpoch: admin.epoch, challengeHash: hashOf('admin-boot'), credential: credential('admin'), bootstrap: true }).success, true);
  }
  return { ...env, admin, yukiId };
}

// Creates an invite and returns the raw token, read from the execution log only
function invite(env, user, purpose = 'register') {
  const mark = env.logs.length;
  const result = plain(env.gas.createInvite(user, purpose));
  const line = env.logs.slice(mark).find(l => l.includes(`${ORIGIN}/invite#`));
  assert.ok(line, 'the invite URL is logged');
  const token = line.slice(line.indexOf('#') + 1).trim().split(/\s/)[0];
  return { ...result, token, tokenHash: sha256hex(token) };
}

const userRow = (env, userId) => env.sheets.Auth_Users.rows.find(r => r[0] === userId);
const epochOf = (env, userId) => Number(userRow(env, userId)[5]);

// ---------------------------------------------------------------- setup and editor functions

test('setupAuthSheets creates Auth_Users / Auth_Credentials / Auth_Invites and one admin row, idempotently', () => {
  const { gas, sheets, store } = loadGas();
  store.set('kakeibo_auth_users_gen', 'g-old');
  gas.setupAuthSheets();
  assert.deepEqual(sheets.Auth_Users.rows[0], USERS_HEADER);
  assert.deepEqual(sheets.Auth_Credentials.rows[0], CREDENTIALS_HEADER);
  assert.deepEqual(sheets.Auth_Invites.rows[0], INVITES_HEADER);
  assert.equal(sheets.Auth_Users.rows.length, 2);
  const [userId, displayName, role, sources, homeSource, epoch, status] = sheets.Auth_Users.rows[1];
  assert.match(userId, /^u_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual([displayName, role, sources, homeSource, epoch, status], ['管理者', 'admin', 'main,yahoo', 'main', 0, 'active']);
  assert.notEqual(store.get('kakeibo_auth_users_gen'), 'g-old', 'user table cache invalidated');

  const before = JSON.stringify(sheets);
  gas.setupAuthSheets();
  assert.equal(JSON.stringify(sheets), before, 'second run changes nothing');
});

test('setupAuthSheets does not add an admin when one exists (even disabled)', () => {
  const { gas, sheets } = loadGas({ sheets: { Auth_Users: [[...USERS_HEADER], ['u_dummyAdmin', '管理者', 'admin', 'main,yahoo', 'main', 4, 'disabled', 't', 't']] } });
  gas.setupAuthSheets();
  assert.equal(sheets.Auth_Users.rows.length, 2);
});

test('addUser validates and appends a user; the actor check of data requests sees it at once', () => {
  const env = ready({ adminPasskey: false });
  const row = userRow(env, env.yukiId);
  assert.deepEqual(row.slice(1, 7), ['Yuki', 'member', 'yuki,main', 'yuki', 0, 'active']);
  assert.notEqual(env.yukiId, env.admin.userId);
  // Same name and attributes: the existing user (idempotent); different attributes: error
  assert.equal(env.gas.addUser('Yuki', ['main', 'yuki'], 'yuki'), env.yukiId, 'same sources in another order');
  assert.equal(env.gas.addYukiUser(), env.yukiId);
  assert.equal(env.sheets.Auth_Users.rows.filter(r => r[1] === 'Yuki').length, 1, 'no second row');
  assert.throws(() => env.gas.addUser('Yuki', ['yuki'], 'yuki'), /already exists/);
  assert.throws(() => env.gas.addUser('Yuki', ['yuki', 'main'], 'main'), /already exists/);
  assert.throws(() => env.gas.addUser('管理者', ['main', 'yahoo'], 'main'), /already exists/, 'role differs (admin)');
  assert.throws(() => env.gas.addUser('Other', ['yuki', 'nope'], 'yuki'), /source/i);
  assert.throws(() => env.gas.addUser('Other', ['yuki'], 'main'), /homeSource/);
  assert.throws(() => env.gas.addUser('=HYPERLINK("x")', ['yuki'], 'yuki'), /displayName/);
  assert.throws(() => env.gas.addUser('', ['yuki'], 'yuki'), /displayName/);
  assert.throws(() => env.gas.addUser('Other', [], 'yuki'), /source/i);
});

test('bumpEpoch / disableUser change the user row under the lock and invalidate the user table cache', () => {
  const env = ready({ adminPasskey: false });
  const gen = () => env.store.get('kakeibo_auth_users_gen');
  let before = gen();
  assert.equal(env.gas.bumpEpoch('Yuki'), 1);
  assert.equal(epochOf(env, env.yukiId), 1);
  assert.notEqual(gen(), before);
  before = gen();
  env.gas.disableUser(env.yukiId);
  assert.equal(userRow(env, env.yukiId)[6], 'disabled');
  assert.equal(epochOf(env, env.yukiId), 2, 'disabling also bumps the epoch');
  assert.notEqual(gen(), before);
  assert.throws(() => env.gas.bumpEpoch('Nobody'), /not found/i);
});

test('editor functions refuse an ambiguous user and fail without the lock', () => {
  const env = loadGas({ sheets: { Auth_Users: [[...USERS_HEADER], ['u_a', 'Same', 'member', 'main', 'main', 0, 'active', 't', 't'], ['u_b', 'Same', 'member', 'main', 'main', 0, 'active', 't', 't']] } });
  assert.throws(() => env.gas.bumpEpoch('Same'), /ambiguous|more than one/i);
  assert.equal(env.gas.bumpEpoch('u_a'), 1, 'a userId is unambiguous');
  const busy = loadGas({ lockAvailable: false });
  assert.throws(() => busy.gas.setupAuthSheets(), /lock/i);
  assert.ok(!busy.events.some(e => e.startsWith('insertSheet:')));
});

test('listUsers logs users and passkeys without public keys', () => {
  const env = ready();
  const mark = env.logs.length;
  const users = plain(env.gas.listUsers());
  assert.deepEqual(users.map(u => u.displayName).sort(), ['Yuki', '管理者']);
  const out = env.logs.slice(mark).join('\n');
  assert.ok(out.includes('Yuki'));
  assert.ok(!out.includes(b64u('public-key-admin')), 'public key not logged');
  assert.ok(!JSON.stringify(users).includes(b64u('public-key-admin')));
});

// ---------------------------------------------------------------- invites

test('createInvite stores only the hash, logs the URL once, and returns no token', () => {
  const env = ready();
  const mark = env.logs.length;
  const inv = invite(env, 'Yuki');
  assert.match(inv.token, /^[A-Za-z0-9_-]{43,}$/, 'at least 256 bits, URL-safe');
  assert.ok(!JSON.stringify(inv.inviteId).includes(inv.token));
  const row = env.sheets.Auth_Invites.rows.at(-1);
  assert.equal(row[1], inv.tokenHash, 'SHA-256 hex of the token');
  assert.equal(row[2], env.yukiId);
  assert.equal(row[3], 'register');
  assert.ok(!env.snapshot().includes(inv.token), 'raw token not in any sheet');
  const urlLines = env.logs.slice(mark).filter(l => l.includes(inv.token));
  assert.equal(urlLines.length, 1, 'token appears in exactly one log line');
  const result = JSON.stringify(plain(env.gas.createInvite('Yuki', 'register')));
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(result.replace(/"inviteId":"[^"]*"/, '')), 'the return value carries no token');
});

test('createInvite requires APP_ORIGIN and a valid purpose / user', () => {
  const env = ready();
  delete env.props.APP_ORIGIN;
  assert.throws(() => env.gas.createInvite('Yuki', 'register'), /APP_ORIGIN/);
  env.props.APP_ORIGIN = 'javascript:alert(1)';
  assert.throws(() => env.gas.createInvite('Yuki', 'register'), /APP_ORIGIN/);
  env.props.APP_ORIGIN = ORIGIN;
  assert.throws(() => env.gas.createInvite('Yuki', 'admin'), /purpose/);
  assert.throws(() => env.gas.createInvite('Nobody', 'register'), /not found/i);
  env.gas.disableUser('Yuki');
  assert.throws(() => env.gas.createInvite('Yuki', 'register'), /not active/i);
});

test('authPeekInvite reports a valid invite without consuming it, with the user\'s passkeys to exclude', () => {
  const env = ready();
  const inv = invite(env, 'Yuki');
  const peek = post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash });
  assert.equal(peek.success, true);
  assert.equal(peek.purpose, 'register');
  assert.deepEqual(peek.user, { userId: env.yukiId, displayName: 'Yuki' });
  assert.deepEqual(peek.credentials, []);
  assert.equal(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash }).success, true, 'still valid');
  assert.ok(!JSON.stringify(peek).includes(inv.tokenHash), 'hash not echoed');
  assert.deepEqual(post(env.gas, { action: 'authPeekInvite', tokenHash: sha256hex('wrong') }), { error: 'InviteInvalid' });
  assert.deepEqual(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.token }), { error: 'Invalid input' }, 'raw token is not a hash');
});

test('an invite is consumed once: the second use fails and adds nothing', () => {
  const env = ready();
  const inv = invite(env, 'Yuki');
  const first = post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: credential('yuki-1') });
  assert.equal(first.success, true);
  assert.deepEqual(first.user, { userId: env.yukiId, displayName: 'Yuki', sources: ['yuki', 'main'], homeSource: 'yuki', epoch: 0 });
  const second = post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv.tokenHash, challengeHash: hashOf(2), credential: credential('yuki-2') });
  assert.deepEqual(second, { error: 'InviteInvalid' });
  assert.equal(env.sheets.Auth_Credentials.rows.filter(r => r[1] === env.yukiId).length, 1);
  assert.ok(env.sheets.Auth_Invites.rows.at(-1)[6], 'usedAt recorded');
  assert.deepEqual(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash }), { error: 'InviteInvalid' });
});

test('concurrent consumption: the invite is re-checked inside the lock', () => {
  const env = ready();
  const inv = invite(env, 'Yuki');
  // Another request consumes the invite while this one waits for the lock
  const realLock = env.gas.LockService.getScriptLock;
  let raced = false;
  env.gas.LockService.getScriptLock = () => {
    const lock = realLock();
    return {
      tryLock: (ms) => {
        if (!raced) {
          raced = true;
          env.gas.LockService.getScriptLock = realLock;
          assert.equal(post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv.tokenHash, challengeHash: hashOf('a'), credential: credential('a') }).success, true);
          env.gas.LockService.getScriptLock = () => lock;
        }
        return lock.tryLock(ms);
      },
      releaseLock: () => lock.releaseLock(),
    };
  };
  const late = post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv.tokenHash, challengeHash: hashOf('b'), credential: credential('b') });
  assert.deepEqual(late, { error: 'InviteInvalid' });
  assert.equal(env.sheets.Auth_Credentials.rows.filter(r => r[1] === env.yukiId).length, 1);
});

test('invites expire after 24 hours; an admin recovery invite after 10 minutes', () => {
  const env = ready();
  const inv = invite(env, 'Yuki');
  env.clock.now += 24 * HOUR - 1000;
  assert.equal(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash }).success, true);
  env.clock.now += 2000;
  assert.deepEqual(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash }), { error: 'InviteInvalid' });
  assert.deepEqual(post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv.tokenHash, challengeHash: hashOf(3), credential: credential('late') }), { error: 'InviteInvalid' });

  const rec = invite(env, env.admin.userId, 'recovery');
  env.clock.now += 10 * 60 * 1000 + 1000;
  assert.deepEqual(post(env.gas, { action: 'authPeekInvite', tokenHash: rec.tokenHash }), { error: 'InviteInvalid' });
});

test('a new invite invalidates the user\'s previous unused invites only', () => {
  const env = ready();
  const old = invite(env, 'Yuki');
  const adminInv = invite(env, env.admin.userId, 'recovery');
  const fresh = invite(env, 'Yuki');
  assert.deepEqual(post(env.gas, { action: 'authPeekInvite', tokenHash: old.tokenHash }), { error: 'InviteInvalid' });
  assert.equal(post(env.gas, { action: 'authPeekInvite', tokenHash: fresh.tokenHash }).success, true);
  assert.equal(post(env.gas, { action: 'authPeekInvite', tokenHash: adminInv.tokenHash }).success, true, 'other users keep theirs');
});

test('an invite for a disabled user is invalid', () => {
  const env = ready();
  const inv = invite(env, 'Yuki');
  env.gas.disableUser('Yuki');
  assert.deepEqual(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash }), { error: 'InviteInvalid' });
});

// ---------------------------------------------------------------- challenges

test('a challenge hash is accepted once: the second use is ChallengeReused (consume, add, record)', () => {
  const env = ready();
  const inv1 = invite(env, 'Yuki');
  assert.equal(post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv1.tokenHash, challengeHash: hashOf('x'), credential: credential('y1') }).success, true);
  const inv2 = invite(env, 'Yuki', 'recovery');
  assert.deepEqual(post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv2.tokenHash, challengeHash: hashOf('x'), credential: credential('y2') }), { error: 'ChallengeReused' });
  assert.equal(post(env.gas, { action: 'authPeekInvite', tokenHash: inv2.tokenHash }).success, true, 'a reused challenge does not burn the invite');

  const cred = credential('admin');
  assert.equal(post(env.gas, { action: 'authRecordCredentialUse', credentialId: cred.credentialId, counter: 0, challengeHash: hashOf('login') }).success, true);
  assert.deepEqual(post(env.gas, { action: 'authRecordCredentialUse', credentialId: cred.credentialId, counter: 0, challengeHash: hashOf('login') }), { error: 'ChallengeReused' });

  const actor = { actorUserId: env.admin.userId, actorEpoch: env.admin.epoch };
  assert.deepEqual(post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf('login'), credential: credential('admin-2') }), { error: 'ChallengeReused' });
  assert.equal(post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf('add'), credential: credential('admin-2') }).success, true);
});

test('challenge records live in the Script Cache for 5 minutes', () => {
  const env = ready();
  const keys = [...env.store.keys()].filter(k => k.startsWith('kakeibo_auth_challenge_'));
  assert.equal(keys.length, 1, 'the bootstrap challenge is recorded');
  assert.equal(env.ttls.get(keys[0]), 300);
  // Once the record expires, only the 5-minute challenge cookie (Next.js) still protects it
  env.store.delete(keys[0]);
  const actor = { actorUserId: env.admin.userId, actorEpoch: 0 };
  assert.equal(post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf('admin-boot'), credential: credential('again') }).success, true);
});

// ---------------------------------------------------------------- passkeys: add / get / record / list / revoke

test('bootstrap: only an admin without any passkey may add the first one; later additions need an existing passkey', () => {
  const env = ready({ adminPasskey: false });
  const admin = { actorUserId: env.admin.userId, actorEpoch: env.admin.epoch };
  assert.deepEqual(post(env.gas, { action: 'authAddCredential', ...admin, challengeHash: hashOf(1), credential: credential('a1') }), { error: 'NoExistingCredential' });
  assert.equal(post(env.gas, { action: 'authAddCredential', ...admin, challengeHash: hashOf(2), credential: credential('a1'), bootstrap: true }).success, true);
  assert.deepEqual(post(env.gas, { action: 'authAddCredential', ...admin, challengeHash: hashOf(3), credential: credential('a2'), bootstrap: true }), { error: 'BootstrapNotAllowed' });
  const second = post(env.gas, { action: 'authAddCredential', ...admin, challengeHash: hashOf(4), credential: credential('a2') });
  assert.deepEqual(second, { success: true, credentialCount: 2 });

  const yuki = { actorUserId: env.yukiId, actorEpoch: 0 };
  assert.deepEqual(post(env.gas, { action: 'authAddCredential', ...yuki, challengeHash: hashOf(5), credential: credential('y'), bootstrap: true }), { error: 'BootstrapNotAllowed' }, 'members never bootstrap');
});

test('authAddCredential checks the actor epoch and rejects a duplicate credential id', () => {
  const env = ready();
  assert.deepEqual(post(env.gas, { action: 'authAddCredential', actorUserId: env.admin.userId, actorEpoch: env.admin.epoch + 1, challengeHash: hashOf(1), credential: credential('z') }), { error: 'SessionRevoked' });
  assert.deepEqual(post(env.gas, { action: 'authAddCredential', actorUserId: 'u_nobody', actorEpoch: 0, challengeHash: hashOf(2), credential: credential('z') }), { error: 'SessionRevoked' });
  assert.deepEqual(post(env.gas, { action: 'authAddCredential', challengeHash: hashOf(3), credential: credential('z') }), { error: 'Invalid actor' });
  const inv = invite(env, 'Yuki');
  assert.deepEqual(post(env.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv.tokenHash, challengeHash: hashOf(4), credential: credential('admin') }), { error: 'CredentialExists' });
  assert.equal(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash }).success, true, 'the invite is kept');
});

test('authGetCredential returns the public key, counter and user for login; never for revoked keys or disabled users', () => {
  const env = ready();
  const cred = credential('admin');
  const got = post(env.gas, { action: 'authGetCredential', credentialId: cred.credentialId });
  assert.deepEqual(got, {
    success: true,
    credential: { credentialId: cred.credentialId, userId: env.admin.userId, publicKey: cred.publicKey, counter: 0, transports: ['internal', 'hybrid'] },
    user: { userId: env.admin.userId, displayName: '管理者', sources: ['main', 'yahoo'], homeSource: 'main', epoch: 0 },
  });
  assert.deepEqual(post(env.gas, { action: 'authGetCredential', credentialId: b64u('unknown') }), { error: 'CredentialNotFound' });
  env.gas.disableUser(env.admin.userId);
  assert.deepEqual(post(env.gas, { action: 'authGetCredential', credentialId: cred.credentialId }), { error: 'CredentialNotFound' });
});

test('authRecordCredentialUse records lastUsedAt and raises the counter only when it increases', () => {
  const env = ready();
  const id = credential('admin').credentialId;
  const row = () => env.sheets.Auth_Credentials.rows.find(r => r[1] === env.admin.userId);
  assert.equal(row()[9], '', 'not used yet');
  assert.equal(post(env.gas, { action: 'authRecordCredentialUse', credentialId: id, counter: 0, challengeHash: hashOf(1) }).success, true);
  assert.ok(row()[9], 'lastUsedAt set');
  assert.equal(post(env.gas, { action: 'authRecordCredentialUse', credentialId: id, counter: 7, challengeHash: hashOf(2) }).success, true);
  assert.equal(row()[3], 7);
  assert.equal(post(env.gas, { action: 'authRecordCredentialUse', credentialId: id, counter: 3, challengeHash: hashOf(3) }).success, true);
  assert.equal(row()[3], 7, 'never lowered');
  assert.deepEqual(post(env.gas, { action: 'authRecordCredentialUse', credentialId: id, counter: -1, challengeHash: hashOf(4) }), { error: 'Invalid input' });
});

test('a credential id starting with "-" is stored as plain text and round-trips', () => {
  const env = ready();
  const actor = { actorUserId: env.admin.userId, actorEpoch: env.admin.epoch };
  assert.equal(post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf(1), credential: credential('d', { credentialId: DASH_ID }) }).success, true);
  assert.equal(post(env.gas, { action: 'authGetCredential', credentialId: DASH_ID }).credential.credentialId, DASH_ID);
});

test('nothing written to an Auth_* sheet starts with = + - @ (formula injection)', () => {
  const env = ready();
  const actor = { actorUserId: env.admin.userId, actorEpoch: env.admin.epoch };
  post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf(1), credential: credential('d', { credentialId: DASH_ID, publicKey: '-' + b64u('pk') }) });
  invite(env, 'Yuki');
  for (const name of ['Auth_Users', 'Auth_Credentials', 'Auth_Invites']) {
    for (const row of env.sheets[name].rows) {
      for (const cell of row) {
        if (typeof cell === 'string') assert.ok(!/^[=+\-@]/.test(cell), `${name}: ${cell.slice(0, 12)}`);
      }
    }
  }
  for (const label of ['=cmd', '+1', '-x', '@x', 'a'.repeat(41)]) {
    assert.deepEqual(post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf(label), credential: credential(label, { label }) }), { error: 'Invalid input' }, label);
  }
});

test('authListCredentials returns the actor\'s active passkeys without public keys', () => {
  const env = ready();
  const actor = { actorUserId: env.admin.userId, actorEpoch: env.admin.epoch };
  post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf(1), credential: credential('a2', { label: 'iPad' }) });
  const list = post(env.gas, { action: 'authListCredentials', ...actor });
  assert.equal(list.success, true);
  assert.deepEqual(list.credentials.map(c => c.label), ['iPhone', 'iPad']);
  assert.ok(list.credentials.every(c => !('publicKey' in c)));
  assert.deepEqual(post(env.gas, { action: 'authListCredentials', actorUserId: env.yukiId, actorEpoch: 0 }), { success: true, credentials: [] }, 'other users\' keys are not listed');
});

test('authRevokeCredential revokes only the actor\'s own passkey and bumps the epoch', () => {
  const env = ready();
  const actor = { actorUserId: env.admin.userId, actorEpoch: 0 };
  const id = credential('admin').credentialId;
  assert.deepEqual(post(env.gas, { action: 'authRevokeCredential', actorUserId: env.yukiId, actorEpoch: 0, credentialId: id }), { error: 'CredentialNotFound' }, 'not Yuki\'s');
  assert.equal(epochOf(env, env.admin.userId), 0);
  assert.deepEqual(post(env.gas, { action: 'authRevokeCredential', ...actor, credentialId: id }), { success: true, epoch: 1 });
  assert.equal(epochOf(env, env.admin.userId), 1);
  assert.deepEqual(post(env.gas, { action: 'authGetCredential', credentialId: id }), { error: 'CredentialNotFound' });
  assert.deepEqual(post(env.gas, { action: 'authRevokeCredential', ...actor, credentialId: id }), { error: 'SessionRevoked' }, 'old epoch');
});

test('after revocation or authBumpEpoch the data actions refuse the old session at once', () => {
  const env = ready();
  const getMain = (epoch) => JSON.parse(env.gas.doGet({ parameter: { key: KEY, authKey: AUTH_KEY, source: 'main', actorUserId: env.admin.userId, actorEpoch: String(epoch), action: 'getFixedCosts' } }).body);
  assert.deepEqual(getMain(0), [], 'valid session (no Fixed sheet = empty list)');
  assert.deepEqual(post(env.gas, { action: 'authBumpEpoch', actorUserId: env.admin.userId, actorEpoch: 0 }), { success: true, epoch: 1 });
  assert.deepEqual(getMain(0), { error: 'SessionRevoked' });
  assert.deepEqual(getMain(1), []);
  assert.deepEqual(post(env.gas, { action: 'authRevokeCredential', actorUserId: env.admin.userId, actorEpoch: 1, credentialId: credential('admin').credentialId }), { success: true, epoch: 2 });
  assert.deepEqual(getMain(1), { error: 'SessionRevoked' });
});

test('revokeCredential (editor) revokes by id prefix and bumps the epoch; an ambiguous prefix is refused', () => {
  const env = ready();
  const actor = { actorUserId: env.admin.userId, actorEpoch: 0 };
  post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf(1), credential: credential('admin-2') });
  const id = credential('admin').credentialId;
  assert.throws(() => env.gas.revokeCredential('管理者', id.slice(0, 3)), /at least 8/i);
  // Both synthetic ids start with the same 24 characters
  assert.throws(() => env.gas.revokeCredential('管理者', id.slice(0, 12)), /ambiguous|more than one/i);
  assert.equal(epochOf(env, env.admin.userId), 0, 'nothing revoked');
  env.gas.revokeCredential('管理者', id); // an exact id wins even though it prefixes the other id
  assert.equal(epochOf(env, env.admin.userId), 1);
  assert.deepEqual(post(env.gas, { action: 'authGetCredential', credentialId: id }), { error: 'CredentialNotFound' });
  assert.equal(post(env.gas, { action: 'authGetCredential', credentialId: credential('admin-2').credentialId }).success, true);
  assert.throws(() => env.gas.revokeCredential('Yuki', credential('admin-2').credentialId), /not found|no active/i, 'only that user\'s passkeys');
});

// ---------------------------------------------------------------- authGetAdminUser

test('authGetAdminUser returns the single active admin', () => {
  const env = ready();
  assert.deepEqual(post(env.gas, { action: 'authGetAdminUser' }), {
    success: true,
    user: { userId: env.admin.userId, displayName: '管理者', role: 'admin', sources: ['main', 'yahoo'], homeSource: 'main', epoch: 0 },
  });
});

test('authGetAdminUser fails when there is no active admin, more than one, or no Auth_Users sheet', () => {
  const none = loadGas({ sheets: { Auth_Users: [[...USERS_HEADER], ['u_dummyAdmin', '管理者', 'admin', 'main,yahoo', 'main', 0, 'disabled', 't', 't']] } });
  assert.deepEqual(post(none.gas, { action: 'authGetAdminUser' }), { error: 'AdminNotFound' });
  const two = loadGas({ sheets: { Auth_Users: [[...USERS_HEADER], ['u_a', 'A', 'admin', 'main', 'main', 0, 'active', 't', 't'], ['u_b', 'B', 'admin', 'main', 'main', 0, 'active', 't', 't']] } });
  assert.deepEqual(post(two.gas, { action: 'authGetAdminUser' }), { error: 'AdminAmbiguous' });
  const missing = loadGas();
  assert.deepEqual(post(missing.gas, { action: 'authGetAdminUser' }), { error: 'AuthUnavailable' });
});

// ---------------------------------------------------------------- PROXY_SECRET and dispatch

const AUTH_ACTIONS = ['authGetAdminUser', 'authPeekInvite', 'authConsumeInviteAndAddCredential', 'authAddCredential', 'authGetCredential', 'authRecordCredentialUse', 'authListCredentials', 'authRevokeCredential', 'authBumpEpoch'];

test('every auth action is Unauthorized while PROXY_SECRET is unset (no migration pass-through)', () => {
  const env = ready();
  delete env.props.PROXY_SECRET;
  const before = env.snapshot();
  for (const action of AUTH_ACTIONS) {
    assert.deepEqual(post(env.gas, { action, actorUserId: env.admin.userId, actorEpoch: 0, credentialId: credential('admin').credentialId }, undefined), { error: 'Unauthorized' }, action);
    assert.deepEqual(post(env.gas, { action }, 'anything'), { error: 'Unauthorized' }, `${action} with a key`);
  }
  assert.equal(env.snapshot(), before);
});

test('auth actions need the right key and ignore `source`', () => {
  const env = ready();
  assert.deepEqual(post(env.gas, { action: 'authGetAdminUser' }, 'wrong'), { error: 'Unauthorized' });
  assert.equal(post(env.gas, { action: 'authGetAdminUser', source: 'Invalid' }).success, true);
});

// The current production proxy forwards any body and re-adds `key`. Between
// the GAS push and the UI push, a logged-in browser could therefore call auth
// actions with a valid key. They must require authKey, which that proxy never sends.
test('with key only (old proxy path) no auth action reads or writes anything', () => {
  const env = ready();
  const admin = { actorUserId: env.admin.userId, actorEpoch: 0 };
  const id = credential('admin').credentialId;
  const attacks = [
    { action: 'authGetAdminUser' },
    { action: 'authAddCredential', ...admin, challengeHash: hashOf('evil'), credential: credential('evil'), bootstrap: true },
    { action: 'authAddCredential', ...admin, challengeHash: hashOf('evil2'), credential: credential('evil') },
    { action: 'authRecordCredentialUse', credentialId: id, counter: 4294967295, challengeHash: hashOf('max') },
    { action: 'authRevokeCredential', ...admin, credentialId: id },
    { action: 'authBumpEpoch', ...admin },
    { action: 'authGetCredential', credentialId: id },
    { action: 'authListCredentials', ...admin },
    { action: 'authPeekInvite', tokenHash: sha256hex('x') },
    { action: 'authConsumeInviteAndAddCredential', tokenHash: sha256hex('x'), challengeHash: hashOf('c'), credential: credential('evil') },
  ];
  const mark = env.events.length;
  const before = env.snapshot();
  for (const authKey of [NO_AUTH_KEY, null, '', 'wrong', KEY, AUTH_KEY.slice(0, -1), 42, [AUTH_KEY]]) {
    for (const payload of attacks) {
      assert.deepEqual(post(env.gas, payload, KEY, authKey), { error: 'Unauthorized' }, `${payload.action} authKey=${JSON.stringify(authKey)}`);
    }
  }
  assert.equal(env.snapshot(), before, 'nothing written');
  assert.ok(!env.events.slice(mark).some(e => e.startsWith('read:') || e.startsWith('write:') || e.startsWith('cache:put:kakeibo_auth_challenge_')), 'nothing read, no challenge recorded');
  assert.equal(env.sheets.Auth_Credentials.rows.find(r => r[1] === env.admin.userId)[3], 0, 'counter untouched');
  assert.ok(!env.logs.some(l => l.includes(AUTH_KEY) || l.includes(KEY)), 'keys never logged');
  // The real auth proxy (both keys) still works
  assert.equal(post(env.gas, { action: 'authGetAdminUser' }).success, true);
});

test('auth actions are Unauthorized while AUTH_PROXY_SECRET is unset, whatever authKey says', () => {
  const env = ready();
  delete env.props.AUTH_PROXY_SECRET;
  const before = env.snapshot();
  for (const action of AUTH_ACTIONS) {
    for (const authKey of [AUTH_KEY, NO_AUTH_KEY, '']) {
      assert.deepEqual(post(env.gas, { action, actorUserId: env.admin.userId, actorEpoch: 0 }, KEY, authKey), { error: 'Unauthorized' }, action);
    }
  }
  assert.equal(env.snapshot(), before);
});

test('authKey is checked as its own field even when both secrets have the same value; setup warns about it', () => {
  const env = loadGas({ properties: { PROXY_SECRET: KEY, AUTH_PROXY_SECRET: KEY, APP_ORIGIN: ORIGIN } });
  env.gas.setupAuthSheets();
  assert.ok(env.logs.some(l => l.startsWith('warn:') && l.includes('AUTH_PROXY_SECRET') && l.includes('PROXY_SECRET')), 'same value is warned');
  assert.ok(!env.logs.some(l => l.includes(KEY)), 'without printing the value');
  assert.deepEqual(post(env.gas, { action: 'authGetAdminUser' }, KEY, NO_AUTH_KEY), { error: 'Unauthorized' }, 'key alone is not authKey');
  assert.equal(post(env.gas, { action: 'authGetAdminUser' }, KEY, KEY).success, true);

  const unset = loadGas({ properties: { PROXY_SECRET: KEY, APP_ORIGIN: ORIGIN } });
  unset.gas.setupAuthSheets();
  assert.ok(unset.logs.some(l => l.startsWith('warn:') && l.includes('AUTH_PROXY_SECRET')), 'missing secret is warned');
});

test('the actor check of data requests follows the same authKey rule (and getMain with authKey works)', () => {
  const env = ready();
  const query = { key: KEY, source: 'main', action: 'getFixedCosts', actorUserId: env.admin.userId, actorEpoch: '0' };
  assert.deepEqual(JSON.parse(env.gas.doGet({ parameter: query }).body), { error: 'Unauthorized' });
  assert.deepEqual(JSON.parse(env.gas.doGet({ parameter: { ...query, authKey: AUTH_KEY } }).body), []);
});

test('no Web action operates on another user (invites, user changes and other users\' passkeys are editor-only)', () => {
  const env = ready();
  for (const action of ['createInvite', 'addUser', 'disableUser', 'bumpEpoch', 'revokeCredential', 'listUsers', 'setupAuthSheets', 'authCreateInvite', 'authAddUser', 'authDisableUser']) {
    assert.deepEqual(post(env.gas, { action, user: 'Yuki' }), { error: 'Unknown action' }, action);
  }
});

test('malformed auth input is rejected before anything is written', () => {
  const env = ready();
  const inv = invite(env, 'Yuki');
  const before = env.snapshot();
  const bad = [
    { tokenHash: 'abc', challengeHash: hashOf(1), credential: credential('m') },
    { tokenHash: inv.tokenHash, challengeHash: 'xyz', credential: credential('m') },
    { tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: credential('m', { credentialId: 'not base64url!' }) },
    { tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: credential('m', { publicKey: '' }) },
    { tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: credential('m', { counter: 1.5 }) },
    { tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: credential('m', { transports: ['internal', 'telepathy'] }) },
    { tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: credential('m', { deviceType: 'other' }) },
    { tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: 'x' },
  ];
  for (const payload of bad) {
    assert.deepEqual(post(env.gas, { action: 'authConsumeInviteAndAddCredential', ...payload }), { error: 'Invalid input' }, JSON.stringify(payload).slice(0, 80));
  }
  assert.equal(env.snapshot(), before);
  assert.equal(post(env.gas, { action: 'authPeekInvite', tokenHash: inv.tokenHash }).success, true);
});

test('auth writes answer Busy without the lock and never echo secrets in errors or logs', () => {
  const env = ready();
  const inv = invite(env, 'Yuki');
  const busy = loadGas({ sheets: JSON.parse(env.snapshot()), lockAvailable: false });
  assert.deepEqual(post(busy.gas, { action: 'authConsumeInviteAndAddCredential', tokenHash: inv.tokenHash, challengeHash: hashOf(1), credential: credential('busy') }), { error: 'Busy' });
  for (const line of [...env.logs.filter(l => !l.includes('/invite#')), ...busy.logs]) {
    assert.ok(!line.includes(inv.tokenHash) && !line.includes(KEY), `log leaks: ${line.slice(0, 60)}`);
  }
});

test('an internal error in an auth action is reported generically', () => {
  const env = ready();
  env.sheets.Auth_Credentials.appendRow = () => { throw new Error(`boom ${b64u('public-key-x')}`); };
  const actor = { actorUserId: env.admin.userId, actorEpoch: 0 };
  const result = post(env.gas, { action: 'authAddCredential', ...actor, challengeHash: hashOf(9), credential: credential('x') });
  assert.deepEqual(result, { error: 'AuthError' });
});

// ---------------------------------------------------------------- random values

test('generated ids and tokens are unique and URL-safe', () => {
  const env = ready();
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add(env.gas.addUser(`User ${i}`, ['main'], 'main'));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^u_[A-Za-z0-9_-]{22}$/);
  const tokens = new Set();
  for (let i = 0; i < 10; i++) tokens.add(invite(env, 'Yuki').token);
  assert.equal(tokens.size, 10);
});
