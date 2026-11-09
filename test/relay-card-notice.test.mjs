import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Relay script (relay/card-notice-relay.gs + settings.html + appsscript.json),
// design docs/design/2026-11-yuki-phase2-card-import.md §4, §8.2. Runs in the
// user's own Google account; reads card notices with gmail.readonly and posts
// them to the kakeibo GAS ingestEmail. Every address, secret, URL, subject and
// body below is synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const relayDir = join(__dirname, '../relay');
const relaySource = fs.readFileSync(join(relayDir, 'card-notice-relay.gs'), 'utf8');
const settingsHtml = fs.readFileSync(join(relayDir, 'settings.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(join(relayDir, 'appsscript.json'), 'utf8'));
const guide = fs.readFileSync(join(__dirname, '../docs/guides/card-import-setup.md'), 'utf8');

const GAS_URL = 'https://script.google.com/macros/s/AKfycbSyntheticDeploymentId_0123-abc/exec';
const SECRET = 'SyntheticIngestSecret0123456789abcdefABCDEF';
const QUERY = 'from:notice@example.invalid subject:架空の通知';
const START = '2026-11-01';
const T0 = Date.parse('2026-11-05T12:00:00Z');

// values created inside the VM have that realm's prototypes: compare plain copies
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------- Gmail message builders

const textPart = (body, { mime = 'text/plain', charset = 'UTF-8', bytes } = {}) => ({
  mimeType: mime,
  headers: [{ name: 'Content-Type', value: `${mime}; charset="${charset}"` }],
  body: { size: 1, data: b64url(bytes || Buffer.from(body, 'utf8')) },
});

function gmailMessage(id, { subject = '架空の通知', messageId = `<${id}@mail.example.invalid>`, internalDate = T0, payload } = {}) {
  const headers = [{ name: 'Subject', value: subject }];
  if (messageId !== null) headers.push({ name: 'Message-ID', value: messageId });
  return {
    id,
    internalDate: String(internalDate),
    payload: payload || {
      mimeType: 'multipart/alternative', headers,
      parts: [textPart(`本文 ${id}`), textPart(`<p>本文 ${id}</p>`, { mime: 'text/html' })],
    },
    headersForTest: headers,
  };
}
function withHeaders(msg) {
  if (msg.payload.headers && msg.payload.headers.some(h => h.name === 'Subject')) return msg;
  msg.payload.headers = [...(msg.payload.headers || []), ...msg.headersForTest];
  return msg;
}

// ---------------------------------------------------------------- sandbox

function loadRelay({ props = {}, messages = [], respond, attachments = {}, now = T0 + 60000, lockAvailable = true, userCache, failGet = new Set(), failList = false } = {}) {
  const store = new Map(Object.entries({
    KAKEIBO_GAS_URL: GAS_URL, INGEST_SECRET: SECRET, SEARCH_QUERY: QUERY, START_DATE: START, ...props,
  }).filter(([, v]) => v !== undefined));
  const logs = [];
  const fetches = [];
  const lists = [];
  const gets = [];
  const triggers = [];
  const cache = userCache || new Map();
  const byId = new Map(messages.map(m => [m.id, withHeaders(m)]));
  const clock = { now };
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.join(' ')),
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    },
    Date: class extends Date {
      constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
      static now() { return clock.now; }
    },
    Gmail: {
      Users: {
        Messages: {
          list: (user, options) => {
            lists.push({ user, ...options });
            if (failList) throw new Error('API call to gmail.users.messages.list failed: quota');
            return { messages: [...byId.values()].sort((a, b) => Number(b.internalDate) - Number(a.internalDate)).map(m => ({ id: m.id, threadId: m.id })) };
          },
          get: (user, id, options) => {
            gets.push({ user, id, ...options });
            const m = byId.get(id);
            if (!m || failGet.has(id)) throw new Error(`API call to gmail.users.messages.get failed for ${id}`);
            return JSON.parse(JSON.stringify({ id: m.id, internalDate: m.internalDate, payload: m.payload }));
          },
          Attachments: {
            get: (user, messageId, attachmentId) => {
              gets.push({ user, id: messageId, attachmentId });
              if (!(attachmentId in attachments)) throw new Error(`attachment ${attachmentId} failed`);
              return { size: 1, data: attachments[attachmentId] };
            },
          },
        },
      },
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        const payload = JSON.parse(options.payload);
        fetches.push({ url, options, payload });
        const r = respond ? respond(payload, fetches.length) : { success: true, parsed: 1, added: 1 };
        if (r instanceof Error) throw r;
        const code = r && r.__code ? r.__code : 200;
        const text = r && r.__text !== undefined ? r.__text : JSON.stringify(r);
        return { getResponseCode: () => code, getContentText: () => text };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (store.has(k) ? store.get(k) : null),
        getProperties: () => Object.fromEntries(store),
        setProperty: (k, v) => { store.set(k, String(v)); },
        setProperties: (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, String(v)); },
        deleteProperty: k => { store.delete(k); },
        deleteAllProperties: () => store.clear(),
      }),
    },
    CacheService: {
      getUserCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, String(v)),
        remove: k => cache.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => lockAvailable,
        waitLock: () => { if (!lockAvailable) throw new Error('lock timeout'); },
        releaseLock: () => {},
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => {
        const t = { fn, getHandlerFunction: () => fn, everyMinutes: null };
        const builder = {
          timeBased: () => builder,
          everyMinutes: n => { t.everyMinutes = n; return builder; },
          create: () => { triggers.push(t); return t; },
        };
        return builder;
      },
    },
    HtmlService: {
      createTemplateFromFile: name => {
        const tpl = {
          name,
          evaluate: () => {
            const html = settingsHtml.replace(/<\?=\s*token\s*\?>/g, String(tpl.token).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`));
            const out = {
              html, metas: [], title: '',
              setTitle: t => { out.title = t; return out; },
              addMetaTag: (n, c) => { out.metas.push([n, c]); return out; },
              getContent: () => out.html,
            };
            return out;
          },
        };
        return tpl;
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => randomUUID(),
      computeDigest: (_a, value) => [...createHash('sha256').update(String(value), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      base64DecodeWebSafe: s => [...Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')].map(b => (b > 127 ? b - 256 : b)),
      newBlob: bytes => ({
        getDataAsString: charset => {
          const label = { 'Windows-31J': 'shift_jis', 'ISO-2022-JP': 'iso-2022-jp', 'EUC-JP': 'euc-jp', 'UTF-8': 'utf-8' }[charset];
          if (!label) throw new Error(`Unsupported charset ${charset}`);
          return new TextDecoder(label).decode(Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b))));
        },
      }),
      formatDate: (d, tz, fmt) => {
        assert.equal(tz, 'Asia/Tokyo');
        const j = new Date(d.getTime() + 9 * 3600 * 1000);
        const p = n => String(n).padStart(2, '0');
        assert.equal(fmt, 'yyyy-MM-dd');
        return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(relaySource, sandbox);
  const json = k => JSON.parse(store.get(k) || 'null');
  return { relay: sandbox, store, logs, fetches, lists, gets, triggers, cache, clock, json, byId };
}

const run = env => { env.relay.relayRun(); };
const runThrows = (env, pattern) => assert.throws(() => env.relay.relayRun(), pattern);
const token = env => {
  const out = env.relay.doGet({ parameter: {} });
  return /id="token" value="([^"]+)"/.exec(out.html)[1];
};

// ================================================================ static checks (R2, public repository)

test('manifest: exactly the three scopes, Gmail advanced service, web app for the owner only', () => {
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
  ]);
  assert.deepEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: 'Gmail', serviceId: 'gmail', version: 'v1' }]);
  assert.equal(manifest.timeZone, 'Asia/Tokyo');
  assert.equal(manifest.runtimeVersion, 'V8');
});

test('sources use no broad or writing API (gmail.readonly only), no framing change, no external assets', () => {
  for (const [name, src] of [['gs', relaySource], ['html', settingsHtml]]) {
    for (const forbidden of [/GmailApp/, /MailApp/, /DriveApp/, /SpreadsheetApp/, /DocumentApp/, /FormApp/, /ContactsApp/, /CalendarApp/,
      /Gmail\.Users\.(Messages\.(modify|trash|untrash|delete|send|insert|import|batchModify|batchDelete)|Labels|Drafts|Settings|Threads|History|watch|stop)/,
      /setXFrameOptionsMode/, /ALLOWALL/, /<script[^>]*\bsrc\s*=/i, /<link[^>]*\bhref\s*=/i, /@import/, /\bdoPost\b/, /eval\s*\(/, /new Function/]) {
      assert.doesNotMatch(src, forbidden, `${name}: ${forbidden}`);
    }
  }
  const styles = (settingsHtml.match(/<style[^>]*>[^]*?<\/style>/gi) || []).join('\n') + (settingsHtml.match(/style\s*=\s*"[^"]*"/gi) || []).join('\n');
  assert.doesNotMatch(styles, /\burl\s*\(/i, 'no CSS url()');
  assert.equal(typeof loadRelay().relay.doPost, 'undefined');
});

test('sources and guide contain no address-like string, no card issuer or carrier name, no secret-looking value', () => {
  const names = /三井住友|vpass|\bolive\b|楽天|rakuten|\bjcb\b|イオン|\baeon\b|セゾン|\bsaison\b|\bamex\b|アメックス|オリコ|\borico\b|エポス|\bepos\b|ジャックス|dカード|\bau\b|ezweb|auone|docomo|ドコモ|softbank|ソフトバンク|ymobile|ワイモバイル|uq mobile/i;
  for (const [name, src] of [['gs', relaySource], ['html', settingsHtml], ['guide', guide]]) {
    assert.doesNotMatch(src, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${name}: address-like string`);
    assert.doesNotMatch(src, names, `${name}: issuer / carrier name`);
    assert.doesNotMatch(src, /AKfyc[A-Za-z0-9_-]{20,}/, `${name}: deployment id`);
  }
});

test('settings.html: no unescaped template output, no innerHTML / outerHTML / insertAdjacentHTML / document.write', () => {
  assert.doesNotMatch(settingsHtml, /<\?!=/);
  assert.doesNotMatch(settingsHtml, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const scriptlets = settingsHtml.match(/<\?[^]*?\?>/g) || [];
  assert.ok(scriptlets.length >= 1);
  for (const s of scriptlets) assert.match(s, /^<\?=\s*token\s*\?>$/, `only the escaped token is printed: ${s}`);
  assert.match(settingsHtml, /textContent/);
  assert.match(settingsHtml, /google\.script\.run/);
});

test('every top-level function callable from the page is listed; internal helpers end with _', () => {
  const names = [...relaySource.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1]);
  const publicNames = names.filter(n => !n.endsWith('_')).sort();
  assert.deepEqual(publicNames, ['doGet', 'relayDeleteAll', 'relayGetStatus', 'relayRetryHeld', 'relaySaveSettings', 'relayStop', 'relayTest', 'relayRun'].sort());
});

// ================================================================ search and range

test('SEARCH_QUERY (or another required setting) missing or malformed: fixed error, nothing searched or sent', () => {
  for (const props of [
    { SEARCH_QUERY: undefined }, { INGEST_SECRET: undefined }, { KAKEIBO_GAS_URL: undefined }, { START_DATE: undefined },
    { KAKEIBO_GAS_URL: 'http://script.google.com/macros/s/abc/exec' }, { KAKEIBO_GAS_URL: 'https://evil.example.invalid/macros/s/abc/exec' },
  ]) {
    const env = loadRelay({ props, messages: [gmailMessage('m1')] });
    const err = assert.throws(() => run(env), /設定/);
    void err;
    assert.equal(env.lists.length, 0);
    assert.equal(env.fetches.length, 0);
    const text = env.logs.join('\n');
    for (const v of [QUERY, SECRET, GAS_URL]) assert.ok(!text.includes(v));
  }
});

test('query: user query + newer_than:<LOOKBACK_DAYS>d -in:trash; spam included; 50 results at most', () => {
  const env = loadRelay();
  run(env);
  assert.equal(env.lists.length, 1);
  const call = env.lists[0];
  assert.equal(call.user, 'me');
  assert.equal(call.q, `(${QUERY}) newer_than:7d -in:trash`);
  assert.equal(call.includeSpamTrash, true);
  assert.equal(call.maxResults, 50);
  const custom = loadRelay({ props: { LOOKBACK_DAYS: '14' } });
  run(custom);
  assert.match(custom.lists[0].q, / newer_than:14d -in:trash$/);
  for (const bad of ['0', '31', 'x', '-1']) {
    const e = loadRelay({ props: { LOOKBACK_DAYS: bad } });
    run(e);
    assert.match(e.lists[0].q, / newer_than:7d -in:trash$/, bad);
  }
});

test('processed, held and pre-START_DATE messages are not sent; oldest first; at most 20 per run', () => {
  const old = gmailMessage('old', { internalDate: Date.parse('2026-10-31T14:59:00Z') }); // 2026-10-31 23:59 JST
  const msgs = Array.from({ length: 25 }, (_, i) => gmailMessage(`n${String(i).padStart(2, '0')}`, { internalDate: T0 - (25 - i) * 60000 }));
  const env = loadRelay({
    messages: [old, gmailMessage('done', { internalDate: T0 - 999999 }), gmailMessage('hold', { internalDate: T0 - 999998 }), ...msgs],
    props: { processed: JSON.stringify({ done: T0 }), held: JSON.stringify({ hold: T0 }) },
  });
  runThrows(env, /保留/); // the held message keeps the failure notice going
  const sentIds = env.fetches.map(f => f.payload.message.id);
  assert.equal(sentIds.length, 20);
  const expected = msgs.slice(0, 20).map(m => sha(`mid:${m.id}@mail.example.invalid`));
  assert.deepEqual(sentIds, expected, 'oldest first');
  assert.ok(!env.gets.some(g => g.id === 'done' || g.id === 'hold'), 'processed / held not fetched');
  assert.ok(!env.fetches.some(f => f.payload.message.id === sha('mid:old@mail.example.invalid')));
  assert.ok(env.json('processed').old, 'a message before START_DATE is recorded so it is not fetched again');
  runThrows(env, /保留/);
  assert.equal(env.fetches.length, 25, 'the remaining 5 on the next run');
});

test('payload: action, ingestKey, source yuki, dryRun, message fields, worker; POST JSON to the configured URL', () => {
  const env = loadRelay({ messages: [gmailMessage('m1', { subject: '架空の通知 1' })] });
  run(env);
  assert.equal(env.fetches.length, 1);
  const { url, options, payload } = env.fetches[0];
  assert.equal(url, GAS_URL);
  assert.equal(options.method, 'post');
  assert.equal(options.contentType, 'application/json');
  assert.equal(options.muteHttpExceptions, true);
  assert.equal(options.followRedirects, true);
  assert.equal(payload.action, 'ingestEmail');
  assert.equal(payload.ingestKey, SECRET);
  assert.equal(payload.source, 'yuki');
  assert.equal(payload.dryRun, false);
  assert.deepEqual(Object.keys(payload.message).sort(), ['html', 'id', 'receivedAt', 'subject', 'text']);
  assert.equal(payload.message.subject, '架空の通知 1');
  assert.equal(payload.message.text, '本文 m1');
  assert.equal(payload.message.html, '<p>本文 m1</p>');
  assert.equal(payload.message.receivedAt, new Date(T0).toISOString());
  assert.equal(payload.worker.name, 'card-notice-relay');
  assert.match(payload.worker.version, /^[A-Za-z0-9._-]{1,40}$/);
  assert.equal(env.gets[0].format, 'full');
});

test('DRY_RUN=1 sends dryRun: true and records nothing', () => {
  const env = loadRelay({ props: { DRY_RUN: '1' }, messages: [gmailMessage('m1')], respond: () => ({ success: true, dryRun: true, parsed: 1 }) });
  run(env);
  run(env);
  assert.equal(env.fetches.length, 2);
  assert.equal(env.fetches[0].payload.dryRun, true);
  assert.deepEqual(env.json('processed') || {}, {});
});

test('SUBJECT_INCLUDES: a subject without the word is marked processed without being sent', () => {
  const env = loadRelay({ props: { SUBJECT_INCLUDES: '通知' }, messages: [gmailMessage('a', { subject: '関係ないメール', internalDate: T0 - 2 }), gmailMessage('b', { subject: '架空の通知', internalDate: T0 - 1 })] });
  run(env);
  assert.equal(env.fetches.length, 1);
  assert.equal(env.fetches[0].payload.message.subject, '架空の通知');
  assert.ok(env.json('processed').a);
});

// ================================================================ bodies

test('nested multipart and a forwarded message/rfc822 part are searched for text and html', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [textPart('転送します'), textPart('<p>転送します</p>', { mime: 'text/html' })] },
      {
        mimeType: 'message/rfc822', filename: 'forwarded.eml', headers: [{ name: 'Content-Type', value: 'message/rfc822' }], body: { size: 0 },
        parts: [{ mimeType: 'multipart/alternative', parts: [textPart('内側の本文'), textPart('<b>内側</b>', { mime: 'text/html' })] }],
      },
      { mimeType: 'text/plain', filename: 'memo.txt', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="memo.txt"' }], body: { data: b64url(Buffer.from('添付は読まない')) } },
    ],
  };
  const env = loadRelay({ messages: [gmailMessage('m1', { payload })] });
  run(env);
  const { text, html } = env.fetches[0].payload.message;
  assert.equal(text, '転送します\n\n内側の本文');
  assert.equal(html, '<p>転送します</p>\n\n<b>内側</b>');
});

test('a large part returned as attachmentId only is fetched with Attachments.get', () => {
  const payload = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { size: 300000, attachmentId: 'att-1' } }] };
  const env = loadRelay({ messages: [gmailMessage('m1', { payload })], attachments: { 'att-1': b64url(Buffer.from('<p>大きな本文</p>')) } });
  run(env);
  assert.equal(env.fetches[0].payload.message.html, '<p>大きな本文</p>');
  assert.equal(env.fetches[0].payload.message.text, '');
  assert.ok(env.gets.some(g => g.attachmentId === 'att-1' && g.id === 'm1' && g.user === 'me'));
});

test('charset: normalization table', () => {
  const env = loadRelay();
  const n = env.relay.normalizeCharset_;
  for (const [input, out] of [
    ['shift_jis', 'Windows-31J'], ['Shift-JIS', 'Windows-31J'], ['SJIS', 'Windows-31J'], ['x-sjis', 'Windows-31J'], ['cp932', 'Windows-31J'],
    ['MS932', 'Windows-31J'], ['windows-31j', 'Windows-31J'], ['iso-2022-jp', 'ISO-2022-JP'], ['ISO-2022-JP-2', 'ISO-2022-JP'], ['csISO2022JP', 'ISO-2022-JP'],
    ['euc-jp', 'EUC-JP'], ['x-euc-jp', 'EUC-JP'], ['utf-8', 'UTF-8'], ['UTF8', 'UTF-8'], ['', 'UTF-8'], [undefined, 'UTF-8'], ['koi8-r', 'UTF-8'],
  ]) assert.equal(n(input), out, String(input));
});

test('charset: Shift_JIS (Windows-31J), ISO-2022-JP, EUC-JP and UTF-8 bodies are decoded; unknown or failing -> UTF-8', () => {
  const tesuto = {
    shift_jis: Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x31, 0x30, 0x30, 0x89, 0x7e]),
    'iso-2022-jp': Buffer.from([0x1b, 0x24, 0x42, 0x25, 0x46, 0x25, 0x39, 0x25, 0x48, 0x1b, 0x28, 0x42, 0x31, 0x30, 0x30, 0x1b, 0x24, 0x42, 0x31, 0x5f, 0x1b, 0x28, 0x42]),
    'euc-jp': Buffer.from([0xa5, 0xc6, 0xa5, 0xb9, 0xa5, 0xc8, 0x31, 0x30, 0x30, 0xb1, 0xdf]),
    'utf-8': Buffer.from('テスト100円', 'utf8'),
  };
  for (const [charset, bytes] of Object.entries(tesuto)) {
    const payload = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: `text/plain; charset=${charset}` }], body: { data: b64url(bytes) } };
    const env = loadRelay({ messages: [gmailMessage('m1', { payload })] });
    run(env);
    assert.equal(env.fetches[0].payload.message.text, 'テスト100円', charset);
  }
  // unknown name and a decoder exception both fall back to UTF-8
  const utf = Buffer.from('テスト100円', 'utf8');
  for (const charset of ['x-unknown', 'iso-2022-jp']) {
    const payload = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: `text/plain; charset="${charset}"` }], body: { data: b64url(utf) } };
    const env = loadRelay({ messages: [gmailMessage('m1', { payload })] });
    if (charset === 'iso-2022-jp') {
      const original = env.relay.Utilities.newBlob;
      env.relay.Utilities.newBlob = bytes => ({ getDataAsString: cs => { if (cs !== 'UTF-8') throw new Error('decode failure'); return original(bytes).getDataAsString(cs); } });
    }
    run(env);
    assert.equal(env.fetches[0].payload.message.text, 'テスト100円', charset);
  }
});

// ================================================================ id

test('id: SHA-256 of the normalized Message-ID; Gmail id when there is none', () => {
  const cases = [
    ['  <abc.123@mail.example.invalid>  ', sha('mid:abc.123@mail.example.invalid')],
    ['abc.123@mail.example.invalid', sha('mid:abc.123@mail.example.invalid')],
    ['<>', sha('gmail:g1')],
    [null, sha('gmail:g1')],
  ];
  for (const [messageId, expected] of cases) {
    const env = loadRelay({ messages: [gmailMessage('g1', { messageId })] });
    run(env);
    assert.equal(env.fetches[0].payload.message.id, expected, String(messageId));
    assert.match(env.fetches[0].payload.message.id, /^[0-9a-f]{64}$/);
  }
  // header names are case-insensitive
  const env = loadRelay({ messages: [gmailMessage('g2', { messageId: null, payload: { mimeType: 'text/plain', headers: [{ name: 'message-id', value: '<x@mail.example.invalid>' }, { name: 'subject', value: '件名' }], body: { data: b64url(Buffer.from('x')) } } })] });
  run(env);
  assert.equal(env.fetches[0].payload.message.id, sha('mid:x@mail.example.invalid'));
  assert.equal(env.fetches[0].payload.message.subject, '件名');
});

// ================================================================ responses (§4.5)

const threeMessages = () => [gmailMessage('a', { internalDate: T0 - 3 }), gmailMessage('b', { internalDate: T0 - 2 }), gmailMessage('c', { internalDate: T0 - 1 })];

test('response table: what is recorded and whether the run continues', () => {
  const cases = [
    // [response, recorded as, continue to the next message, throws]
    [{ success: true, parsed: 1, added: 1 }, 'processed', true, false],
    [{ success: true, duplicate: true }, 'processed', true, false],
    [{ success: true, parsed: 0, result: 'noItems' }, 'processed', true, false],
    [{ success: true, dryRun: true, parsed: 1 }, null, true, false],
    [{ error: 'Busy' }, null, false, false],
    [{ error: 'RateLimited' }, null, false, false],
    [{ __code: 500, __text: 'Internal error' }, null, false, false],
    [{ __code: 503, __text: '' }, null, false, false],
    [new Error(`network down ${GAS_URL}`), null, false, false],
    [{ error: 'Unauthorized' }, null, false, /Unauthorized/],
    [{ error: 'Forbidden' }, 'held', true, /保留/],
    [{ error: 'InvalidMessage' }, 'held', true, /保留/],
    [{ error: 'TooLarge' }, 'held', true, /保留/],
    [{ error: 'IngestError' }, 'held', true, /保留/],
    [{ __code: 200, __text: '<html>not json</html>' }, 'held', true, /保留/],
    [{ success: true }, 'held', true, /保留/],
  ];
  for (const [response, recorded, continues, throws] of cases) {
    const label = JSON.stringify(response instanceof Error ? 'Error' : response);
    const env = loadRelay({ messages: threeMessages(), respond: (p, n) => (n === 1 ? response : { success: true, parsed: 1, added: 1 }) });
    if (throws) runThrows(env, throws); else run(env);
    const processed = env.json('processed') || {};
    const held = env.json('held') || {};
    assert.equal(Boolean(processed.a), recorded === 'processed', `${label}: processed`);
    assert.equal(Boolean(held.a), recorded === 'held', `${label}: held`);
    assert.equal(env.fetches.length, continues ? 3 : 1, `${label}: continues`);
    if (continues) assert.ok(processed.b && processed.c, `${label}: later messages processed`);
    const lastRun = env.json('last_run');
    assert.ok(lastRun && typeof lastRun.at === 'string', `${label}: last_run`);
  }
});

test('held messages keep the failure notice going until "retry held" clears them', () => {
  const env = loadRelay({ messages: threeMessages(), respond: p => (p.message.id === sha('mid:b@mail.example.invalid') ? { error: 'Forbidden' } : { success: true, parsed: 1, added: 1 }) });
  runThrows(env, /保留/);
  runThrows(env, /保留/); // nothing new to send, but still held
  assert.equal(env.fetches.length, 3);
  const t = token(env);
  const r = env.relay.relayRetryHeld(t);
  assert.equal(r.ok, true);
  assert.deepEqual(env.json('held'), {});
  runThrows(env, /保留/); // b is sent again (still Forbidden here, so held again)
  assert.equal(env.fetches.length, 4);
  assert.equal(Object.keys(env.json('held')).length, 1);
});

test('old processed / held entries are pruned after LOOKBACK_DAYS + 7 days', () => {
  const day = 86400000;
  const env = loadRelay({ props: { processed: JSON.stringify({ old: T0 - 15 * day, recent: T0 - 2 * day }), held: JSON.stringify({ oldHeld: T0 - 15 * day }) } });
  run(env);
  assert.deepEqual(Object.keys(env.json('processed')), ['recent']);
  assert.deepEqual(env.json('held'), {});
});

test('a run stops after about 4 minutes (the rest waits for the next run)', () => {
  const env = loadRelay({ messages: threeMessages(), respond: () => { env.clock.now += 150000; return { success: true, parsed: 1, added: 1 }; } });
  run(env);
  assert.equal(env.fetches.length, 2);
});

test('the script lock is held by another run: nothing happens', () => {
  const env = loadRelay({ messages: threeMessages(), lockAvailable: false });
  run(env);
  assert.equal(env.lists.length, 0);
  assert.equal(env.fetches.length, 0);
});

test('logs, exceptions and last_run carry counts and codes only', () => {
  const env = loadRelay({
    props: { SUBJECT_INCLUDES: '架空' },
    messages: [gmailMessage('secretgmailid1', { subject: '架空の通知 店名テスト', internalDate: T0 - 2 }), gmailMessage('secretgmailid2', { internalDate: T0 - 1 })],
    respond: (p, n) => (n === 1 ? { error: 'InvalidMessage' } : new Error(`fetch failed for ${GAS_URL}?key=${SECRET}`)),
  });
  let message = '';
  try { run(env); } catch (err) { message = String(err && err.message); }
  const env2 = loadRelay({ messages: [gmailMessage('secretgmailid3')], respond: () => ({ error: 'Unauthorized' }) });
  try { run(env2); } catch (err) { message += String(err && err.message); }
  const everything = [message, ...env.logs, ...env2.logs, env.store.get('last_run'), env2.store.get('last_run')].join('\n');
  for (const v of [SECRET, GAS_URL, QUERY, 'from:', '架空の通知', '店名テスト', '本文', 'secretgmailid', sha('mid:secretgmailid1@mail.example.invalid').slice(0, 12), 'mail.example.invalid']) {
    assert.ok(!everything.includes(v), `leaks ${v}`);
  }
  assert.match(env.logs.join('\n'), /relay \w+: matched=\d+ sent=\d+ added=\d+ dup=\d+ skipped=\d+ held=\d+/);
  const lastRun = env.json('last_run');
  for (const [k, v] of Object.entries(lastRun)) assert.ok(typeof v === 'number' || (k === 'at' && !Number.isNaN(Date.parse(v))) || (k === 'result' && /^[a-z]+$/.test(v)), `${k}`);
});

// ================================================================ settings form (web app)

test('doGet: page with viewport meta and a token kept 10 minutes in the user cache; no setting value in the HTML', () => {
  const env = loadRelay({ props: { SUBJECT_INCLUDES: '架空の件名語' } });
  const out = env.relay.doGet({ parameter: {} });
  assert.ok(out.metas.some(([n, c]) => n === 'viewport' && /width=device-width/.test(c)));
  const t = /id="token" value="([^"]+)"/.exec(out.html)[1];
  assert.ok(t.length >= 32);
  assert.ok([...env.cache.values()].includes(t));
  for (const v of [SECRET, GAS_URL, QUERY, '架空の件名語', START]) assert.ok(!out.html.includes(v), v);
});

test('every server function refuses a missing, wrong or expired token', () => {
  const env = loadRelay();
  const valid = token(env);
  const calls = [
    t => env.relay.relayGetStatus(t), t => env.relay.relaySaveSettings(t, { searchQuery: 'from:x' }), t => env.relay.relayTest(t),
    t => env.relay.relayRetryHeld(t), t => env.relay.relayStop(t), t => env.relay.relayDeleteAll(t),
  ];
  for (const call of calls) {
    for (const bad of [undefined, '', 'wrong', valid + 'x', 42]) {
      const r = call(bad);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'token');
    }
  }
  assert.equal(env.store.get('INGEST_SECRET'), SECRET, 'nothing changed');
  env.cache.clear(); // expired
  assert.equal(env.relay.relayGetStatus(valid).error, 'token');
});

test('status: set / unset flags, trigger, dry run, last run counts, held count; never the values', () => {
  const env = loadRelay({ props: { held: JSON.stringify({ a: T0, b: T0 }), last_run: JSON.stringify({ at: new Date(T0).toISOString(), matched: 2, sent: 1, added: 1, dup: 0, skipped: 1, held: 0, result: 'ok' }) } });
  const s = env.relay.relayGetStatus(token(env));
  assert.equal(s.ok, true);
  assert.deepEqual(plain(s.status.configured), { gasUrl: true, ingestSecret: true, searchQuery: true, subjectIncludes: false, startDate: true });
  assert.equal(s.status.trigger, false);
  assert.equal(s.status.dryRun, false);
  assert.equal(s.status.heldCount, 2);
  assert.equal(s.status.lastRun.added, 1);
  const text = JSON.stringify(s);
  for (const v of [SECRET, GAS_URL, QUERY]) assert.ok(!text.includes(v));
});

test('save: validates each field (URL pattern, secret, query, subject word) and saves nothing when one is invalid', () => {
  const invalid = [
    [{ gasUrl: 'http://script.google.com/macros/s/abc/exec' }, 'gasUrl'],
    [{ gasUrl: 'https://script.google.com.evil.example.invalid/macros/s/abc/exec' }, 'gasUrl'],
    [{ gasUrl: 'https://script.google.com/macros/s/abc/dev' }, 'gasUrl'],
    [{ gasUrl: 'https://script.google.com/a/macros/s/abc/exec' }, 'gasUrl'],
    [{ gasUrl: 'https://script.google.com/macros/s/abc/exec?x=1' }, 'gasUrl'],
    [{ gasUrl: 'https://script.google.com/macros/s/abc/exec/' }, 'gasUrl'],
    [{ gasUrl: 'https://script.google.com/macros/s/a.b/exec' }, 'gasUrl'],
    [{ gasUrl: ` ${GAS_URL}\nx` }, 'gasUrl'],
    [{ ingestSecret: 'short' }, 'ingestSecret'],
    [{ ingestSecret: 'x'.repeat(129) }, 'ingestSecret'],
    [{ ingestSecret: `${'a'.repeat(31)}!` }, 'ingestSecret'],
    [{ searchQuery: '架空の通知' }, 'searchQuery'],
    [{ searchQuery: `from:${'x'.repeat(500)}` }, 'searchQuery'],
    [{ subjectIncludes: 'x'.repeat(101) }, 'subjectIncludes'],
    [{ gasUrl: 42 }, 'gasUrl'],
  ];
  for (const [form, field] of invalid) {
    const env = loadRelay();
    const before = JSON.stringify([...env.store]);
    const r = env.relay.relaySaveSettings(token(env), { ingestSecret: 'NewSyntheticSecret0123456789abcdefXYZ', ...form });
    assert.equal(r.ok, false, JSON.stringify(form));
    assert.deepEqual(plain(r.invalidFields), [field], JSON.stringify(form));
    assert.equal(JSON.stringify([...env.store]), before, 'nothing saved');
    assert.equal(env.triggers.length, 0);
    assert.ok(!JSON.stringify(r).includes('NewSyntheticSecret'));
  }
});

test('save on an empty project: required fields must be given', () => {
  const env = loadRelay({ props: { KAKEIBO_GAS_URL: undefined, INGEST_SECRET: undefined, SEARCH_QUERY: undefined, START_DATE: undefined } });
  const r = env.relay.relaySaveSettings(token(env), { dryRun: true });
  assert.equal(r.ok, false);
  assert.deepEqual(plain(r.invalidFields).sort(),['gasUrl', 'ingestSecret', 'searchQuery']);
  assert.equal(env.triggers.length, 0);
});

test('save: stores the values, START_DATE today (kept afterwards), DRY_RUN on/off, exactly one 10-minute trigger; returns no value', () => {
  const env = loadRelay({ props: { KAKEIBO_GAS_URL: undefined, INGEST_SECRET: undefined, SEARCH_QUERY: undefined, START_DATE: undefined }, now: Date.parse('2026-11-09T16:30:00Z') });
  const t = token(env);
  const r = env.relay.relaySaveSettings(t, { gasUrl: ` ${GAS_URL} `, ingestSecret: SECRET, searchQuery: QUERY, subjectIncludes: '通知', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(env.store.get('KAKEIBO_GAS_URL'), GAS_URL);
  assert.equal(env.store.get('INGEST_SECRET'), SECRET);
  assert.equal(env.store.get('SEARCH_QUERY'), QUERY);
  assert.equal(env.store.get('SUBJECT_INCLUDES'), '通知');
  assert.equal(env.store.get('START_DATE'), '2026-11-10', 'today in Asia/Tokyo');
  assert.equal(env.store.get('DRY_RUN'), '1');
  assert.equal(env.triggers.length, 1);
  assert.equal(env.triggers[0].fn, 'relayRun');
  assert.equal(env.triggers[0].everyMinutes, 10);
  const text = JSON.stringify(r);
  for (const v of [SECRET, GAS_URL, QUERY, '通知']) assert.ok(!text.includes(v), v);

  // second save with every field empty: values kept, START_DATE kept, still one trigger, dry run off
  env.clock.now += 5 * 86400000;
  const r2 = env.relay.relaySaveSettings(t, { gasUrl: '', ingestSecret: '', searchQuery: '', subjectIncludes: '', dryRun: false });
  assert.equal(r2.ok, true);
  assert.equal(env.store.get('INGEST_SECRET'), SECRET);
  assert.equal(env.store.get('SEARCH_QUERY'), QUERY);
  assert.equal(env.store.get('SUBJECT_INCLUDES'), '通知');
  assert.equal(env.store.get('START_DATE'), '2026-11-10');
  assert.equal(env.store.has('DRY_RUN'), false);
  assert.equal(env.triggers.length, 1);

  // the subject word can be removed explicitly
  env.relay.relaySaveSettings(t, { clearSubjectIncludes: true, dryRun: false });
  assert.equal(env.store.has('SUBJECT_INCLUDES'), false);
});

test('stop removes every relayRun trigger and keeps the settings; delete all removes triggers and every property', () => {
  const env = loadRelay({ props: { processed: '{}', held: '{}', last_run: '{}' } });
  const t = token(env);
  env.relay.relaySaveSettings(t, { dryRun: false });
  env.relay.relaySaveSettings(t, { dryRun: false });
  assert.equal(env.triggers.length, 1);
  const stopped = env.relay.relayStop(t);
  assert.equal(stopped.ok, true);
  assert.equal(env.triggers.length, 0);
  assert.equal(env.store.get('INGEST_SECRET'), SECRET);
  env.relay.relaySaveSettings(t, { dryRun: false });
  const deleted = env.relay.relayDeleteAll(t);
  assert.equal(deleted.ok, true);
  assert.equal(env.triggers.length, 0);
  assert.equal(env.store.size, 0);
});

test('test button: sends the newest matching mail once with dryRun: true; returns counts and the response code only', () => {
  const env = loadRelay({ messages: threeMessages(), respond: () => ({ success: true, dryRun: true, parsed: 2 }) });
  const r = env.relay.relayTest(token(env));
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.result), { found: 3, parsed: 2, code: 'ok' });
  assert.equal(env.fetches.length, 1);
  assert.equal(env.fetches[0].payload.dryRun, true);
  assert.equal(env.fetches[0].payload.message.id, sha('mid:c@mail.example.invalid'), 'the newest');
  assert.deepEqual(env.json('processed') || {}, {}, 'nothing recorded');

  const none = loadRelay({ messages: [] });
  assert.deepEqual(plain(none.relay.relayTest(token(none)).result), { found: 0, parsed: null, code: 'none' });
  const unauth = loadRelay({ messages: threeMessages(), respond: () => ({ error: 'Unauthorized' }) });
  assert.deepEqual(plain(unauth.relay.relayTest(token(unauth)).result), { found: 3, parsed: null, code: 'Unauthorized' });
  const odd = loadRelay({ messages: threeMessages(), respond: () => ({ error: `<b>${SECRET}</b>` }) });
  assert.deepEqual(plain(odd.relay.relayTest(token(odd)).result), { found: 3, parsed: null, code: 'unexpected' });
  const missing = loadRelay({ props: { SEARCH_QUERY: undefined } });
  assert.deepEqual(plain(missing.relay.relayTest(token(missing))), { ok: false, error: 'notConfigured' });
});

test('no server function returns a setting value (secret, URL, query, subject word)', () => {
  const env = loadRelay({ props: { SUBJECT_INCLUDES: '件名の語' }, messages: threeMessages() });
  const t = token(env);
  const results = [
    env.relay.relayGetStatus(t), env.relay.relaySaveSettings(t, { searchQuery: QUERY, dryRun: true }), env.relay.relayTest(t),
    env.relay.relayRetryHeld(t), env.relay.relayStop(t), env.relay.relayDeleteAll(t),
  ];
  const text = JSON.stringify(results);
  for (const v of [SECRET, GAS_URL, QUERY, '件名の語', 'mail.example.invalid']) assert.ok(!text.includes(v), v);
});

// ================================================================ one message failing to read

const fiveMessages = () => ['a', 'b', 'c', 'd', 'e'].map((id, i) => gmailMessage(id, { internalDate: T0 - 10 + i }));

test('a message that cannot be read (get fails) is held; the following messages are still sent', () => {
  const env = loadRelay({ messages: fiveMessages(), failGet: new Set(['b']) });
  runThrows(env, /保留/);
  assert.equal(env.fetches.length, 4);
  assert.deepEqual(Object.keys(env.json('held')), ['b']);
  assert.deepEqual(Object.keys(env.json('processed')).sort(), ['a', 'c', 'd', 'e']);
  assert.equal(env.json('last_run').result, 'held');
  assert.ok(!env.logs.join('\n').includes('gmail.users'), 'the API error text is not logged');
});

test('a large part whose Attachments.get fails holds that message only', () => {
  const big = { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { size: 300000, attachmentId: 'att-missing' } };
  const msgs = [gmailMessage('a', { internalDate: T0 - 3, payload: { mimeType: 'multipart/alternative', parts: [big] } }), gmailMessage('b', { internalDate: T0 - 2 })];
  const env = loadRelay({ messages: msgs });
  runThrows(env, /保留/);
  assert.equal(env.fetches.length, 1);
  assert.deepEqual(Object.keys(env.json('held')), ['a']);
  assert.ok(env.json('processed').b);
});

test('several reads failing in a row is a Gmail-wide problem: the run stops with the fixed error, nothing is held', () => {
  const env = loadRelay({ messages: fiveMessages(), failGet: new Set(['a', 'b', 'c', 'd', 'e']) });
  runThrows(env, /Gmail/);
  assert.equal(env.fetches.length, 0);
  assert.deepEqual(env.json('held'), {});
  assert.deepEqual(env.json('processed'), {});
  assert.equal(env.json('last_run').result, 'gmail');
  // two failures followed by a success are held, not a stop
  const two = loadRelay({ messages: fiveMessages(), failGet: new Set(['a', 'b']) });
  runThrows(two, /保留/);
  assert.equal(two.fetches.length, 3);
  assert.deepEqual(Object.keys(two.json('held')).sort(), ['a', 'b']);
});

test('the search itself failing (quota, permission) stops the run with the fixed error', () => {
  const env = loadRelay({ messages: fiveMessages(), failList: true });
  const err = assert.throws(() => run(env), /Gmail/);
  void err;
  assert.equal(env.fetches.length, 0);
  assert.equal(env.json('last_run').result, 'gmail');
  assert.ok(!env.logs.join('\n').includes('quota'));
});

// ================================================================ settings page script (client side)

function loadPage({ statusResult, failStatus = false } = {}) {
  const script = /<script>([^]*?)<\/script>/.exec(settingsHtml)[1];
  const ids = [...settingsHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const elements = {};
  for (const id of ids) {
    const tag = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(settingsHtml)[0];
    const children = [];
    elements[id] = {
      id, value: id === 'token' ? 'T'.repeat(64) : '', className: '', textContent: '',
      checked: /\schecked[\s>]/.test(tag), disabled: /\sdisabled[\s>]/.test(tag), listeners: {},
      get firstChild() { return children[0] || null; },
      removeChild: c => children.splice(children.indexOf(c), 1),
      appendChild: c => children.push(c),
      addEventListener(type, fn) { this.listeners[type] = fn; },
      click() { if (!this.disabled && this.listeners.click) this.listeners.click(); },
    };
  }
  const calls = [];
  const runner = () => {
    let ok = () => {};
    let fail = () => {};
    const r = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'withSuccessHandler') return fn => { ok = fn; return r; };
        if (prop === 'withFailureHandler') return fn => { fail = fn; return r; };
        return (...args) => {
          calls.push({ name: prop, args });
          if (prop === 'relayGetStatus') { if (failStatus) fail(new Error('x')); else ok(statusResult); }
          else ok({ ok: true });
        };
      },
    });
    return r;
  };
  const sandbox = {
    document: { getElementById: id => elements[id], createElement: () => ({ textContent: '' }) },
    window: { confirm: () => true },
    google: { script: { get run() { return runner(); } } },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { elements, calls };
}

const pageStatus = (over = {}) => ({
  ok: true,
  status: {
    configured: { gasUrl: true, ingestSecret: true, searchQuery: true, subjectIncludes: false, startDate: true },
    trigger: true, dryRun: false, heldCount: 0, lastRun: null, version: 'relay-v1', ...over,
  },
});

test('settings page: the dry-run box is not checked by markup and Save stays disabled until the status loads', () => {
  assert.match(settingsHtml, /<input type="checkbox" id="dryRun">/);
  assert.match(settingsHtml, /<button type="button" id="save" disabled>/);

  const failed = loadPage({ failStatus: true });
  assert.equal(failed.elements.save.disabled, true, 'status failed to load: cannot save');
  failed.elements.save.click();
  assert.ok(!failed.calls.some(c => c.name === 'relaySaveSettings'));
  assert.match(failed.elements.message.textContent, /開き直/);

  const refused = loadPage({ statusResult: { ok: false, error: 'token' } });
  assert.equal(refused.elements.save.disabled, true, 'status refused: cannot save');

  const live = loadPage({ statusResult: pageStatus({ dryRun: false }) });
  assert.equal(live.elements.save.disabled, false);
  assert.equal(live.elements.dryRun.checked, false, 'reflects the saved state (production)');
  live.elements.save.click();
  const save = live.calls.find(c => c.name === 'relaySaveSettings');
  assert.equal(save.args[1].dryRun, false, 'saving with empty fields keeps production mode');

  const dry = loadPage({ statusResult: pageStatus({ dryRun: true }) });
  assert.equal(dry.elements.dryRun.checked, true);

  const first = loadPage({ statusResult: pageStatus({ configured: { gasUrl: false, ingestSecret: false, searchQuery: false, subjectIncludes: false, startDate: false }, trigger: false }) });
  assert.equal(first.elements.dryRun.checked, true, 'first save defaults to dry run');
});

test('the guide keeps the required order: chapter 0 first, chapter 7 (clasp clean-up) before chapter 8 (consent); clasp pinned', () => {
  const pos = n => guide.search(new RegExp(`^## ${n}\\.`, 'm'));
  for (let i = 0; i <= 11; i++) assert.ok(pos(i) >= 0, `chapter ${i}`);
  for (let i = 1; i <= 11; i++) assert.ok(pos(i - 1) < pos(i), `chapter ${i - 1} before ${i}`);
  assert.match(guide, /@google\/clasp@3\.4\.1/);
  assert.doesNotMatch(guide, /@google\/clasp(?!@3\.4\.1)(@|\s)/);
  assert.match(guide, /test -e ~\/\.clasprc\.json && echo clasp-token-exists/);
  assert.match(guide, /test ! -e ~\/\.clasprc\.json && echo removed/);
});
