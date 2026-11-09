/**
 * 家計簿取込(中継スクリプト) card-notice-relay
 *
 * 利用者自身の Google アカウントで動く Apps Script。利用者の Gmail から
 * カード会社の利用通知を読み取り(gmail.readonly のみ)、本文を家計簿の
 * Apps Script(ingestEmail)へ送る。設計: docs/design/2026-11-yuki-phase2-card-import.md §4。
 *
 * - Gmail は拡張サービス(Gmail API v1)の list / get / attachments.get だけを使う。
 *   書き込み・削除・送信・ラベル付け・既読化はしない(その権限も持たない)。
 * - 外への通信は家計簿の Web アプリの URL(形式を限定)への HTTPS POST だけ。
 * - 検索条件・送り先の URL・取込用の鍵は Script Properties(設定フォームで利用者が入れる)。
 *   このファイルに具体値は書かない。
 * - ログ・例外・状態表示には件数・時刻・結果コードだけを出す
 *   (件名・差出人・本文・店名・金額・ID・URL・鍵・検索条件は出さない)。
 * - 設定フォーム(doGet)は google.script.run からの呼び出しだけで書き込む。POST の入口は作らない。
 *   ページから呼べるのは末尾が _ でない関数だけ(_ で終わる関数はページから呼べない)。
 */

const RELAY_NAME = 'card-notice-relay';
const RELAY_VERSION = 'relay-v1';
const RELAY_TIME_ZONE = 'Asia/Tokyo';
const RELAY_TRIGGER_FUNCTION = 'relayRun';
const RELAY_TRIGGER_MINUTES = 10;
const RELAY_SOURCE = 'yuki';
const RELAY_GAS_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const RELAY_SECRET_PATTERN = /^[A-Za-z0-9]{32,128}$/;
const RELAY_START_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RELAY_MAX_QUERY_LENGTH = 500;
const RELAY_MAX_SUBJECT_WORD_LENGTH = 100;
const RELAY_DEFAULT_LOOKBACK_DAYS = 7;
const RELAY_MAX_LOOKBACK_DAYS = 30;
const RELAY_LIST_MAX = 50;
const RELAY_SEND_MAX = 20;
const RELAY_RUN_BUDGET_MS = 4 * 60 * 1000; // Apps Script の上限は 6 分
const RELAY_DAY_MS = 24 * 60 * 60 * 1000;
const RELAY_KEEP_EXTRA_DAYS = 7; // 処理済み・保留の記録は LOOKBACK_DAYS + 7 日で消す
const RELAY_MAX_PART_DEPTH = 10;
const RELAY_MAX_READ_FAILURES_IN_A_ROW = 3; // 続けてこの数だけ読めなければ Gmail 全体の問題とみなす
const RELAY_FORM_TOKEN_KEY = 'relay_form_token';
const RELAY_FORM_TOKEN_TTL_SECONDS = 600;
const RELAY_FORM_LOCK_MS = 30000;
// 家計簿の応答の error のうち、そのまま「試す」の結果に出してよいもの
const RELAY_KNOWN_ERRORS = ['Unauthorized', 'Forbidden', 'InvalidMessage', 'TooLarge', 'RateLimited', 'Busy', 'IngestError'];

const RELAY_PROPS = Object.freeze({
  gasUrl: 'KAKEIBO_GAS_URL',
  ingestSecret: 'INGEST_SECRET',
  searchQuery: 'SEARCH_QUERY',
  startDate: 'START_DATE',
  subjectIncludes: 'SUBJECT_INCLUDES',
  lookbackDays: 'LOOKBACK_DAYS',
  dryRun: 'DRY_RUN',
  processed: 'processed',
  held: 'held',
  lastRun: 'last_run'
});

const RELAY_CONFIG_ERROR = '中継スクリプトの設定が足りないか、形式が正しくありません。設定フォームを開いて確認してください。';
const RELAY_UNAUTHORIZED_ERROR = '家計簿が取込の鍵を受け付けませんでした(Unauthorized)。管理者から新しい値を受け取り、設定フォームで入れ直してください。';
const RELAY_GMAIL_ERROR = 'Gmail の読み取りに失敗しました。続くようなら設定フォームを開き直し、必要なら許可をやり直してください。';

// ================================================================ 取込(時間主導トリガー)

// 10 分ごとのトリガーから呼ばれる。別の実行が動いていれば何もしない。
function relayRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    relayRunLocked_();
  } finally {
    lock.releaseLock();
  }
}

function relayRunLocked_() {
  const config = readRunConfig_();
  const startedAt = Date.now();
  const keepMs = (config.lookbackDays + RELAY_KEEP_EXTRA_DAYS) * RELAY_DAY_MS;
  const processed = pruneRecord_(readRecord_(RELAY_PROPS.processed), startedAt, keepMs);
  const held = pruneRecord_(readRecord_(RELAY_PROPS.held), startedAt, keepMs);
  const counts = {matched: 0, sent: 0, added: 0, dup: 0, skipped: 0, noItems: 0, held: 0};
  let stop = null; // 'retry' | 'unauthorized' | 'gmail'

  try {
    const ids = listMessageIds_(config);
    counts.matched = ids.length;
    // list は新しい順。古い順に処理する
    const candidates = ids.filter(id => !hasOwn_(processed, id) && !hasOwn_(held, id)).reverse();
    // 1 通の取得・本文の組み立てに失敗したら、そのメールを保留にして次へ進む。
    // 続けて失敗するのは Gmail 全体の問題(許可・割当など)とみなし、保留にせず回を止める。
    const failedInARow = [];
    for (const gmailId of candidates) {
      if (counts.sent >= RELAY_SEND_MAX) break;
      if (Date.now() - startedAt > RELAY_RUN_BUDGET_MS) break;
      const read = readMessageForRelay_(config, gmailId);
      if (read.error) {
        held[gmailId] = Date.now();
        failedInARow.push(gmailId);
        if (failedInARow.length >= RELAY_MAX_READ_FAILURES_IN_A_ROW) {
          failedInARow.forEach(id => { delete held[id]; });
          stop = 'gmail';
          break;
        }
        continue;
      }
      failedInARow.length = 0;
      if (read.skip) {
        processed[gmailId] = Date.now();
        counts.skipped++;
        continue;
      }
      const payload = read.payload;
      counts.sent++;
      const outcome = postToKakeibo_(config, payload);
      if (outcome.kind === 'processed') {
        processed[gmailId] = Date.now();
        if (outcome.duplicate) counts.dup++;
        else if (outcome.noItems) counts.noItems++;
        else counts.added += outcome.added;
      } else if (outcome.kind === 'held') {
        held[gmailId] = Date.now();
      } else if (outcome.kind === 'retry' || outcome.kind === 'unauthorized') {
        stop = outcome.kind;
        break;
      }
      // 'dry': お試しモード。記録しない(外した後に本番で送る)
    }
  } catch (err) {
    stop = 'gmail';
  } finally {
    counts.held = Object.keys(held).length;
    const result = stop === 'unauthorized' ? 'unauthorized'
      : stop === 'gmail' ? 'gmail'
        : stop === 'retry' ? 'retry'
          : counts.held > 0 ? 'held' : 'ok';
    writeRecord_(RELAY_PROPS.processed, processed);
    writeRecord_(RELAY_PROPS.held, held);
    const lastRun = Object.assign({at: new Date(Date.now()).toISOString()}, counts, {result: result});
    PropertiesService.getScriptProperties().setProperty(RELAY_PROPS.lastRun, JSON.stringify(lastRun));
    console.log(`relay ${result}: matched=${counts.matched} sent=${counts.sent} added=${counts.added} dup=${counts.dup} skipped=${counts.skipped} held=${counts.held} noItems=${counts.noItems}`);
  }

  if (stop === 'unauthorized') throw new Error(RELAY_UNAUTHORIZED_ERROR);
  if (stop === 'gmail') throw new Error(RELAY_GMAIL_ERROR);
  if (counts.held > 0) {
    throw new Error(`保留中のメールが ${counts.held} 通あります。管理者に連絡し、原因を直したあと設定フォームの「保留を再送」を押してください。`);
  }
}

// 1 通を読み、{payload} / {skip: true}(開始日より前・件名の語が無い)/ {error: true} を返す。
// 例外の中身(ID 等を含み得る)は使わない。
function readMessageForRelay_(config, gmailId) {
  try {
    const message = Gmail.Users.Messages.get('me', gmailId, {format: 'full'});
    if (Number(message.internalDate) < config.startMs) return {skip: true};
    const subject = findHeader_((message.payload || {}).headers, 'Subject');
    if (config.subjectIncludes && subject.indexOf(config.subjectIncludes) === -1) return {skip: true};
    return {payload: buildIngestPayload_(config, message, config.dryRun)};
  } catch (err) {
    return {error: true};
  }
}

// ================================================================ 設定

// 取込に必要な設定。欠けている・形式が違えば固定文言の例外(値は出さない)。
function readRunConfig_() {
  const config = readSendConfig_();
  const props = PropertiesService.getScriptProperties();
  const startDate = props.getProperty(RELAY_PROPS.startDate);
  if (!config || !startDate || !RELAY_START_DATE_PATTERN.test(startDate)) throw new Error(RELAY_CONFIG_ERROR);
  const startMs = Date.parse(`${startDate}T00:00:00+09:00`);
  if (isNaN(startMs)) throw new Error(RELAY_CONFIG_ERROR);
  config.startMs = startMs;
  return config;
}

// 送信に必要な設定(「試す」でも使う)。足りなければ null。
function readSendConfig_() {
  const props = PropertiesService.getScriptProperties();
  const gasUrl = props.getProperty(RELAY_PROPS.gasUrl);
  const secret = props.getProperty(RELAY_PROPS.ingestSecret);
  const query = props.getProperty(RELAY_PROPS.searchQuery);
  if (!gasUrl || !RELAY_GAS_URL_PATTERN.test(gasUrl)) return null;
  if (!secret || !RELAY_SECRET_PATTERN.test(secret)) return null;
  if (!query || query.length > RELAY_MAX_QUERY_LENGTH) return null;
  return {
    gasUrl: gasUrl,
    secret: secret,
    query: query,
    subjectIncludes: props.getProperty(RELAY_PROPS.subjectIncludes) || '',
    lookbackDays: readLookbackDays_(props.getProperty(RELAY_PROPS.lookbackDays)),
    dryRun: props.getProperty(RELAY_PROPS.dryRun) === '1'
  };
}

function readLookbackDays_(value) {
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) return RELAY_DEFAULT_LOOKBACK_DAYS;
  const days = Number(value);
  return days >= 1 && days <= RELAY_MAX_LOOKBACK_DAYS ? days : RELAY_DEFAULT_LOOKBACK_DAYS;
}

// 利用者の検索式に、範囲の上限(newer_than)とゴミ箱の除外を必ず付ける
function buildSearchQuery_(config) {
  return `(${config.query}) newer_than:${config.lookbackDays}d -in:trash`;
}

// ================================================================ 処理済み・保留の記録 {gmailId: 記録した時刻(ms)}

function hasOwn_(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readRecord_(name) {
  const raw = PropertiesService.getScriptProperties().getProperty(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function pruneRecord_(record, now, keepMs) {
  const kept = {};
  Object.keys(record).forEach(id => {
    const t = record[id];
    if (typeof t === 'number' && t > now - keepMs) kept[id] = t;
  });
  return kept;
}

function writeRecord_(name, record) {
  PropertiesService.getScriptProperties().setProperty(name, JSON.stringify(record));
}

// ================================================================ Gmail(読み取りのみ)

function listMessageIds_(config) {
  const response = Gmail.Users.Messages.list('me', {
    q: buildSearchQuery_(config),
    maxResults: RELAY_LIST_MAX,
    includeSpamTrash: true
  });
  const messages = response && Array.isArray(response.messages) ? response.messages : [];
  return messages.map(m => m && m.id).filter(id => typeof id === 'string' && id !== '');
}

function findHeader_(headers, name) {
  if (!Array.isArray(headers)) return '';
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (header && typeof header.name === 'string' && header.name.toLowerCase() === lower) return String(header.value || '');
  }
  return '';
}

// 家計簿へ送る本文。text/plain と text/html を集める(multipart の入れ子、
// message/rfc822 で包まれた転送の中も探す。添付ファイルの text は読まない)。
function collectBodies_(gmailId, payload) {
  const found = {text: [], html: []};
  walkPart_(gmailId, payload, 0, found);
  return {text: found.text.join('\n\n'), html: found.html.join('\n\n')};
}

function walkPart_(gmailId, part, depth, found) {
  if (!part || depth > RELAY_MAX_PART_DEPTH) return;
  const mimeType = String(part.mimeType || '').toLowerCase();
  if (mimeType.indexOf('multipart/') === 0 || mimeType === 'message/rfc822') {
    (Array.isArray(part.parts) ? part.parts : []).forEach(child => walkPart_(gmailId, child, depth + 1, found));
    return;
  }
  if (mimeType !== 'text/plain' && mimeType !== 'text/html') return;
  const disposition = findHeader_(part.headers, 'Content-Disposition').toLowerCase();
  if (part.filename || disposition.indexOf('attachment') === 0) return;
  const text = readPartText_(gmailId, part);
  if (text === '') return;
  (mimeType === 'text/plain' ? found.text : found.html).push(text);
}

// パートの中身を文字列に戻す。大きなパートは attachmentId だけが返るので別に取る。
function readPartText_(gmailId, part) {
  const body = part.body || {};
  let data = body.data;
  if (!data && body.attachmentId) {
    const attachment = Gmail.Users.Messages.Attachments.get('me', gmailId, body.attachmentId);
    data = attachment && attachment.data;
  }
  if (!data) return '';
  const bytes = Utilities.base64DecodeWebSafe(String(data));
  const charset = normalizeCharset_(readCharset_(findHeader_(part.headers, 'Content-Type')));
  try {
    return Utilities.newBlob(bytes).getDataAsString(charset);
  } catch (err) {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
}

function readCharset_(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(String(contentType || ''));
  return match ? match[1] : '';
}

// 文字コード名の正規化(設計 §4.3)。指定なし・不明は UTF-8。
function normalizeCharset_(name) {
  const value = String(name || '').trim().toLowerCase().replace(/_/g, '-');
  if (['shift-jis', 'sjis', 'x-sjis', 'cp932', 'ms932', 'windows-31j', 'csshiftjis'].indexOf(value) !== -1) return 'Windows-31J';
  if (value === 'iso-2022-jp' || value.indexOf('iso-2022-jp-') === 0 || value === 'csiso2022jp') return 'ISO-2022-JP';
  if (value === 'euc-jp' || value === 'x-euc-jp' || value === 'cseucpkdfmtjapanese') return 'EUC-JP';
  return 'UTF-8';
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('');
}

// メールの ID: Message-ID(山括弧と前後の空白を除く)があればそれ、無ければ Gmail の ID から
function messageKey_(gmailId, headers) {
  const raw = findHeader_(headers, 'Message-ID').trim().replace(/^</, '').replace(/>$/, '').trim();
  return raw !== '' ? sha256Hex_(`mid:${raw}`) : sha256Hex_(`gmail:${gmailId}`);
}

function buildIngestPayload_(config, message, dryRun) {
  const payload = message.payload || {};
  const bodies = collectBodies_(message.id, payload);
  return {
    action: 'ingestEmail',
    ingestKey: config.secret,
    source: RELAY_SOURCE,
    dryRun: dryRun === true,
    message: {
      id: messageKey_(message.id, payload.headers),
      receivedAt: new Date(Number(message.internalDate)).toISOString(),
      subject: findHeader_(payload.headers, 'Subject'),
      text: bodies.text,
      html: bodies.html
    },
    worker: {name: RELAY_NAME, version: RELAY_VERSION}
  };
}

// ================================================================ 家計簿への送信

// 応答の扱い(設計 §4.5)。戻り値は {kind, ...} だけで、応答の中身は返さない。
//   processed: 追加・重複・明細なし / dry: お試し / retry: 次の回に再送 /
//   unauthorized: 鍵が違う / held: そのメールを保留
function postToKakeibo_(config, payload) {
  let response;
  try {
    response = UrlFetchApp.fetch(config.gasUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (err) {
    return {kind: 'retry', code: 'network'};
  }
  const status = response.getResponseCode();
  if (status >= 500) return {kind: 'retry', code: 'server'};
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (err) {
    return {kind: 'held', code: 'unexpected'};
  }
  if (!body || typeof body !== 'object') return {kind: 'held', code: 'unexpected'};
  if (body.success === true) {
    if (body.dryRun === true) return {kind: 'dry', code: 'ok', parsed: typeof body.parsed === 'number' ? body.parsed : null};
    if (body.duplicate === true) return {kind: 'processed', code: 'ok', duplicate: true};
    if (body.result === 'noItems') return {kind: 'processed', code: 'ok', noItems: true};
    if (typeof body.added === 'number') return {kind: 'processed', code: 'ok', added: body.added};
    return {kind: 'held', code: 'unexpected'};
  }
  const error = typeof body.error === 'string' && RELAY_KNOWN_ERRORS.indexOf(body.error) !== -1 ? body.error : 'unexpected';
  if (error === 'Busy' || error === 'RateLimited') return {kind: 'retry', code: error};
  if (error === 'Unauthorized') return {kind: 'unauthorized', code: error};
  return {kind: 'held', code: error};
}

// ================================================================ 設定フォーム(Web アプリ)

function doGet() {
  const token = newFormToken_();
  CacheService.getUserCache().put(RELAY_FORM_TOKEN_KEY, token, RELAY_FORM_TOKEN_TTL_SECONDS);
  const template = HtmlService.createTemplateFromFile('settings');
  template.token = token;
  return template.evaluate()
    .setTitle('家計簿取込の設定')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function newFormToken_() {
  return sha256Hex_([Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now()), String(Math.random())].join('|'));
}

function isValidFormToken_(token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  const expected = CacheService.getUserCache().get(RELAY_FORM_TOKEN_KEY);
  if (typeof expected !== 'string' || expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// フォームから呼ぶ関数の共通部分: トークンの確認、例外は固定のコードだけにする
function formAction_(token, fn) {
  if (!isValidFormToken_(token)) return {ok: false, error: 'token'};
  try {
    return fn();
  } catch (err) {
    console.error('relay form: internal error');
    return {ok: false, error: 'internal'};
  }
}

// relayRun と重ならないようにロックを取ってから書き換える
function withFormLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(RELAY_FORM_LOCK_MS)) return {ok: false, error: 'busy'};
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function relayTriggers_() {
  return ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === RELAY_TRIGGER_FUNCTION);
}

function deleteRelayTriggers_() {
  relayTriggers_().forEach(t => ScriptApp.deleteTrigger(t));
}

// 状態(設定済みかどうか・件数・時刻だけ。値は返さない)
function buildStatus_() {
  const props = PropertiesService.getScriptProperties();
  const has = name => Boolean(props.getProperty(name));
  const gasUrl = props.getProperty(RELAY_PROPS.gasUrl);
  let lastRun = null;
  const rawLastRun = readRecord_(RELAY_PROPS.lastRun);
  if (typeof rawLastRun.at === 'string') {
    lastRun = {at: rawLastRun.at};
    ['matched', 'sent', 'added', 'dup', 'skipped', 'noItems', 'held'].forEach(k => {
      lastRun[k] = typeof rawLastRun[k] === 'number' ? rawLastRun[k] : 0;
    });
    lastRun.result = /^[a-z]{1,20}$/.test(String(rawLastRun.result)) ? rawLastRun.result : 'unknown';
  }
  return {
    configured: {
      gasUrl: Boolean(gasUrl) && RELAY_GAS_URL_PATTERN.test(gasUrl),
      ingestSecret: has(RELAY_PROPS.ingestSecret),
      searchQuery: has(RELAY_PROPS.searchQuery),
      subjectIncludes: has(RELAY_PROPS.subjectIncludes),
      startDate: has(RELAY_PROPS.startDate)
    },
    trigger: relayTriggers_().length > 0,
    dryRun: props.getProperty(RELAY_PROPS.dryRun) === '1',
    heldCount: Object.keys(readRecord_(RELAY_PROPS.held)).length,
    lastRun: lastRun,
    version: RELAY_VERSION
  };
}

function relayGetStatus(token) {
  return formAction_(token, () => ({ok: true, status: buildStatus_()}));
}

// 入力欄の検証。空欄(または未入力)は null(既存の値を保つ)。不正なら invalid に欄名。
function readFormField_(form, name, invalid, validate) {
  const value = form[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    invalid.push(name);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!validate(trimmed)) {
    invalid.push(name);
    return null;
  }
  return trimmed;
}

function todayInTokyo_() {
  return Utilities.formatDate(new Date(), RELAY_TIME_ZONE, 'yyyy-MM-dd');
}

// 「保存して開始」: 入力を検証して保存 → START_DATE が無ければ今日 → トリガーを 1 つにする
function relaySaveSettings(token, form) {
  return formAction_(token, () => {
    const input = form && typeof form === 'object' ? form : {};
    const invalid = [];
    const gasUrl = readFormField_(input, 'gasUrl', invalid, v => RELAY_GAS_URL_PATTERN.test(v));
    const ingestSecret = readFormField_(input, 'ingestSecret', invalid, v => RELAY_SECRET_PATTERN.test(v));
    const searchQuery = readFormField_(input, 'searchQuery', invalid,
      v => v.length <= RELAY_MAX_QUERY_LENGTH && /(^|\s|\()(from|subject):/i.test(v));
    const subjectIncludes = readFormField_(input, 'subjectIncludes', invalid, v => v.length <= RELAY_MAX_SUBJECT_WORD_LENGTH);

    const props = PropertiesService.getScriptProperties();
    const required = [['gasUrl', gasUrl, RELAY_PROPS.gasUrl], ['ingestSecret', ingestSecret, RELAY_PROPS.ingestSecret], ['searchQuery', searchQuery, RELAY_PROPS.searchQuery]];
    required.forEach(([field, value, prop]) => {
      if (value === null && invalid.indexOf(field) === -1 && !props.getProperty(prop)) invalid.push(field);
    });
    if (invalid.length > 0) return {ok: false, error: 'invalid', invalidFields: invalid};

    return withFormLock_(() => {
      const updates = {};
      if (gasUrl !== null) updates[RELAY_PROPS.gasUrl] = gasUrl;
      if (ingestSecret !== null) updates[RELAY_PROPS.ingestSecret] = ingestSecret;
      if (searchQuery !== null) updates[RELAY_PROPS.searchQuery] = searchQuery;
      if (subjectIncludes !== null) updates[RELAY_PROPS.subjectIncludes] = subjectIncludes;
      if (!props.getProperty(RELAY_PROPS.startDate)) updates[RELAY_PROPS.startDate] = todayInTokyo_();
      if (input.dryRun === true) updates[RELAY_PROPS.dryRun] = '1';
      props.setProperties(updates);
      if (input.dryRun !== true) props.deleteProperty(RELAY_PROPS.dryRun);
      if (input.clearSubjectIncludes === true && subjectIncludes === null) props.deleteProperty(RELAY_PROPS.subjectIncludes);

      deleteRelayTriggers_();
      ScriptApp.newTrigger(RELAY_TRIGGER_FUNCTION).timeBased().everyMinutes(RELAY_TRIGGER_MINUTES).create();
      console.log('relay form: settings saved, trigger created');
      return {ok: true, status: buildStatus_()};
    });
  });
}

// 「試す」: 直近の該当メール 1 通を dryRun で送り、件数と応答コードだけを返す
function relayTest(token) {
  return formAction_(token, () => {
    const config = readSendConfig_();
    if (!config) return {ok: false, error: 'notConfigured'};
    let ids;
    try {
      ids = listMessageIds_(config);
    } catch (err) {
      return {ok: true, result: {found: 0, parsed: null, code: 'gmail'}};
    }
    if (ids.length === 0) return {ok: true, result: {found: 0, parsed: null, code: 'none'}};
    let payload;
    try {
      payload = buildIngestPayload_(config, Gmail.Users.Messages.get('me', ids[0], {format: 'full'}), true);
    } catch (err) {
      return {ok: true, result: {found: ids.length, parsed: null, code: 'gmail'}};
    }
    const outcome = postToKakeibo_(config, payload);
    const parsed = outcome.kind === 'dry' && typeof outcome.parsed === 'number' ? outcome.parsed : null;
    const code = outcome.kind === 'dry' ? 'ok' : outcome.kind === 'processed' ? 'unexpected' : outcome.code;
    console.log(`relay test: found=${ids.length} code=${code}`);
    return {ok: true, result: {found: ids.length, parsed: parsed, code: code}};
  });
}

// 「保留を再送」: 保留の記録を空にする(次の回に送り直す)
function relayRetryHeld(token) {
  return formAction_(token, () => withFormLock_(() => {
    writeRecord_(RELAY_PROPS.held, {});
    console.log('relay form: held cleared');
    return {ok: true, status: buildStatus_()};
  }));
}

// 「停止」: トリガーを消す(設定は残す)
function relayStop(token) {
  return formAction_(token, () => {
    deleteRelayTriggers_();
    console.log('relay form: stopped');
    return {ok: true, status: buildStatus_()};
  });
}

// 「すべて削除」: トリガーと Script Properties をすべて消す
function relayDeleteAll(token) {
  return formAction_(token, () => withFormLock_(() => {
    deleteRelayTriggers_();
    PropertiesService.getScriptProperties().deleteAllProperties();
    console.log('relay form: everything deleted');
    return {ok: true, status: buildStatus_()};
  }));
}
