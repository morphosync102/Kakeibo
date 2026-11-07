/**
 * Kakeibo Automation - Universal Ver 2.3 (Source Registry + Caching)
 * Sources: see SOURCES (main / yahoo / yuki)
 */

const SHEET_ID = PropertiesService.getScriptProperties().getProperty('SHEET_ID');

// Build id returned by doGet ?action=version. The deploy workflow
// (.github/workflows/deploy.yml) replaces 'dev' with the commit SHA right
// before `clasp push`, then checks the deployed Web App reports that SHA.
// Keep this exact one-line form: the workflow matches it literally.
const GAS_BUILD = 'dev';

// Default Sheets
const DATA_SHEET_NAME = 'Data';
const CONFIG_SHEET_NAME = 'Config';
const FIXED_SHEET_NAME = 'Fixed';

// Yahoo (Olive) Sheets
const YAHOO_DATA_SHEET_NAME = 'Yahoo_Data';
const YAHOO_CONFIG_SHEET_NAME = 'Yahoo_Config';
const YAHOO_FIXED_SHEET_NAME = 'Yahoo_Fixed';

// --- Source registry ---
// One entry per kakeibo. Every per-source lookup (sheets, cache key, LINE
// destination, label) and every per-source loop (fixed costs, monthly reports,
// backfillRowIds, setupSourceSheets) goes through this table. A lookup for an
// unknown source throws instead of falling back to main, so a missing branch
// can never write one kakeibo's rows into another kakeibo's sheets.
// - lineKey: Script Property holding the monthly report's LINE destination.
// - lineOptional: when lineKey is unset, the monthly report of this source is
//   skipped with a warning (yuki before LINE linking). Otherwise an unset
//   destination is an error, so the trigger run is reported as failed.
// - requiresActor: the Web App (doGet/doPost) serves this source only to a
//   request carrying a verified user (`actor`, see authorizeDataRequest), even
//   while AUTHZ_ENFORCE is unset; without one it answers {error: 'Forbidden'}.
//   The current UI never sends it. Time-driven and editor functions are not
//   affected.
const SOURCES = Object.freeze({
  main: Object.freeze({
    data: DATA_SHEET_NAME, config: CONFIG_SHEET_NAME, fixed: FIXED_SHEET_NAME,
    label: '家庭用', lineKey: 'LINE_DESTINATION_MAIN', lineOptional: false, requiresActor: false
  }),
  yahoo: Object.freeze({
    data: YAHOO_DATA_SHEET_NAME, config: YAHOO_CONFIG_SHEET_NAME, fixed: YAHOO_FIXED_SHEET_NAME,
    label: '個人用', lineKey: 'LINE_DESTINATION_YAHOO', lineOptional: false, requiresActor: false
  }),
  yuki: Object.freeze({
    data: 'Yuki_Data', config: 'Yuki_Config', fixed: 'Yuki_Fixed',
    label: 'Yuki', lineKey: 'LINE_DESTINATION_YUKI', lineOptional: true, requiresActor: true
  })
});
const SOURCE_IDS = Object.freeze(Object.keys(SOURCES)); // processing order of the loops

// updateCategory rewrites the same merchant across the group of the requested
// source, limited to the sources the caller (actor) may use. Every source
// belongs to exactly one group; a new user's source gets a group of its own.
const CATEGORY_GROUPS = Object.freeze([
  Object.freeze(['main', 'yahoo']),
  Object.freeze(['yuki'])
]);

// --- User table (actor verification) ---
// Auth_Users is created and maintained by the auth functions (G3:
// setupAuthSheets / addUser / disableUser / bumpEpoch ...). This file only
// reads it. Columns are located by header name (AUTH_USERS_HEADERS is the
// layout G3 writes); only userId / sources / epoch / status are used here.
// - userId: opaque id (u_ + base64url); the proxy sends it as actorUserId.
// - sources: registry ids separated by commas (e.g. "yuki,main").
// - epoch: non-negative integer; the session carries it as actorEpoch and a
//   mismatch means the session was revoked.
// - status: only "active" users are accepted.
// The parsed table is kept in the Script Cache under a generation token
// (AUTH_USERS_GEN_KEY; table at AUTH_USERS_CACHE_KEY_<gen>, short TTL), see
// getAuthUsers. Every write to Auth_Users must call clearAuthUsersCache()
// before releasing the script lock, so the change applies to the next
// request; after editing the sheet by hand, run clearAuthUsersCache() from
// the editor (or wait AUTH_USERS_CACHE_TTL seconds).
const AUTH_USERS_SHEET_NAME = 'Auth_Users';
const AUTH_USERS_HEADERS = Object.freeze(['userId', 'displayName', 'role', 'sources', 'homeSource', 'epoch', 'status', 'createdAt', 'updatedAt']);
const AUTH_USERS_GEN_KEY = 'kakeibo_auth_users_gen';
const AUTH_USERS_CACHE_KEY = 'kakeibo_auth_users_v1';
const AUTH_USERS_CACHE_TTL = 600; // seconds
const ACTOR_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ACTOR_EPOCH = 1000000000;

// Headers written by setupSourceSheets(); the same columns as the existing
// main / yahoo sheets (Data column H = RowId, see ROW_ID_COLUMN below).
const SOURCE_SHEET_HEADERS = Object.freeze({
  data: ['Date', 'Merchant', 'Amount', 'Category', 'MessageId', 'Timestamp', 'Type', 'RowId'],
  config: ['支払い先', '分類'],
  fixed: ['Type', 'Name', 'Amount', 'Day', 'Category']
});

// Data / Yahoo_Data column H: RowId, a UUID assigned to every row on insert
// (backfillRowIds() fills rows created before the column existed). Appended
// after Type (G) so column-number based code keeps working. MessageId (E) stays:
// it is shared by rows from the same email and used for import de-duplication.
const ROW_ID_COLUMN = 8; // H
const ROW_ID_HEADER = 'RowId';
// Only Utilities.getUuid()-shaped values count as RowIds. Column H may already
// hold manual notes on the production sheet; such values are ignored (the row
// is treated as not numbered yet) instead of being exposed as an id.
const ROW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cache Configuration
const CACHE_TTL = 21600; // 6 hours (Max allowed)
// CacheService values are limited to 100KB. Lists are stored in chunks of at
// most CACHE_CHUNK_CHARS UTF-16 units (<= 3 UTF-8 bytes each => <= 90KB).
const CACHE_CHUNK_CHARS = 30000;
const MAX_CACHE_CHUNKS = 30;

// Concurrency: every write takes the script lock (IMPROVEMENTS 4-5)
const LOCK_WAIT_MS = 20000; // Web App requests: answer Busy rather than hang
const FIXED_COST_LOCK_WAIT_MS = 120000; // daily trigger: a skipped day is not retried

// --- Helper: proxy authentication (IMPROVEMENTS 4-1) ---
// The Next.js proxy sends the shared secret as `key` (query for doGet, body for
// doPost). Script Property PROXY_SECRET enables the check. While it is unset
// (migration period) every request passes and a warning is logged; remove that
// fallback once the secret is configured on both sides.
// Returns true when the request may proceed. Never logs the key.
function isAuthorizedRequest(key) {
  const secret = PropertiesService.getScriptProperties().getProperty('PROXY_SECRET');
  if (!secret) {
    console.warn('PROXY_SECRET is not set: Web App requests are NOT authenticated (migration period).');
    return true;
  }
  if (typeof key !== 'string' || key === '') return false;
  return constantTimeEquals(key, secret);
}

// True when PROXY_SECRET is set, i.e. a request that passed
// isAuthorizedRequest really came from a proxy.
function isProxySecretConfigured() {
  return Boolean(PropertiesService.getScriptProperties().getProperty('PROXY_SECRET'));
}

// --- Helper: auth proxy authentication ---
// `key` (PROXY_SECRET) is added by every version of the /api/expenses proxy,
// including the one in production before the passkey UI, which forwards the
// browser's body as is. So `key` alone cannot vouch for an actor or an auth
// action: any logged-in browser could send them through that proxy. Auth
// actions and requests carrying an actor therefore also need `authKey`
// (body for doPost, query for doGet), compared with Script Property
// AUTH_PROXY_SECRET (a different value from PROXY_SECRET). Only the new
// /api/auth/* routes and the new actor-adding proxy path send it (Vercel
// GAS_AUTH_PROXY_SECRET); old proxies never do. Unset -> always false.
// Requires PROXY_SECRET as well (no migration pass-through). Never logs keys.
function isAuthProxyRequest(params) {
  if (!isProxySecretConfigured()) return false;
  const secret = PropertiesService.getScriptProperties().getProperty('AUTH_PROXY_SECRET');
  if (!secret) return false;
  const authKey = params.authKey;
  if (typeof authKey !== 'string' || authKey === '') return false;
  return constantTimeEquals(authKey, secret);
}

// Compares SHA-256 digests of both values over all 32 bytes, so the time taken
// does not depend on where (or whether) the inputs differ, nor on their length.
function constantTimeEquals(a, b) {
  const digestA = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a, Utilities.Charset.UTF_8);
  const digestB = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b, Utilities.Charset.UTF_8);
  let diff = digestA.length ^ digestB.length;
  const length = Math.max(digestA.length, digestB.length);
  for (let i = 0; i < length; i++) {
    diff |= (digestA[i] | 0) ^ (digestB[i] | 0);
  }
  return diff === 0;
}

// --- Helper: source validation ---
// For Web App requests: absent (undefined / null / '') -> 'main' (old clients
// omit source for the household kakeibo; kept for backward compatibility only),
// a registry id string -> itself. Anything else (other spellings, non-strings,
// inherited names like 'constructor') returns null and must be rejected with
// {error: 'Invalid source'} so a typo can never write into another kakeibo.
function normalizeSource(source) {
  if (source === undefined || source === null || source === '') return 'main';
  return isSourceId(source) ? source : null;
}

function isSourceId(source) {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(SOURCES, source);
}

// The registry entry of an exact source id. No default: anything else
// (including undefined) throws, so internal callers must pass a source.
function getSourceConfig(source) {
  if (!isSourceId(source)) throw new Error(`Unknown source: ${String(source).slice(0, 40)}`);
  return SOURCES[source];
}

// --- Helper: actor verification (design 2026-11-yuki-and-passkeys §5.7) ---
// The proxy adds actorUserId / actorEpoch (from the verified session) to every
// data request after removing any client-sent values. Called after
// isAuthorizedRequest and normalizeSource, before any sheet is read or written.
// Returns {actor: null} (legacy request without actor, allowed),
// {actor: {userId, epoch, sources}} or {error}:
// - any actor field without a valid authKey (old proxy path, or
//   PROXY_SECRET / AUTH_PROXY_SECRET unset: cannot be trusted) -> 'Unauthorized'
// - malformed actor (only one field, bad id or epoch)  -> 'Invalid actor'
// - no actor, and the source requiresActor or Script Property
//   AUTHZ_ENFORCE is '1'                                -> 'Forbidden'
// - Auth_Users missing / unreadable (fail closed)      -> 'AuthUnavailable'
// - unknown user, status not active, epoch mismatch    -> 'SessionRevoked'
// - source not in the user's sources                   -> 'Forbidden'
function authorizeDataRequest(params, source) {
  if (hasActorFields(params) && !isAuthProxyRequest(params)) return {error: 'Unauthorized'};
  const parsed = readActorParams(params);
  if (parsed.error) return {error: parsed.error};
  if (!parsed.actor) {
    if (getSourceConfig(source).requiresActor || isAuthzEnforced()) return {error: 'Forbidden'};
    return {actor: null};
  }

  const table = getAuthUsers();
  if (table.error) return {error: table.error};
  const user = Object.prototype.hasOwnProperty.call(table.users, parsed.actor.userId)
    ? table.users[parsed.actor.userId]
    : null;
  if (!user || user.status !== 'active' || user.epoch !== parsed.actor.epoch) return {error: 'SessionRevoked'};
  if (user.sources.indexOf(source) === -1) return {error: 'Forbidden'};
  return {actor: {userId: parsed.actor.userId, epoch: user.epoch, sources: user.sources.slice()}};
}

// AUTHZ_ENFORCE = '1': every data request must carry an actor.
// Unset (migration period): requests without actor keep working for main / yahoo.
function isAuthzEnforced() {
  return PropertiesService.getScriptProperties().getProperty('AUTHZ_ENFORCE') === '1';
}

function hasActorFields(params) {
  const isAbsent = value => value === undefined || value === null || value === '';
  return !isAbsent(params.actorUserId) || !isAbsent(params.actorEpoch);
}

// Reads actorUserId / actorEpoch from a doGet query (strings) or doPost body.
// Returns {actor: null} when neither is sent, {actor: {userId, epoch}} or {error}.
function readActorParams(params) {
  const isAbsent = value => value === undefined || value === null || value === '';
  const userId = params.actorUserId;
  const epochValue = params.actorEpoch;
  if (isAbsent(userId) && isAbsent(epochValue)) return {actor: null};
  if (typeof userId !== 'string' || !ACTOR_USER_ID_PATTERN.test(userId)) return {error: 'Invalid actor'};
  const epoch = parseEpoch(epochValue);
  if (epoch === null) return {error: 'Invalid actor'};
  return {actor: {userId: userId, epoch: epoch}};
}

// A non-negative integer (number, or a string of digits), or null
function parseEpoch(value) {
  let number = null;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^\d{1,10}$/.test(value)) number = Number(value);
  if (number === null || !Number.isInteger(number) || number < 0 || number > MAX_ACTOR_EPOCH) return null;
  return number;
}

// The user table as {users: {userId: {epoch, sources, status}}} or {error}.
// Cached like the data lists, under a generation token
// (AUTH_USERS_GEN_KEY -> gen, AUTH_USERS_CACHE_KEY_<gen> -> table):
// - the generation is read (or created) BEFORE the sheet is read, and the
//   table is stored only if the generation is still the same right before
//   the put. clearAuthUsersCache() flushes pending sheet writes and then
//   rotates the generation, so a read that started before an Auth_Users write
//   can never store the old table under the live generation.
// - a cache hit for the live generation does not open the sheet.
// - without a cache (service failure) the sheet is read and nothing is stored.
function getAuthUsers() {
  let cache = null;
  let gen = null;
  try {
    cache = CacheService.getScriptCache();
    gen = cache.get(AUTH_USERS_GEN_KEY);
    if (!gen) {
      gen = newCacheGen();
      cache.put(AUTH_USERS_GEN_KEY, gen, CACHE_TTL);
    }
    const cached = cache.get(getAuthUsersTableKey(gen));
    if (cached) return {users: JSON.parse(cached)};
  } catch (err) {
    console.warn(`Auth user cache read failed: ${err}`);
    gen = null;
  }

  let users;
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(AUTH_USERS_SHEET_NAME);
    if (!sheet) {
      console.error(`${AUTH_USERS_SHEET_NAME} does not exist: requests with an actor are refused (run setupAuthSheets).`);
      return {error: 'AuthUnavailable'};
    }
    users = parseAuthUsers(sheet.getDataRange().getValues());
  } catch (err) {
    console.error(`${AUTH_USERS_SHEET_NAME} could not be read: ${err}`);
    return {error: 'AuthUnavailable'};
  }
  if (!users) return {error: 'AuthUnavailable'};

  if (cache && gen) {
    try {
      if (cache.get(AUTH_USERS_GEN_KEY) === gen) {
        cache.put(getAuthUsersTableKey(gen), JSON.stringify(users), AUTH_USERS_CACHE_TTL);
      } else {
        console.log('Skip caching the user table: generation changed during read');
      }
    } catch (err) {
      console.warn(`Auth user cache write failed: ${err}`);
    }
  }
  return {users: users};
}

function getAuthUsersTableKey(gen) {
  return `${AUTH_USERS_CACHE_KEY}_${gen}`;
}

// Parses Auth_Users values (header row first). Returns the users object, or
// null when a required column is missing. A userId that appears on more than
// one row (valid or not) is left out entirely (fail closed); rows with an
// invalid userId or epoch are left out (such a user is treated as unknown).
// Never logs cell values.
function parseAuthUsers(values) {
  if (!values || values.length === 0) return null;
  const header = values[0].map(cell => String(cell).trim());
  const column = {};
  for (const name of ['userId', 'sources', 'epoch', 'status']) {
    column[name] = header.indexOf(name);
    if (column[name] === -1) {
      console.error(`${AUTH_USERS_SHEET_NAME}: column "${name}" is missing.`);
      return null;
    }
  }
  // No prototype: a userId such as "__proto__" stays an ordinary key
  const users = Object.create(null);
  const rowCount = Object.create(null);
  const rows = values.slice(1).map(row => ({row: row, userId: String(row[column.userId]).trim()}));
  rows.forEach(entry => {
    if (entry.userId !== '') rowCount[entry.userId] = (rowCount[entry.userId] || 0) + 1;
  });
  let skipped = 0;
  rows.forEach(entry => {
    const userId = entry.userId;
    if (userId === '' || rowCount[userId] > 1) return;
    const row = entry.row;
    const epoch = parseEpoch(typeof row[column.epoch] === 'number' ? row[column.epoch] : String(row[column.epoch]).trim());
    if (!ACTOR_USER_ID_PATTERN.test(userId) || epoch === null) {
      skipped++;
      return;
    }
    users[userId] = {
      epoch: epoch,
      sources: String(row[column.sources]).split(',').map(s => s.trim()).filter(isSourceId),
      status: String(row[column.status]).trim()
    };
  });
  const duplicates = Object.keys(rowCount).filter(userId => rowCount[userId] > 1).length;
  if (skipped > 0 || duplicates > 0) {
    console.warn(`${AUTH_USERS_SHEET_NAME}: ${skipped} invalid row(s) and ${duplicates} duplicated userId(s) ignored.`);
  }
  return users;
}

// Invalidates the cached user table. Call after every Auth_Users write (G3
// functions, still holding the script lock) or run it from the editor after
// editing the sheet by hand. Same scheme as clearCache(source):
// 1. flush: commit pending Auth_Users writes first, otherwise a reader could
//    take the new generation, read the old sheet and cache the old table.
// 2. rotate the generation (the old table becomes unreachable).
// 3. remove the previous generation's table: housekeeping when the rotation
//    worked, the fallback when it failed.
// Never throws (the auth write already landed). Returns true when rotated.
function clearAuthUsersCache() {
  try {
    SpreadsheetApp.flush();
  } catch (err) {
    console.warn(`Flush before user table invalidation failed: ${err}`);
  }

  let cache;
  try {
    cache = CacheService.getScriptCache();
  } catch (err) {
    console.warn(`User table invalidation failed (expires within ${AUTH_USERS_CACHE_TTL}s): ${err}`);
    return false;
  }

  let previousGen = null;
  try {
    previousGen = cache.get(AUTH_USERS_GEN_KEY);
  } catch (err) {
    console.warn(`User table generation read failed: ${err}`);
  }

  let rotated = false;
  try {
    cache.put(AUTH_USERS_GEN_KEY, newCacheGen(), CACHE_TTL);
    rotated = true;
  } catch (err) {
    console.warn(`User table generation rotation failed; removing the current table instead: ${err}`);
  }

  if (previousGen) {
    try {
      cache.remove(getAuthUsersTableKey(previousGen));
    } catch (err) {
      console.warn(`User table cleanup failed${rotated ? '' : ` (the table may stay stale for up to ${AUTH_USERS_CACHE_TTL}s)`}: ${err}`);
    }
  }
  return rotated;
}

// The sources updateCategory writes for a request on `source`: the source's
// category group, limited to the actor's sources (actor null = legacy request
// without actor: the whole group, i.e. main + yahoo as before).
function getCategoryUpdateSources(source, actor) {
  const group = CATEGORY_GROUPS.filter(g => g.indexOf(source) !== -1)[0];
  if (!group) throw new Error(`No category group for source: ${source}`);
  return group.filter(src => !actor || actor.sources.indexOf(src) !== -1);
}

// --- Helper: RowId ---
function newRowId() {
  return Utilities.getUuid();
}

function isValidRowId(value) {
  return typeof value === 'string' && ROW_ID_PATTERN.test(value);
}

// The RowId stored in a Data row (array of cell values), or null if column H
// is empty or holds anything other than a UUID
function getRowIdOf(row) {
  const value = row[ROW_ID_COLUMN - 1];
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return isValidRowId(text) ? text : null;
}

// Makes sure the sheet has a column H to write RowId into
function ensureRowIdColumn(sheet) {
  const maxColumns = sheet.getMaxColumns();
  if (maxColumns < ROW_ID_COLUMN) sheet.insertColumnsAfter(maxColumns, ROW_ID_COLUMN - maxColumns);
}

// The optional `rowId` of a single-row update/delete request.
// Returns {rowId: string|null} (null = not sent: legacy matching) or {error}.
function readRowIdParam(params) {
  const value = params.rowId;
  if (value === undefined || value === null || value === '') return {rowId: null};
  if (!isValidRowId(value)) return {error: 'Invalid rowId'};
  return {rowId: value};
}

// Finds the Data row (index into `data`, header at 0) for a single-row write.
// - rowId given and present in column H: that row, only if `matches` also
//   holds (same content as the client saw); otherwise -1 (never another row).
// - rowId given but not in the sheet: strict match among rows WITHOUT a RowId
//   (not backfilled yet, or a non-UUID manual value in H); rows identified by
//   another RowId are skipped.
// - no rowId (old clients): first strict match, as before.
function findTransactionRowIndex(data, rowId, matches) {
  if (rowId !== null) {
    for (let i = 1; i < data.length; i++) {
      if (getRowIdOf(data[i]) === rowId) return matches(data[i]) ? i : -1;
    }
    for (let i = 1; i < data.length; i++) {
      if (getRowIdOf(data[i]) === null && matches(data[i])) return i;
    }
    return -1;
  }
  for (let i = 1; i < data.length; i++) {
    if (matches(data[i])) return i;
  }
  return -1;
}

// --- Helper: Get Target Sheet Names based on source ---
// Throws for an unknown or missing source (no fallback to main).
function getTargetSheets(source) {
  const config = getSourceConfig(source);
  return {
    data: config.data,
    config: config.config,
    fixed: config.fixed
  };
}

// Runs fn(source) for every registry source in order. A failure of one source
// is logged and does not stop the others; after all sources ran, the failures
// are rethrown as one error so the trigger run is still reported as failed.
// Returns {source: fn result}.
function runForEachSource(label, fn) {
  const results = {};
  const failed = [];
  SOURCE_IDS.forEach(source => {
    try {
      results[source] = fn(source);
    } catch (err) {
      console.error(`${label} failed for ${source}: ${err}`);
      failed.push(source);
    }
  });
  if (failed.length > 0) {
    throw new Error(`${label} failed for: ${failed.join(', ')} (the other sources were processed; see the log)`);
  }
  return results;
}

// --- Helper: Script lock ---
// Runs fn while holding the script lock. Returns onBusy() without running fn
// when the lock cannot be acquired within waitMs (default LOCK_WAIT_MS).
// Pending spreadsheet writes are flushed before the lock is released so the
// next holder reads them.
function runWithScriptLock(fn, onBusy, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || LOCK_WAIT_MS)) return onBusy();
  try {
    return fn();
  } finally {
    try {
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}

// --- Helper: Cache Management ---
// Cached lists are stored under a per-source generation token:
//   kakeibo_<src>_gen                 -> current generation (shared by data/fixed)
//   kakeibo_<src>_<type>_<gen>_chunks -> chunk count
//   kakeibo_<src>_<type>_<gen>_<i>    -> chunk i
// clearCache() rotates the generation, so a read that started before a write
// can only store its (stale) list under a dead generation, and chunks from
// different generations can never be mixed on read.

// Exact registry id only: an unknown or missing source throws (callers pass a
// source already normalized by doGet/doPost or an explicit internal id).
function getCacheSourceKey(source) {
  getSourceConfig(source);
  return `kakeibo_${source}`;
}

function getCacheKey(source, type) {
  return `${getCacheSourceKey(source)}_${type}`;
}

function getCacheGenKey(source) {
  return `${getCacheSourceKey(source)}_gen`;
}

function newCacheGen() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Returns the current generation, creating it when missing (evicted/expired).
// It is read (or created) BEFORE the sheet is read: a write whose clearCache
// this creation might overwrite has already written the sheet, so the list
// read afterwards is not stale. Returns null if the cache is unavailable.
function getOrCreateCacheGen(cache, source) {
  try {
    const genKey = getCacheGenKey(source);
    const current = cache.get(genKey);
    if (current) return current;
    const created = newCacheGen();
    cache.put(genKey, created, CACHE_TTL);
    return created;
  } catch (err) {
    console.warn(`Cache generation unavailable for ${source}: ${err}`);
    return null;
  }
}

function getChunkPrefix(baseKey, gen) {
  return `${baseKey}_${gen}`;
}

function getChunkCountKey(prefix) {
  return `${prefix}_chunks`;
}

function getChunkKeys(prefix, count) {
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(`${prefix}_${i}`);
  return keys;
}

function splitIntoCacheChunks(str) {
  const chunks = [];
  let start = 0;
  while (start < str.length) {
    let end = Math.min(start + CACHE_CHUNK_CHARS, str.length);
    // Never split a surrogate pair across chunks
    const last = str.charCodeAt(end - 1);
    if (end < str.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
    chunks.push(str.slice(start, end));
    start = end;
  }
  return chunks;
}

// Returns the cached string of generation `gen`, or null on a miss
// (count missing/invalid or any chunk missing)
function getChunkedCache(cache, baseKey, gen) {
  if (!gen) return null;
  try {
    const prefix = getChunkPrefix(baseKey, gen);
    const countValue = cache.get(getChunkCountKey(prefix));
    if (!countValue || !/^\d+$/.test(countValue)) return null;
    const count = Number(countValue);
    if (count < 1 || count > MAX_CACHE_CHUNKS) return null;
    const keys = getChunkKeys(prefix, count);
    const values = cache.getAll(keys);
    const parts = [];
    for (const key of keys) {
      if (typeof values[key] !== 'string') return null;
      parts.push(values[key]);
    }
    return parts.join('');
  } catch (err) {
    console.warn(`Cache read failed for ${baseKey}: ${err}`);
    return null;
  }
}

// Best effort: a cache failure (size limit, service error) must never fail the read.
// Stores only if the generation is still the one read before the sheet was read.
function putChunkedCache(cache, baseKey, gen, source, str) {
  if (!gen) return;
  try {
    if (cache.get(getCacheGenKey(source)) !== gen) {
      console.log(`Skip caching ${baseKey}: generation changed during read`);
      return;
    }
    const chunks = splitIntoCacheChunks(str);
    if (chunks.length === 0) chunks.push('');
    if (chunks.length > MAX_CACHE_CHUNKS) {
      console.warn(`Skip caching ${baseKey}: ${chunks.length} chunks exceeds ${MAX_CACHE_CHUNKS}`);
      return;
    }
    const prefix = getChunkPrefix(baseKey, gen);
    const entries = {};
    chunks.forEach((chunk, i) => { entries[`${prefix}_${i}`] = chunk; });
    // Count key is written in the same call; a partial write is detected on read
    entries[getChunkCountKey(prefix)] = String(chunks.length);
    cache.putAll(entries, CACHE_TTL);
  } catch (err) {
    console.warn(`Cache write failed for ${baseKey}: ${err}`);
  }
}

function getCacheKeysToClear(baseKey, gen) {
  // Legacy single-value key, plus the previous generation's chunks if known
  const keys = [baseKey];
  if (gen) {
    const prefix = getChunkPrefix(baseKey, gen);
    keys.push(getChunkCountKey(prefix));
    getChunkKeys(prefix, MAX_CACHE_CHUNKS).forEach(key => keys.push(key));
  }
  return keys;
}

// Invalidates the data and fixed-cost caches of one source by rotating its
// generation. Called after a successful write, so it never throws for a valid
// source: reporting an error for a write that already landed would make the UI
// resend it. An unknown source is a programming error (every write path
// resolves its sheets via getTargetSheets first, which already throws) and
// throws here before anything is touched.
// 1. flush: commit pending sheet writes first, otherwise a doGet could pick up
//    the new generation, read the pre-write sheet and cache the stale list.
// 2. rotate the generation (invalidates everything cached under the old one).
// 3. remove the old generation's chunks and the legacy key. This is
//    housekeeping when rotation worked, and the fallback when it failed.
// Returns true when the generation was rotated.
function clearCache(source) {
  getCacheSourceKey(source); // validates; throws for an unknown source
  try {
    SpreadsheetApp.flush();
  } catch (err) {
    console.warn(`Flush before cache invalidation failed for ${source}: ${err}`);
  }

  let cache;
  try {
    cache = CacheService.getScriptCache();
  } catch (err) {
    console.warn(`Cache invalidation failed for ${source}: ${err}`);
    return false;
  }

  const genKey = getCacheGenKey(source);
  let previousGen = null;
  try {
    previousGen = cache.get(genKey);
  } catch (err) {
    console.warn(`Cache generation read failed for ${source}: ${err}`);
  }

  let rotated = false;
  try {
    cache.put(genKey, newCacheGen(), CACHE_TTL);
    rotated = true;
  } catch (err) {
    console.warn(`Cache generation rotation failed for ${source}; removing current chunks instead: ${err}`);
  }

  try {
    cache.removeAll(
      getCacheKeysToClear(getCacheKey(source, 'data'), previousGen)
        .concat(getCacheKeysToClear(getCacheKey(source, 'fixed'), previousGen))
    );
  } catch (err) {
    console.warn(`Cache cleanup failed for ${source}${rotated ? '' : ' (cache may stay stale until it expires)'}: ${err}`);
  }
  return rotated;
}

function jsonTextOutput(jsonStr) {
  return ContentService.createTextOutput(jsonStr).setMimeType(ContentService.MimeType.JSON);
}

// --- API: Read Data ---
function doGet(e) {
  if (!isAuthorizedRequest(e.parameter.key)) return responseJSON({error: 'Unauthorized'});
  const action = e.parameter.action;

  // Deploy verification: read-only, exposes only the build id (commit SHA)
  if (action === 'version') return responseJSON({build: GAS_BUILD});
  const source = normalizeSource(e.parameter.source); // a SOURCES id | null
  if (!source) return responseJSON({error: 'Invalid source'});
  const authz = authorizeDataRequest(e.parameter, source);
  if (authz.error) return responseJSON({error: authz.error});

  if (action === 'getFixedCosts') {
    return getFixedCostsWithCache(source);
  }

  // Default: Get Expenses
  return getExpensesWithCache(source);
}

function getFixedCostsWithCache(source) {
  const cache = CacheService.getScriptCache();
  const cacheKey = getCacheKey(source, 'fixed');
  const gen = getOrCreateCacheGen(cache, source); // before reading the sheet
  const cached = getChunkedCache(cache, cacheKey, gen);

  if (cached !== null) {
    return jsonTextOutput(cached);
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = getTargetSheets(source);
  const sheet = ss.getSheetByName(sheets.fixed);

  if (!sheet) return responseJSON([]);

  const data = sheet.getDataRange().getValues();
  if (data.length > 0) data.shift(); // Remove header

  const fixedCosts = data.map((row, index) => ({
    id: index,
    type: row[0],
    name: row[1],
    amount: row[2],
    day: row[3],
    category: row[4]
  }));

  const jsonStr = JSON.stringify(fixedCosts);
  putChunkedCache(cache, cacheKey, gen, source, jsonStr);

  return jsonTextOutput(jsonStr);
}

function getExpensesWithCache(source) {
  const cache = CacheService.getScriptCache();
  const cacheKey = getCacheKey(source, 'data');
  const gen = getOrCreateCacheGen(cache, source); // before reading the sheet
  const cached = getChunkedCache(cache, cacheKey, gen);

  if (cached !== null) {
    return jsonTextOutput(cached);
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = getTargetSheets(source);
  const sheet = ss.getSheetByName(sheets.data);

  if (!sheet) return responseJSON({error: `No sheet: ${sheets.data}`});

  const data = sheet.getDataRange().getValues();
  if (data.length > 0) data.shift(); // Remove header

  const formattedMsg = data.map(row => {
    let dateStr = row[0];
    if (dateStr instanceof Date) {
        dateStr = Utilities.formatDate(dateStr, Session.getScriptTimeZone(), "yyyy/MM/dd");
    }

    return {
      id: row[4], // MessageId
      date: dateStr,
      merchant: row[1],
      amount: row[2],
      category: row[3],
      type: row[6] || 'Expense', // Column G (Index 6)
      // Column H; omitted (undefined) unless it holds a valid RowId (UUID)
      rowId: getRowIdOf(row) || undefined
    };
  });

  const jsonStr = JSON.stringify(formattedMsg);
  putChunkedCache(cache, cacheKey, gen, source, jsonStr);

  return jsonTextOutput(jsonStr);
}

// --- API: Write Data ---
const WRITE_ACTIONS = [
  'addTransaction',
  'addFixedCost',
  'deleteFixedCost',
  'deleteTransaction',
  'updateTransaction',
  'updateTransactionDate',
  'updateCategory'
];

function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    if (isLineWebhookPayload(params)) {
      console.log('LINE webhook received; email forwarding disabled.');
      return responseJSON({success: true, ignored: 'lineWebhook'});
    }

    // LINE calls the webhook directly (no key); every other request is authenticated
    if (!isAuthorizedRequest(params.key)) return responseJSON({error: 'Unauthorized'});

    // Auth actions carry no source; they require PROXY_SECRET (see handleAuthAction)
    if (AUTH_ACTIONS.indexOf(params.action) !== -1) return responseJSON(handleAuthAction(params));

    const source = normalizeSource(params.source); // a SOURCES id | null
    if (!source) return responseJSON({error: 'Invalid source'});
    const authz = authorizeDataRequest(params, source);
    if (authz.error) return responseJSON({error: authz.error});

    if (WRITE_ACTIONS.indexOf(params.action) === -1) {
      return responseJSON({error: 'Unknown action'});
    }

    // Rows are (re)read and matched inside the lock, so a concurrent write
    // cannot shift row numbers between the read and the write.
    const result = runWithScriptLock(
      () => handleWriteAction(params, source, authz.actor),
      () => ({error: 'Busy'})
    );
    return responseJSON(result);

  } catch (err) {
    return responseJSON({error: err.toString()});
  }
}

// Must be called while holding the script lock. Returns the response object.
// `actor` is the verified user from authorizeDataRequest, or null (legacy
// request without actor); only updateCategory depends on it.
function handleWriteAction(params, source, actor) {
    const action = params.action;
    const sheets = getTargetSheets(source);
    const ss = SpreadsheetApp.openById(SHEET_ID);

    let result = { error: 'Unknown action' };
    let shouldClearCache = false;

    if (action === 'addTransaction') {
      const sheet = ss.getSheetByName(sheets.data);
      if (!sheet) return {error: `No sheet: ${sheets.data}`};

      ensureRowIdColumn(sheet);
      sheet.appendRow([
        params.date,
        params.merchant,
        Number(params.amount),
        Number(params.amount) > 0 && params.type !== 'Income' ? params.category : (params.category || '未分類'),
        'manual_' + new Date().getTime(),
        new Date(),
        params.type || 'Expense',
        newRowId()
      ]);
      result = {success: true, message: 'Added transaction'};
      shouldClearCache = true;
    }

    else if (action === 'addFixedCost') {
      const sheet = ss.getSheetByName(sheets.fixed);
      if (!sheet) return {error: `No sheet: ${sheets.fixed}`};

      sheet.appendRow([
        params.type,
        params.name,
        Number(params.amount),
        Number(params.day),
        params.category
      ]);
      result = {success: true};
      shouldClearCache = true;
    }

    else if (action === 'deleteFixedCost') {
      const sheet = ss.getSheetByName(sheets.fixed);
      if (!sheet) return {error: `No sheet: ${sheets.fixed}`};

      const data = sheet.getDataRange().getValues(); // data[0] is the header
      const rowIndex = findFixedCostRowIndex(data, params);
      if (rowIndex.error) return {error: rowIndex.error};

      sheet.deleteRow(rowIndex.index + 1); // data index -> sheet row (1-based)
      result = {success: true};
      shouldClearCache = true;
    }

    else if (action === 'deleteTransaction') {
      const sheet = ss.getSheetByName(sheets.data);
      if (!sheet) return {error: `No sheet: ${sheets.data}`};

      const rowIdParam = readRowIdParam(params);
      if (rowIdParam.error) return {error: rowIdParam.error};

      const data = sheet.getDataRange().getValues();
      const targetId = params.id;

      // Strict matching when the caller provides identifying fields.
      // MessageId alone is not unique (one email can create multiple rows).
      // Older clients that send only the id keep the legacy first-match behavior.
      const hasStrictFields =
        params.date !== undefined &&
        params.merchant !== undefined &&
        params.amount !== undefined;
      const targetDate = hasStrictFields ? normalizeTransactionDate(params.date) : null;
      if (hasStrictFields && !targetDate) return {error: 'Invalid transaction date'};

      const index = findTransactionRowIndex(data, rowIdParam.rowId, row => {
        if (String(row[4]) !== String(targetId)) return false;
        if (!hasStrictFields) return true;
        return normalizeTransactionDate(row[0]) === targetDate &&
          String(row[1]) === String(params.merchant) &&
          Number(row[2]) === Number(params.amount);
      });
      const found = index !== -1;
      if (found) sheet.deleteRow(index + 1);

      if (found) {
        result = {success: true, message: 'Deleted'};
        shouldClearCache = true;
      } else {
        result = {error: 'Transaction not found'};
      }
    }

    else if (action === 'updateTransaction') {
      const sheet = ss.getSheetByName(sheets.data);
      if (!sheet) return {error: `No sheet: ${sheets.data}`};

      const currentDate = normalizeTransactionDate(params.currentDate);
      if (!currentDate) return {error: 'Invalid current transaction date'};

      // New values are optional; identifying fields (id, currentDate,
      // currentMerchant, currentAmount) follow the updateTransactionDate contract.
      const updates = {};
      if (params.amount !== undefined) {
        const amount = Number(params.amount);
        if (!isFinite(amount) || amount <= 0) return {error: 'Invalid amount'};
        updates.amount = amount;
      }
      if (params.merchant !== undefined) {
        const merchant = String(params.merchant).trim();
        if (!merchant) return {error: 'Invalid merchant'};
        updates.merchant = merchant;
      }
      if (params.category !== undefined) {
        updates.category = String(params.category);
      }
      if (Object.keys(updates).length === 0) return {error: 'No fields to update'};

      const rowIdParam = readRowIdParam(params);
      if (rowIdParam.error) return {error: rowIdParam.error};

      const data = sheet.getDataRange().getValues();
      const index = findTransactionRowIndex(data, rowIdParam.rowId, row =>
        String(row[4]) === String(params.id) &&
        normalizeTransactionDate(row[0]) === currentDate &&
        String(row[1]) === String(params.currentMerchant) &&
        Number(row[2]) === Number(params.currentAmount)
      );
      const found = index !== -1;
      if (found) {
        if (updates.merchant !== undefined) sheet.getRange(index + 1, 2).setValue(updates.merchant);
        if (updates.amount !== undefined) sheet.getRange(index + 1, 3).setValue(updates.amount);
        if (updates.category !== undefined) sheet.getRange(index + 1, 4).setValue(updates.category);
      }

      if (found) {
        result = {success: true, message: 'Updated transaction'};
        shouldClearCache = true;
      } else {
        result = {error: 'Transaction not found'};
      }
    }

    else if (action === 'updateTransactionDate') {
      const sheet = ss.getSheetByName(sheets.data);
      if (!sheet) return {error: `No sheet: ${sheets.data}`};

      const newDate = normalizeTransactionDate(params.date);
      if (!newDate) return {error: 'Invalid transaction date'};

      const currentDate = normalizeTransactionDate(params.currentDate);
      if (!currentDate) return {error: 'Invalid current transaction date'};

      const rowIdParam = readRowIdParam(params);
      if (rowIdParam.error) return {error: rowIdParam.error};

      const data = sheet.getDataRange().getValues();
      const index = findTransactionRowIndex(data, rowIdParam.rowId, row =>
        String(row[4]) === String(params.id) &&
        normalizeTransactionDate(row[0]) === currentDate &&
        String(row[1]) === String(params.merchant) &&
        Number(row[2]) === Number(params.amount)
      );
      const found = index !== -1;
      if (found) sheet.getRange(index + 1, 1).setValue(newDate);

      if (found) {
        result = {success: true, message: 'Updated transaction date'};
        shouldClearCache = true;
      } else {
        result = {error: 'Transaction not found'};
      }
    }

    else if (action === 'updateCategory') {
      // The category group of `source` limited to the actor's sources
      // (no actor: main + yahoo as before). Data and Config of other sources
      // are never touched.
      const targetSources = getCategoryUpdateSources(source, actor);
      targetSources.forEach(src => {
        const targetSheets = getTargetSheets(src);

        // 1. Update existing transactions in Data Sheet
        const sheet = ss.getSheetByName(targetSheets.data);
        const targetMerchant = params.merchant;
        const newCategory = params.category;

        if (sheet) {
           const data = sheet.getDataRange().getValues();
           for (let i = 1; i < data.length; i++) {
             if (data[i][1] === targetMerchant) {
               sheet.getRange(i + 1, 4).setValue(newCategory);
             }
           }
        }

        // 2. Update/Add Rule in Config Sheet for Future
        const configSheet = ss.getSheetByName(targetSheets.config);
        if (configSheet) {
          const configData = configSheet.getDataRange().getValues();
          let ruleUpdated = false;

          for (let i = 1; i < configData.length; i++) {
            if (normalizeText(configData[i][0]) === normalizeText(targetMerchant)) { // Keyword match
               configSheet.getRange(i + 1, 2).setValue(newCategory); // Update Category
               ruleUpdated = true;
               break;
            }
          }

          if (!ruleUpdated) {
            configSheet.appendRow([targetMerchant, newCategory]);
          }
        }
      });
      result = {success: true, message: 'Updated categories in Data and Config sheets'};

      // Clear the cache of every source that was written
      targetSources.forEach(src => clearCache(src));
      shouldClearCache = false; // Already handled
    }

    if (shouldClearCache) {
      clearCache(source);
    }

    return result;
}

// A fixed cost id is the 0-based position below the header (as returned by getFixedCosts)
function parseFixedCostId(id) {
  if (typeof id === 'number' && Number.isInteger(id) && id >= 0) return id;
  if (typeof id === 'string' && /^\d+$/.test(id)) return Number(id);
  return null;
}

// Locates the Fixed sheet row to delete. `data` includes the header at index 0.
// Returns {index} (data index, always >= 1) or {error}.
// - New callers send type/name/amount/day (+ optional category): the row at id
//   is used when it matches, otherwise the first matching row anywhere.
// - Legacy callers send only id: a valid, in-range id is trusted as before.
function findFixedCostRowIndex(data, params) {
  const id = parseFixedCostId(params.id);
  const hasMatchFields =
    params.type !== undefined &&
    params.name !== undefined &&
    params.amount !== undefined &&
    params.day !== undefined;

  if (!hasMatchFields) {
    if (id === null) return {error: 'Invalid fixed cost id'};
    if (id + 1 >= data.length) return {error: 'Fixed cost not found'};
    return {index: id + 1};
  }

  const matches = row =>
    String(row[0]) === String(params.type) &&
    String(row[1]) === String(params.name) &&
    Number(row[2]) === Number(params.amount) &&
    Number(row[3]) === Number(params.day) &&
    (params.category === undefined || String(row[4]) === String(params.category));

  if (id !== null && id + 1 < data.length && matches(data[id + 1])) return {index: id + 1};
  for (let i = 1; i < data.length; i++) {
    if (matches(data[i])) return {index: i};
  }
  return {error: 'Fixed cost not found'};
}

function responseJSON(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// --- Automation: Process Fixed Costs (Daily Trigger) ---
// Every registry source, each with its own lock; a source whose sheets do not
// exist yet is skipped. One failing source does not stop the others (the run
// still ends with an error naming it, see runForEachSource).
function processFixedCosts() {
  runForEachSource('Fixed costs', processFixedCostsForSource);
}

// `source` is required (no default): an unknown or missing source throws.
function processFixedCostsForSource(source) {
  const sheets = getTargetSheets(source);
  console.log(`--- Checking Fixed Costs for: ${source} ---`);
  // A source whose sheets do not exist yet (e.g. yuki before
  // setupSourceSheets) is skipped without waiting for the lock.
  // addDueFixedCosts checks again inside the lock.
  const ss = SpreadsheetApp.openById(SHEET_ID);
  if (!ss.getSheetByName(sheets.fixed) || !ss.getSheetByName(sheets.data)) {
    console.log(`Fixed costs for ${source} skipped: ${sheets.fixed} or ${sheets.data} does not exist.`);
    return;
  }
  // Only rows whose day equals today are added, so a run that cannot get the
  // lock is NOT retried by tomorrow's trigger: wait longer and log loudly.
  runWithScriptLock(
    () => addDueFixedCosts(source),
    () => console.warn(`Fixed costs for ${source} were NOT added today: lock busy for ${FIXED_COST_LOCK_WAIT_MS / 1000}s. Tomorrow's trigger does not catch up (not retried); run processFixedCosts() again today or add them manually.`),
    FIXED_COST_LOCK_WAIT_MS
  );
}

// Must be called while holding the script lock (duplicate check + append)
function addDueFixedCosts(source) {
  const sheets = getTargetSheets(source);
  const ss = SpreadsheetApp.openById(SHEET_ID);

  const fixedSheet = ss.getSheetByName(sheets.fixed);
  const dataSheet = ss.getSheetByName(sheets.data);

  if (!fixedSheet || !dataSheet) return;

  const today = new Date();
  const currentDay = today.getDate();
  const currentMonthStr = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy/MM");

  const fixedData = fixedSheet.getDataRange().getValues();
  if (fixedData.length > 0) fixedData.shift();

  const existingIds = getExistingMessageIds(dataSheet);
  const newRows = [];

  fixedData.forEach(row => {
    // 0:Type, 1:Name, 2:Amount, 3:Day, 4:Category
    const scheduledDay = row[3];

    if (Number(scheduledDay) === currentDay) {
       // Format kept as before (existing rows rely on it); source is always explicit
       const uniqueId = `fixed_${currentMonthStr.replace('/', '')}_${row[1]}_${source}`;

       if (!existingIds.has(uniqueId)) {
         console.log(`Adding: ${row[1]}`);
         const dateStr = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy/MM/dd");

         newRows.push([
           dateStr,
           row[1], // Name
           row[2], // Amount
           row[4], // Category
           uniqueId,
           new Date(),
           row[0], // Type
           newRowId()
         ]);
       }
    }
  });

  if (newRows.length > 0) {
    ensureRowIdColumn(dataSheet);
    dataSheet.getRange(dataSheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);

    // Clear cache since we added data
    clearCache(source);
  }
}

// --- Migration: RowId for existing rows (run once from the Apps Script editor) ---
// Fills column H for every Data row of every registry source (Data /
// Yahoo_Data / Yuki_Data; a missing sheet counts 0) that has no RowId yet,
// writes the header when H1 is empty, and never changes an existing value, so
// running it again is harmless (rerun it after adding rows to the sheet by hand).
// All sheets are inspected first: if column H is already used for something
// else (H1 neither empty nor "RowId", or non-UUID values below it) it aborts
// with an error naming the sheet and count, and writes nothing to any sheet.
// Otherwise each sheet is written with one setValues call under the script
// lock and that source's cache is invalidated. Returns the counts per source.
function backfillRowIds() {
  return runWithScriptLock(() => {
    const plans = SOURCE_IDS.map(planRowIdBackfill);
    const problems = plans.filter(plan => plan.problem).map(plan => plan.problem);
    if (problems.length > 0) {
      throw new Error(`backfillRowIds aborted, nothing was written: ${problems.join('; ')}. Move the existing column H contents to another column, then run it again.`);
    }
    const result = {};
    plans.forEach(plan => { result[plan.source] = applyRowIdBackfill(plan); });
    console.log(`backfillRowIds: ${JSON.stringify(result)}`);
    return result;
  }, () => {
    throw new Error('backfillRowIds: could not acquire the script lock; run it again later.');
  }, FIXED_COST_LOCK_WAIT_MS);
}

// Read-only inspection of one source's Data sheet (must hold the script lock).
// Never includes cell values in `problem` (they may be personal notes).
function planRowIdBackfill(source) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheetName = getTargetSheets(source).data;
  const sheet = ss.getSheetByName(sheetName);
  const plan = {source: source, sheet: sheet, values: null, problem: null};
  if (!sheet) return plan;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return plan;

  // Without a column H yet, every cell is empty
  plan.values = sheet.getMaxColumns() < ROW_ID_COLUMN
    ? Array.from({length: lastRow}, () => [''])
    : sheet.getRange(1, ROW_ID_COLUMN, lastRow, 1).getValues();

  const issues = [];
  const header = plan.values[0][0];
  if (header !== '' && header !== null && String(header) !== ROW_ID_HEADER) {
    issues.push(`H1 is not empty or "${ROW_ID_HEADER}"`);
  }
  let foreign = 0;
  for (let i = 1; i < plan.values.length; i++) {
    const value = plan.values[i][0];
    if (value !== '' && value !== null && value !== undefined && !isValidRowId(String(value))) foreign++;
  }
  if (foreign > 0) issues.push(`${foreign} non-UUID value(s) in column H`);
  if (issues.length > 0) plan.problem = `${sheetName}: ${issues.join(', ')}`;
  return plan;
}

// Writes one inspected plan (must hold the script lock). Returns rows filled.
function applyRowIdBackfill(plan) {
  if (!plan.sheet || !plan.values) return 0;
  const values = plan.values;
  let filled = 0;
  let changed = false;
  if (!values[0][0]) {
    values[0][0] = ROW_ID_HEADER;
    changed = true;
  }
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null || values[i][0] === undefined) {
      values[i][0] = newRowId();
      filled++;
      changed = true;
    }
  }
  if (changed) {
    ensureRowIdColumn(plan.sheet);
    plan.sheet.getRange(1, ROW_ID_COLUMN, values.length, 1).setValues(values);
    clearCache(plan.source);
  }
  return filled;
}

// --- Setup: per-source sheets (run from the Apps Script editor) ---
// Creates the Data / Config / Fixed sheets of a source that do not exist yet,
// with the header row of SOURCE_SHEET_HEADERS (Data includes H = RowId, so
// the new Data sheet never needs backfillRowIds). An existing sheet is never
// modified, so running it again is harmless.
// setupSourceSheets('yuki') handles one source; without an argument (the way
// the editor's Run button calls it) every registry source is handled, which in
// practice creates only the sheets of a newly added source (Yuki_*).
// Returns {source: [created sheet names]}.
function setupSourceSheets(source) {
  const targets = (source === undefined || source === null || source === '') ? SOURCE_IDS.slice() : [source];
  targets.forEach(getSourceConfig); // validate everything before creating anything
  return runWithScriptLock(() => {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const created = {};
    targets.forEach(src => {
      const sheets = getTargetSheets(src);
      created[src] = [];
      ['data', 'config', 'fixed'].forEach(type => {
        const name = sheets[type];
        if (ss.getSheetByName(name)) return;
        const header = SOURCE_SHEET_HEADERS[type];
        ss.insertSheet(name).getRange(1, 1, 1, header.length).setValues([header.slice()]);
        created[src].push(name);
      });
      if (created[src].length > 0) clearCache(src);
    });
    console.log(`setupSourceSheets: ${JSON.stringify(created)}`);
    return created;
  }, () => {
    throw new Error('setupSourceSheets: could not acquire the script lock; run it again later.');
  }, FIXED_COST_LOCK_WAIT_MS);
}

// --- Email Extraction (Main & Olive) ---
function runEmailExtraction() {
  extractRakutenEmails(); // Existing
  extractOliveEmails();   // New
  extractJcbEmails();     // JCB
}

function extractRakutenEmails() {
  console.log("--- Starting Rakuten Extraction ---");
  const sheets = getTargetSheets('main');
  const categoryMap = getCategoryMap(sheets.config);

  const query = 'from:info@mail.rakuten-card.co.jp subject:利用のお知らせ -subject:速報版 newer_than:5d';
  const threads = GmailApp.search(query);

  if (threads.length === 0) return;

  const messages = GmailApp.getMessagesForThreads(threads);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheets.data);
  const newRows = [];

  for (const threadMessages of messages) {
    for (const message of threadMessages) {
      if (message.getSubject().includes("速報版")) continue;

      const items = parseEmailBody(message.getPlainBody());
      for (const item of items) {
        const category = determineCategory(item.merchant, categoryMap);
        newRows.push([
          item.date,
          item.merchant,
          item.amount,
          category,
          message.getId(),
          new Date(),
          'Expense'
        ]);
      }
    }
  }

  const added = appendImportedRows(sheet, newRows, 'main', 'Rakuten');
  if (added > 0) console.log(`Added ${added} transactions.`);
}

function parseEmailBody(body) {
  const items = [];
  const regexTabular = /(\d{4}\/\d{1,2}\/\d{1,2})[\s\t]+(.+?)[\s\t]+([0-9,]+)[\s]*円/g;
  let match;
  while ((match = regexTabular.exec(body)) !== null) {
    if (match[2].trim().length > 0) {
        items.push({
        date: match[1],
        merchant: match[2].trim(),
        amount: parseInt(match[3].replace(/,/g, ''), 10)
        });
    }
  }
  const lines = body.split(/\r?\n/);
  let tempItem = {};
  for (const line of lines) {
    if (line.includes('利用日:')) tempItem.date = line.split(':')[1].trim();
    else if (line.includes('利用先:')) tempItem.merchant = line.split(':')[1].trim();
    else if (line.includes('利用金額:')) {
       const val = line.split(':')[1];
       if (val) {
         tempItem.amount = parseInt(val.replace('円', '').replace(/,/g, '').trim(), 10);
         if (tempItem.date && tempItem.merchant && !isNaN(tempItem.amount)) {
            items.push({...tempItem});
            tempItem = {};
         }
       }
    }
  }
  return items;
}

function extractOliveEmails() {
  console.log("--- Starting Olive (Vpass) Extraction ---");
  const sheets = getTargetSheets('yahoo');
  const categoryMap = getCategoryMap(sheets.config);

  const query = 'from:statement@vpass.ne.jp subject:利用のお知らせ newer_than:5d';
  const threads = GmailApp.search(query);

  if (threads.length === 0) return;

  const messages = GmailApp.getMessagesForThreads(threads);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheets.data);
  const newRows = [];

  for (const threadMessages of messages) {
    for (const message of threadMessages) {

      const body = message.getPlainBody();
      const items = parseOliveBody(body);
      for (const item of items) {
        const category = determineCategory(item.merchant, categoryMap);
        newRows.push([
          item.date,
          item.merchant,
          item.amount,
          category,
          message.getId(),
          new Date(),
          'Expense'
        ]);
      }
    }
  }

  appendImportedRows(sheet, newRows, 'yahoo', 'Olive');
}

function parseOliveBody(body) {
  const items = [];
  const lines = body.split(/\r?\n/);
  let tempItem = {};

  for (const line of lines) {
    const trimmed = line.trim();
    const dateMatch = trimmed.match(/◇利用日：(\d{4}\/\d{1,2}\/\d{1,2})/);
    if (dateMatch) tempItem.date = dateMatch[1];

    const merchantMatch = trimmed.match(/◇利用先：(.+)/);
    if (merchantMatch) tempItem.merchant = merchantMatch[1].trim();

    const amountMatch = trimmed.match(/◇利用金額：([0-9,]+)円/);
    if (amountMatch) {
      const amount = parseInt(amountMatch[1].replace(/,/g, ''), 10);
      if (tempItem.date && tempItem.merchant) {
         items.push({
           date: tempItem.date,
           merchant: tempItem.merchant,
           amount: amount
         });
         tempItem = {};
      }
    }
  }
  return items;
}

function extractJcbEmails() {
  console.log("--- Starting JCB Extraction ---");
  const sheets = getTargetSheets('yahoo');
  const categoryMap = getCategoryMap(sheets.config);

  const query = 'from:mail@qa.jcb.co.jp subject:"JCBカード／ショッピングご利用のお知らせ" newer_than:5d';
  const threads = GmailApp.search(query);

  if (threads.length === 0) return;

  const messages = GmailApp.getMessagesForThreads(threads);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheets.data);
  const newRows = [];

  for (const threadMessages of messages) {
    for (const message of threadMessages) {

      const items = parseJcbBody(message.getPlainBody());
      for (const item of items) {
        const category = determineCategory(item.merchant, categoryMap);
        newRows.push([
          item.date,
          item.merchant,
          item.amount,
          category,
          message.getId(),
          new Date(),
          'Expense'
        ]);
      }
    }
  }

  appendImportedRows(sheet, newRows, 'yahoo', 'JCB');
}

function parseJcbBody(body) {
  const dateMatch = body.match(/【ご利用日時\(日本時間\)】\s*([0-9]{4}\/[0-9]{1,2}\/[0-9]{1,2})/);
  const amountMatch = body.match(/【ご利用金額】\s*([0-9,]+)円/);
  const merchantMatch = body.match(/【ご利用先】\s*(.+)/);

  if (!dateMatch || !amountMatch || !merchantMatch) return [];

  return [{
    date: dateMatch[1],
    merchant: merchantMatch[1].trim(),
    amount: parseInt(amountMatch[1].replace(/,/g, ''), 10)
  }];
}

// --- Shared Helpers ---

// Appends parsed email rows (MessageId in column E; RowId assigned here) under the script lock.
// The duplicate check runs inside the lock so overlapping trigger runs cannot
// insert the same message twice. Returns the number of rows added.
function appendImportedRows(sheet, rows, source, label) {
  if (!sheet || rows.length === 0) return 0;
  return runWithScriptLock(() => {
    const existingIds = getExistingMessageIds(sheet);
    const newRows = rows
      .filter(row => !existingIds.has(row[4]))
      .map(row => row.slice(0, ROW_ID_COLUMN - 1).concat([newRowId()]));
    if (newRows.length === 0) return 0;
    ensureRowIdColumn(sheet);
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    clearCache(source);
    return newRows.length;
  }, () => {
    console.warn(`${label} import skipped: lock busy (next trigger retries)`);
    return 0;
  });
}

function determineCategory(merchant, categoryMap) {
  const normMerchant = normalizeText(merchant);
  for (const map of categoryMap) {
    if (normMerchant.indexOf(normalizeText(map.keyword)) !== -1) return map.category;
  }
  return '未分類';
}

function normalizeText(text) {
  if (!text) return "";
  return text.toString().normalize('NFKC').replace(/[\-－‑‒–—―]/g, 'ー').replace(/\u002d/g, 'ー').toLowerCase();
}

function getCategoryMap(sheetName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheetName || CONFIG_SHEET_NAME);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length > 0) data.shift();
  return data.map(row => ({ keyword: row[0], category: row[1] })).filter(r => r.keyword);
}

function getExistingMessageIds(sheet) {
  const ids = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return ids;
  const data = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  data.forEach(row => { if (row[0]) ids.add(row[0]); });
  return ids;
}

function normalizeTransactionDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy/MM/dd');
  }
  if (!value) return null;

  const match = value.toString().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return [
    year,
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('/');
}

function isLineWebhookPayload(params) {
  return Boolean(
    params &&
    Array.isArray(params.events) &&
    typeof params.destination === 'string'
  );
}

// --- Monthly LINE Reports ---

// Every registry source. A lineOptional source whose destination Script
// Property is not set is skipped with a warning (yuki before LINE linking); for
// the other sources a missing destination throws as before. One failing source
// does not stop the others (the run still ends with an error naming it, see
// runForEachSource).
function sendMonthlyKakeiboReports() {
  return runForEachSource('Monthly LINE report', source => {
    const destinationKey = getMonthlyReportDestinationPropertyKey(source);
    if (getSourceConfig(source).lineOptional &&
        !PropertiesService.getScriptProperties().getProperty(destinationKey)) {
      console.warn(`Monthly LINE report for ${source} skipped: Script Property ${destinationKey} is not set.`);
      return {source: source, skipped: 'noDestination'};
    }
    return sendMonthlyKakeiboReportForSource(source);
  });
}

function testSendMonthlyKakeiboReports() {
  sendMonthlyKakeiboReports();
}

function testSendMonthlyKakeiboReportMain() {
  sendMonthlyKakeiboReportForSource('main');
}

function testSendMonthlyKakeiboReportYahoo() {
  sendMonthlyKakeiboReportForSource('yahoo');
}

// `source` is required (no default): an unknown or missing source throws
// before anything is read or sent.
function sendMonthlyKakeiboReportForSource(source, now) {
  getSourceConfig(source);
  const targetMonth = getMonthlyReportTargetMonth(now || new Date());
  const previousMonth = getPreviousMonthlyReportMonth(targetMonth);
  const rows = getMonthlyReportRows(source, targetMonth);
  const previousRows = getMonthlyReportRows(source, previousMonth);
  const text = buildMonthlyKakeiboReportText(source, targetMonth, rows, previousRows);
  const destinationKey = getMonthlyReportDestinationPropertyKey(source);
  const destination = getScriptPropertyOrThrow(destinationKey);

  pushLineTextMessage(destination, text);

  return {
    source: source,
    destinationKey: destinationKey,
    targetMonth: formatMonthlyReportMonth(targetMonth),
    rows: rows.length,
    previousRows: previousRows.length
  };
}

function getMonthlyReportRows(source, monthStart) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = getTargetSheets(source);
  const sheet = ss.getSheetByName(sheets.data);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length > 0) values.shift();

  return values.filter(row => isRowInMonthlyReportMonth(row, monthStart));
}

function isRowInMonthlyReportMonth(row, monthStart) {
  const date = parseMonthlyReportDate(row[0]);
  return date &&
    date.getFullYear() === monthStart.getFullYear() &&
    date.getMonth() === monthStart.getMonth();
}

function getMonthlyReportTargetMonth(now) {
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

function getPreviousMonthlyReportMonth(monthStart) {
  return new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
}

// Registry lookups; an unknown source throws (never the household destination)
function getMonthlyReportDestinationPropertyKey(source) {
  return getSourceConfig(source).lineKey;
}

function getMonthlyReportSourceLabel(source) {
  return getSourceConfig(source).label;
}

function buildMonthlyKakeiboReportText(source, targetMonth, rows, previousRows) {
  const summary = summarizeMonthlyReportRows(rows);
  const previousSummary = summarizeMonthlyReportRows(previousRows);
  const categoryLines = buildMonthlyReportCategoryLines(summary, previousSummary);
  const topExpenseLines = buildMonthlyReportTopExpenseLines(summary.topExpenses);
  const closingLine = summary.balance >= 0 ? 'この調子でがんばるたま〜）' : 'ちょっとお金使いすぎたまね〜）';

  return [
    'たむたむ（先月の出費はこんな感じたま〜',
    `対象月: ${formatMonthlyReportMonth(targetMonth)}`,
    '',
    'サマリー (前月比)',
    `収入: ${formatMonthlyReportCurrency(summary.income)} (${formatMonthlyReportDiff(summary.income - previousSummary.income)})`,
    `支出: ${formatMonthlyReportCurrency(summary.expense)} (${formatMonthlyReportDiff(summary.expense - previousSummary.expense)})`,
    `収支: ${formatMonthlyReportCurrency(summary.balance)} (${formatMonthlyReportDiff(summary.balance - previousSummary.balance)})`,
    '',
    'カテゴリ別支出 (前月比)',
    categoryLines.join('\n'),
    '',
    '高額支出トップ5',
    topExpenseLines.join('\n'),
    '',
    closingLine
  ].join('\n');
}

function summarizeMonthlyReportRows(rows) {
  const summary = {
    income: 0,
    expense: 0,
    balance: 0,
    categoryExpenses: {},
    topExpenses: []
  };

  rows.forEach(row => {
    const type = row[6] || 'Expense';
    const amount = Number(row[2]) || 0;

    if (type === 'Income') {
      summary.income += amount;
      return;
    }

    const expenseAmount = Math.abs(amount);
    const category = row[3] || '未分類';
    summary.expense += expenseAmount;
    summary.categoryExpenses[category] = (summary.categoryExpenses[category] || 0) + expenseAmount;
    summary.topExpenses.push({
      date: parseMonthlyReportDate(row[0]),
      merchant: row[1] || '不明',
      category: category,
      amount: expenseAmount
    });
  });

  summary.balance = summary.income - summary.expense;
  summary.topExpenses.sort((a, b) => b.amount - a.amount);
  summary.topExpenses = summary.topExpenses.slice(0, 5);

  return summary;
}

function buildMonthlyReportCategoryLines(summary, previousSummary) {
  const categories = Object.keys(summary.categoryExpenses).sort((a, b) => {
    return summary.categoryExpenses[b] - summary.categoryExpenses[a];
  });

  if (categories.length === 0) return ['なし'];

  return categories.map(category => {
    const amount = summary.categoryExpenses[category] || 0;
    const previousAmount = previousSummary.categoryExpenses[category] || 0;
    return `${category}: ${formatMonthlyReportCurrency(amount)} (${formatMonthlyReportDiff(amount - previousAmount)})`;
  });
}

function buildMonthlyReportTopExpenseLines(topExpenses) {
  if (topExpenses.length === 0) return ['なし'];

  return topExpenses.map(expense => {
    return `${formatMonthlyReportDay(expense.date)} ${expense.merchant} [${expense.category}] ${formatMonthlyReportCurrency(expense.amount)}`;
  });
}

function pushLineTextMessage(to, text) {
  const token = getScriptPropertyOrThrow('LINE_CHANNEL_ACCESS_TOKEN');
  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`
    },
    payload: JSON.stringify({
      to: to,
      messages: [
        {
          type: 'text',
          text: text
        }
      ]
    }),
    muteHttpExceptions: true
  });

  const responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(`LINE push failed: ${responseCode} ${response.getContentText()}`);
  }
}

function getScriptPropertyOrThrow(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error(`Missing Script Property: ${key}`);
  }
  return value;
}

function parseMonthlyReportDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;

  const match = value.toString().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return null;

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatMonthlyReportMonth(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM');
}

function formatMonthlyReportDay(date) {
  if (!date) return '--/--';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MM/dd');
}

function formatMonthlyReportCurrency(amount) {
  const rounded = Math.round(amount);
  const prefix = rounded < 0 ? '-' : '';
  return `${prefix}¥${Math.abs(rounded).toLocaleString('ja-JP')}`;
}

function formatMonthlyReportDiff(amount) {
  const rounded = Math.round(amount);
  const prefix = rounded >= 0 ? '+' : '-';
  return `${prefix}${formatMonthlyReportCurrency(Math.abs(rounded))}`;
}

// =====================================================================
// --- Auth: users, passkeys, invites (design 2026-11-yuki-and-passkeys §3, §5.6) ---
// GAS never verifies WebAuthn signatures: the Next.js server verifies the
// registration / authentication responses (@simplewebauthn/server) and sends
// only the verified results here. GAS stores them, enforces one-time invites,
// one-time challenges and epochs, and is the source of truth for users.
//
// Sheets (created by setupAuthSheets; columns located by header name):
// - Auth_Users: AUTH_USERS_HEADERS (see the user table section above)
// - Auth_Credentials: AUTH_CREDENTIALS_HEADERS. credentialId / publicKey are
//   base64url (publicKey = COSE key) stored with the SHEET_B64U_PREFIX so a
//   value starting with "-" is never taken for a formula; counter is a number;
//   transports comma separated; revokedAt set = revoked (rows are not deleted).
// - Auth_Invites: AUTH_INVITES_HEADERS. Only the SHA-256 (hex) of the invite
//   token is stored; the token itself exists only in the editor's execution
//   log (createInvite) and in the invite URL fragment.
// Every write runs under the script lock; Auth_Users writes then call
// clearAuthUsersCache() before the lock is released (contract with the actor
// check of the data actions). No cell starts with = + - @ (free text is
// validated, generated values never do).

const AUTH_CREDENTIALS_SHEET_NAME = 'Auth_Credentials';
const AUTH_CREDENTIALS_HEADERS = Object.freeze(['credentialId', 'userId', 'publicKey', 'counter', 'transports', 'deviceType', 'backedUp', 'label', 'createdAt', 'lastUsedAt', 'revokedAt']);
const AUTH_INVITES_SHEET_NAME = 'Auth_Invites';
const AUTH_INVITES_HEADERS = Object.freeze(['inviteId', 'tokenHash', 'userId', 'purpose', 'expiresAt', 'createdBy', 'usedAt']);

// Web actions (POST only; key AND authKey required, see isAuthProxyRequest). None of them acts on
// another user: invites, user changes and other users' passkeys are editor
// functions only.
const AUTH_ACTIONS = Object.freeze([
  'authGetAdminUser',
  'authPeekInvite',
  'authConsumeInviteAndAddCredential',
  'authAddCredential',
  'authGetCredential',
  'authRecordCredentialUse',
  'authListCredentials',
  'authRevokeCredential',
  'authBumpEpoch',
  'authCreateLineLinkCode',
  'authLinkLine',
  'authGetLineLinkCandidate',
  'authConfirmLineLink'
]);

const INVITE_PURPOSES = Object.freeze(['register', 'recovery']);
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_RECOVERY_INVITE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_CACHE_PREFIX = 'kakeibo_auth_challenge_';
const CHALLENGE_TTL_SECONDS = 300;
const SHEET_B64U_PREFIX = 'b64u:';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CREDENTIAL_ID_LENGTH = 1364; // 1023 bytes (WebAuthn maximum) in base64url
const MAX_PUBLIC_KEY_LENGTH = 4096;
const MAX_COUNTER = 4294967295;
const WEBAUTHN_TRANSPORTS = Object.freeze(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card']);
const WEBAUTHN_DEVICE_TYPES = Object.freeze(['singleDevice', 'multiDevice']);
const MAX_NAME_LENGTH = 40;
const DEFAULT_PASSKEY_LABEL = 'パスキー';

// --- Auth: random values ---
// Apps Script does not document how Utilities.getUuid() generates its values
// (in particular not that it uses a cryptographically secure generator), and
// there is no other random API. Four UUIDs, the time and Math.random() are
// therefore hashed together with SHA-256: the 32-byte output is at least as
// unpredictable as the best of these inputs (4 x 122 random bits if getUuid is
// a random v4 UUID as it appears to be) and never weaker than one UUID.
function newRandomBytes() {
  const seed = [
    Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(),
    String(Date.now()), String(Math.random())
  ].join('|');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
}

function toBase64UrlNoPadding(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

// 256-bit secret token (43 base64url characters), for invite links
function newRandomToken() {
  return toBase64UrlNoPadding(newRandomBytes());
}

// Opaque 128-bit id such as u_xxxxxxxxxxxxxxxxxxxxxx (22 base64url characters)
function newOpaqueId(prefix) {
  return prefix + toBase64UrlNoPadding(newRandomBytes().slice(0, 16));
}

function sha256Hex(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('');
}

// --- Auth: sheet tables ---

function getAuthSheet(name) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
}

// Reads a sheet whose first row holds `headers` (in any order, extra columns
// allowed). Returns {sheet, rows, get, set, append} or null when the sheet
// is missing. Throws when a column is missing.
function readAuthTable(name, headers) {
  const sheet = getAuthSheet(name);
  if (!sheet) return null;
  const values = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [];
  if (values.length === 0) throw new Error(`${name} has no header row`);
  const header = values[0].map(cell => String(cell).trim());
  const index = {};
  headers.forEach(name2 => {
    index[name2] = header.indexOf(name2);
    if (index[name2] === -1) throw new Error(`${name}: column "${name2}" is missing`);
  });
  const width = header.length;
  const rows = values.slice(1).map((cells, i) => ({rowNumber: i + 2, cells: cells}));
  return {
    sheet: sheet,
    rows: rows,
    get: (row, column) => row.cells[index[column]],
    text: (row, column) => {
      const value = row.cells[index[column]];
      return value === undefined || value === null ? '' : String(value).trim();
    },
    set: (row, column, value) => {
      sheet.getRange(row.rowNumber, index[column] + 1).setValue(value);
      row.cells[index[column]] = value;
    },
    append: (record) => {
      const cells = [];
      for (let i = 0; i < width; i++) cells.push('');
      Object.keys(record).forEach(column => { cells[index[column]] = record[column]; });
      sheet.appendRow(cells);
      rows.push({rowNumber: rows.length + 2, cells: cells});
    }
  };
}

// Users of Auth_Users as {table, list, byId} or {error: 'AuthUnavailable'}.
// Same rules as the data-side parseAuthUsers: a userId on several rows is
// ignored entirely, rows with an invalid userId or epoch are ignored.
function loadAuthUsers() {
  let table;
  try {
    table = readAuthTable(AUTH_USERS_SHEET_NAME, AUTH_USERS_HEADERS);
  } catch (err) {
    console.error(`${AUTH_USERS_SHEET_NAME} could not be read: ${err.message}`);
    return {error: 'AuthUnavailable'};
  }
  if (!table) return {error: 'AuthUnavailable'};
  const count = Object.create(null);
  table.rows.forEach(row => {
    const id = table.text(row, 'userId');
    if (id !== '') count[id] = (count[id] || 0) + 1;
  });
  const list = [];
  const byId = Object.create(null);
  table.rows.forEach(row => {
    const userId = table.text(row, 'userId');
    if (userId === '' || count[userId] > 1 || !ACTOR_USER_ID_PATTERN.test(userId)) return;
    const rawEpoch = table.get(row, 'epoch');
    const epoch = parseEpoch(typeof rawEpoch === 'number' ? rawEpoch : String(rawEpoch).trim());
    if (epoch === null) return;
    const user = {
      row: row,
      userId: userId,
      displayName: table.text(row, 'displayName'),
      role: table.text(row, 'role'),
      sources: table.text(row, 'sources').split(',').map(s => s.trim()).filter(isSourceId),
      homeSource: table.text(row, 'homeSource'),
      epoch: epoch,
      status: table.text(row, 'status')
    };
    list.push(user);
    byId[userId] = user;
  });
  return {table: table, list: list, byId: byId};
}

function loadAuthCredentials() {
  try {
    return readAuthTable(AUTH_CREDENTIALS_SHEET_NAME, AUTH_CREDENTIALS_HEADERS);
  } catch (err) {
    console.error(`${AUTH_CREDENTIALS_SHEET_NAME} could not be read: ${err.message}`);
    return null;
  }
}

function loadAuthInvites() {
  try {
    return readAuthTable(AUTH_INVITES_SHEET_NAME, AUTH_INVITES_HEADERS);
  } catch (err) {
    console.error(`${AUTH_INVITES_SHEET_NAME} could not be read: ${err.message}`);
    return null;
  }
}

// The fields a session needs (no status / role)
function toSessionUser(user) {
  return {
    userId: user.userId,
    displayName: user.displayName,
    sources: user.sources.slice(),
    homeSource: user.homeSource,
    epoch: user.epoch
  };
}

function bumpUserEpoch(users, user) {
  const epoch = user.epoch + 1;
  users.table.set(user.row, 'epoch', epoch);
  users.table.set(user.row, 'updatedAt', new Date().toISOString());
  user.epoch = epoch;
  return epoch;
}

function toSheetBase64Url(value) {
  return SHEET_B64U_PREFIX + value;
}

function fromSheetBase64Url(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text.indexOf(SHEET_B64U_PREFIX) === 0 ? text.slice(SHEET_B64U_PREFIX.length) : text;
}

function credentialIdOf(credentials, row) {
  return fromSheetBase64Url(credentials.get(row, 'credentialId'));
}

function isRevokedCredential(credentials, row) {
  return credentials.text(row, 'revokedAt') !== '';
}

// Rows with exactly this credential id (revoked or not)
function findCredentialRows(credentials, credentialId) {
  return credentials.rows.filter(row => credentialIdOf(credentials, row) === credentialId);
}

function activeCredentialsOf(credentials, userId) {
  return credentials.rows.filter(row =>
    credentials.text(row, 'userId') === userId && !isRevokedCredential(credentials, row));
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  const time = Date.parse(String(value));
  return isNaN(time) ? null : time;
}

// --- Auth: input validation ---

function isSha256Hex(value) {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

function isBase64Url(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && BASE64URL_PATTERN.test(value);
}

// Free text written to a sheet: trimmed, 1..MAX_NAME_LENGTH characters, no
// control characters, and never starting with = + - @ (formula injection).
// Returns the trimmed value or null.
function validateSheetText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_NAME_LENGTH) return null;
  if (/^[=+\-@]/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function isValidCounter(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNTER;
}

// The verified registration result sent by the proxy. Returns the normalized
// credential or null.
function validateCredentialInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!isBase64Url(input.credentialId, MAX_CREDENTIAL_ID_LENGTH)) return null;
  if (!isBase64Url(input.publicKey, MAX_PUBLIC_KEY_LENGTH)) return null;
  if (!isValidCounter(input.counter)) return null;
  let transports = [];
  if (input.transports !== undefined) {
    if (!Array.isArray(input.transports) || input.transports.length > WEBAUTHN_TRANSPORTS.length) return null;
    if (!input.transports.every(t => WEBAUTHN_TRANSPORTS.indexOf(t) !== -1)) return null;
    transports = input.transports.filter((t, i, all) => all.indexOf(t) === i);
  }
  if (input.deviceType !== undefined && WEBAUTHN_DEVICE_TYPES.indexOf(input.deviceType) === -1) return null;
  if (input.backedUp !== undefined && typeof input.backedUp !== 'boolean') return null;
  let label = DEFAULT_PASSKEY_LABEL;
  if (input.label !== undefined) {
    label = validateSheetText(input.label);
    if (label === null) return null;
  }
  return {
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    counter: input.counter,
    transports: transports,
    deviceType: input.deviceType || '',
    backedUp: input.backedUp === true,
    label: label
  };
}

function appendCredentialRow(credentials, userId, credential) {
  credentials.append({
    credentialId: toSheetBase64Url(credential.credentialId),
    userId: userId,
    publicKey: toSheetBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports.join(','),
    deviceType: credential.deviceType,
    backedUp: credential.backedUp,
    label: credential.label,
    createdAt: new Date().toISOString(),
    lastUsedAt: '',
    revokedAt: ''
  });
}

// --- Auth: one-time challenges (§3.4) ---
// Must be called while holding the script lock. Returns false when the
// challenge hash was already recorded (reuse), otherwise records it for
// CHALLENGE_TTL_SECONDS and returns true. If the cache is unavailable the
// request proceeds (logged): the 5-minute signed challenge cookie of the
// Next.js side remains the defence, as the design accepts.
function recordChallengeOnce(challengeHash) {
  try {
    const cache = CacheService.getScriptCache();
    const key = CHALLENGE_CACHE_PREFIX + challengeHash;
    if (cache.get(key) !== null) return false;
    cache.put(key, '1', CHALLENGE_TTL_SECONDS);
  } catch (err) {
    console.warn(`Challenge record unavailable (reuse not checked): ${err}`);
  }
  return true;
}

// --- Auth: Web actions ---

// Called by doPost for AUTH_ACTIONS, after the key check. Never throws and
// never returns internal error text (generic 'AuthError').
function handleAuthAction(params) {
  // Only the auth proxy (authKey); `key` alone can come through the old
  // /api/expenses proxy from any logged-in browser. No migration pass-through.
  if (!isAuthProxyRequest(params)) return {error: 'Unauthorized'};
  try {
    switch (params.action) {
      case 'authGetAdminUser': return authGetAdminUser();
      case 'authPeekInvite': return authPeekInvite(params);
      case 'authConsumeInviteAndAddCredential': return authConsumeInviteAndAddCredential(params);
      case 'authAddCredential': return authAddCredential(params);
      case 'authGetCredential': return authGetCredential(params);
      case 'authRecordCredentialUse': return authRecordCredentialUse(params);
      case 'authListCredentials': return authListCredentials(params);
      case 'authRevokeCredential': return authRevokeCredential(params);
      case 'authBumpEpoch': return authBumpEpoch(params);
      case 'authCreateLineLinkCode': return authCreateLineLinkCode(params);
      case 'authLinkLine': return authLinkLine(params);
      case 'authGetLineLinkCandidate': return authGetLineLinkCandidate(params);
      case 'authConfirmLineLink': return authConfirmLineLink(params);
      default: return {error: 'Unknown action'};
    }
  } catch (err) {
    console.error(`${params.action} failed: ${err}`);
    return {error: 'AuthError'};
  }
}

function runAuthWrite(fn) {
  return runWithScriptLock(fn, () => ({error: 'Busy'}));
}

// The actor (actorUserId / actorEpoch) of an auth action is mandatory and
// checked against the sheet (not the cache). Returns {user} or {error}.
function requireAuthActor(params, users) {
  const parsed = readActorParams(params);
  if (parsed.error || !parsed.actor) return {error: 'Invalid actor'};
  const user = users.byId[parsed.actor.userId];
  if (!user || user.status !== 'active' || user.epoch !== parsed.actor.epoch) return {error: 'SessionRevoked'};
  return {user: user};
}

// Password login during the migration (§3.10): the single active admin.
function authGetAdminUser() {
  const users = loadAuthUsers();
  if (users.error) return users;
  const admins = users.list.filter(user => user.role === 'admin' && user.status === 'active');
  if (admins.length === 0) return {error: 'AdminNotFound'};
  if (admins.length > 1) return {error: 'AdminAmbiguous'};
  const user = toSessionUser(admins[0]);
  return {success: true, user: {userId: user.userId, displayName: user.displayName, role: 'admin', sources: user.sources, homeSource: user.homeSource, epoch: user.epoch}};
}

// The invite row for tokenHash if it is usable now (unused, not expired, for
// an active user), else null. `users` / `invites` are loaded tables.
function findUsableInvite(invites, users, tokenHash) {
  const rows = invites.rows.filter(row => invites.text(row, 'tokenHash') === tokenHash);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (invites.text(row, 'usedAt') !== '') return null;
  if (INVITE_PURPOSES.indexOf(invites.text(row, 'purpose')) === -1) return null;
  const expiresAt = toTimestamp(invites.get(row, 'expiresAt'));
  if (expiresAt === null || Date.now() >= expiresAt) return null;
  const user = users.byId[invites.text(row, 'userId')];
  if (!user || user.status !== 'active') return null;
  return {row: row, user: user, purpose: invites.text(row, 'purpose')};
}

// register/options: is the invite usable? Does not consume it.
function authPeekInvite(params) {
  if (!isSha256Hex(params.tokenHash)) return {error: 'Invalid input'};
  const users = loadAuthUsers();
  if (users.error) return users;
  const invites = loadAuthInvites();
  const credentials = loadAuthCredentials();
  if (!invites || !credentials) return {error: 'AuthUnavailable'};
  const invite = findUsableInvite(invites, users, params.tokenHash);
  if (!invite) return {error: 'InviteInvalid'};
  return {
    success: true,
    purpose: invite.purpose,
    user: {userId: invite.user.userId, displayName: invite.user.displayName},
    // For excludeCredentials (no second registration of the same device)
    credentials: activeCredentialsOf(credentials, invite.user.userId).map(row => ({
      credentialId: credentialIdOf(credentials, row),
      transports: credentials.text(row, 'transports').split(',').filter(Boolean)
    }))
  };
}

// register/verify: consume the invite and add the verified passkey,
// atomically under the script lock (one-time invite, one-time challenge).
function authConsumeInviteAndAddCredential(params) {
  const credential = validateCredentialInput(params.credential);
  if (!isSha256Hex(params.tokenHash) || !isSha256Hex(params.challengeHash) || !credential) {
    return {error: 'Invalid input'};
  }
  return runAuthWrite(() => {
    const users = loadAuthUsers();
    if (users.error) return users;
    const invites = loadAuthInvites();
    const credentials = loadAuthCredentials();
    if (!invites || !credentials) return {error: 'AuthUnavailable'};
    const invite = findUsableInvite(invites, users, params.tokenHash);
    if (!invite) return {error: 'InviteInvalid'};
    if (findCredentialRows(credentials, credential.credentialId).length > 0) return {error: 'CredentialExists'};
    if (!recordChallengeOnce(params.challengeHash)) return {error: 'ChallengeReused'};
    invites.set(invite.row, 'usedAt', new Date().toISOString());
    appendCredentialRow(credentials, invite.user.userId, credential);
    console.log(`Passkey registered via ${invite.purpose} invite for ${invite.user.userId}`);
    return {success: true, user: toSessionUser(invite.user)};
  });
}

// passkeys/add/verify: a re-authenticated user adds a passkey. bootstrap
// (password re-entry instead of a passkey, §3.3/3.10) is allowed only for an
// admin without any active passkey; otherwise at least one passkey must exist.
function authAddCredential(params) {
  const credential = validateCredentialInput(params.credential);
  if (!isSha256Hex(params.challengeHash) || !credential ||
      (params.bootstrap !== undefined && typeof params.bootstrap !== 'boolean')) {
    return {error: 'Invalid input'};
  }
  return runAuthWrite(() => {
    const users = loadAuthUsers();
    if (users.error) return users;
    const credentials = loadAuthCredentials();
    if (!credentials) return {error: 'AuthUnavailable'};
    const actor = requireAuthActor(params, users);
    if (actor.error) return actor;
    const count = activeCredentialsOf(credentials, actor.user.userId).length;
    if (params.bootstrap === true) {
      if (actor.user.role !== 'admin' || count > 0) return {error: 'BootstrapNotAllowed'};
    } else if (count === 0) {
      return {error: 'NoExistingCredential'};
    }
    if (findCredentialRows(credentials, credential.credentialId).length > 0) return {error: 'CredentialExists'};
    if (!recordChallengeOnce(params.challengeHash)) return {error: 'ChallengeReused'};
    appendCredentialRow(credentials, actor.user.userId, credential);
    console.log(`Passkey added for ${actor.user.userId}${params.bootstrap === true ? ' (bootstrap)' : ''}`);
    return {success: true, credentialCount: count + 1};
  });
}

// The active credential row and its active user, or null
function findActiveCredential(credentials, users, credentialId) {
  const rows = findCredentialRows(credentials, credentialId);
  if (rows.length !== 1 || isRevokedCredential(credentials, rows[0])) return null;
  const user = users.byId[credentials.text(rows[0], 'userId')];
  if (!user || user.status !== 'active') return null;
  return {row: rows[0], user: user};
}

// login/verify (and passkeys/add/reauth): the stored public key for verification
function authGetCredential(params) {
  if (!isBase64Url(params.credentialId, MAX_CREDENTIAL_ID_LENGTH)) return {error: 'Invalid input'};
  const users = loadAuthUsers();
  if (users.error) return users;
  const credentials = loadAuthCredentials();
  if (!credentials) return {error: 'AuthUnavailable'};
  const found = findActiveCredential(credentials, users, params.credentialId);
  if (!found) return {error: 'CredentialNotFound'};
  const counter = Number(credentials.get(found.row, 'counter'));
  return {
    success: true,
    credential: {
      credentialId: params.credentialId,
      userId: found.user.userId,
      publicKey: fromSheetBase64Url(credentials.get(found.row, 'publicKey')),
      counter: isValidCounter(counter) ? counter : 0,
      transports: credentials.text(found.row, 'transports').split(',').filter(Boolean)
    },
    user: toSessionUser(found.user)
  };
}

// After a verified authentication: one-time challenge, lastUsedAt, and the
// counter when it increased (synced passkeys always report 0).
function authRecordCredentialUse(params) {
  if (!isBase64Url(params.credentialId, MAX_CREDENTIAL_ID_LENGTH) ||
      !isValidCounter(params.counter) || !isSha256Hex(params.challengeHash)) {
    return {error: 'Invalid input'};
  }
  return runAuthWrite(() => {
    const users = loadAuthUsers();
    if (users.error) return users;
    const credentials = loadAuthCredentials();
    if (!credentials) return {error: 'AuthUnavailable'};
    const found = findActiveCredential(credentials, users, params.credentialId);
    if (!found) return {error: 'CredentialNotFound'};
    if (!recordChallengeOnce(params.challengeHash)) return {error: 'ChallengeReused'};
    credentials.set(found.row, 'lastUsedAt', new Date().toISOString());
    const stored = Number(credentials.get(found.row, 'counter'));
    if (!isValidCounter(stored) || params.counter > stored) credentials.set(found.row, 'counter', params.counter);
    return {success: true};
  });
}

// The actor's own active passkeys (no public keys)
function authListCredentials(params) {
  const users = loadAuthUsers();
  if (users.error) return users;
  const credentials = loadAuthCredentials();
  if (!credentials) return {error: 'AuthUnavailable'};
  const actor = requireAuthActor(params, users);
  if (actor.error) return actor;
  return {
    success: true,
    credentials: activeCredentialsOf(credentials, actor.user.userId).map(row => ({
      credentialId: credentialIdOf(credentials, row),
      label: credentials.text(row, 'label'),
      deviceType: credentials.text(row, 'deviceType'),
      backedUp: credentials.get(row, 'backedUp') === true || credentials.text(row, 'backedUp').toUpperCase() === 'TRUE',
      createdAt: credentials.text(row, 'createdAt'),
      lastUsedAt: credentials.text(row, 'lastUsedAt')
    }))
  };
}

// Revokes one of the actor's own passkeys and bumps the epoch (every session
// of the actor, including this one, must log in again).
function authRevokeCredential(params) {
  if (!isBase64Url(params.credentialId, MAX_CREDENTIAL_ID_LENGTH)) return {error: 'Invalid input'};
  return runAuthWrite(() => {
    const users = loadAuthUsers();
    if (users.error) return users;
    const credentials = loadAuthCredentials();
    if (!credentials) return {error: 'AuthUnavailable'};
    const actor = requireAuthActor(params, users);
    if (actor.error) return actor;
    const rows = findCredentialRows(credentials, params.credentialId).filter(row =>
      credentials.text(row, 'userId') === actor.user.userId && !isRevokedCredential(credentials, row));
    if (rows.length !== 1) return {error: 'CredentialNotFound'};
    credentials.set(rows[0], 'revokedAt', new Date().toISOString());
    const epoch = bumpUserEpoch(users, actor.user);
    clearAuthUsersCache();
    console.log(`Passkey revoked by ${actor.user.userId}; epoch is now ${epoch}`);
    return {success: true, epoch: epoch};
  });
}

// "Log out everywhere" for the actor
function authBumpEpoch(params) {
  return runAuthWrite(() => {
    const users = loadAuthUsers();
    if (users.error) return users;
    const actor = requireAuthActor(params, users);
    if (actor.error) return actor;
    const epoch = bumpUserEpoch(users, actor.user);
    clearAuthUsersCache();
    return {success: true, epoch: epoch};
  });
}

// --- Auth: editor functions (run by the sheet owner from the Apps Script editor) ---
// They throw on any problem (the editor shows the error) and never log
// secrets: the only secret, the invite token, is logged once by createInvite.

function runAuthEditorTask(name, fn) {
  return runWithScriptLock(fn, () => {
    throw new Error(`${name}: could not acquire the script lock; run it again later.`);
  }, FIXED_COST_LOCK_WAIT_MS);
}

function requireAuthUsers() {
  const users = loadAuthUsers();
  if (users.error) throw new Error(`${AUTH_USERS_SHEET_NAME} is missing or unreadable: run setupAuthSheets() first.`);
  return users;
}

// `user` is a userId or a displayName (exact match). Throws when no user or
// more than one user matches.
function resolveAuthUser(users, user) {
  const key = typeof user === 'string' ? user.trim() : '';
  if (key === '') throw new Error('User not found: give a userId or a displayName.');
  if (users.byId[key]) return users.byId[key];
  const matches = users.list.filter(u => u.displayName === key);
  if (matches.length === 0) throw new Error(`User not found: ${key}`);
  if (matches.length > 1) throw new Error(`More than one user is named ${key} (ambiguous): use the userId.`);
  return matches[0];
}

function requireSingleAdmin(users) {
  const admins = users.list.filter(user => user.role === 'admin' && user.status === 'active');
  if (admins.length !== 1) throw new Error(`Expected exactly one active admin, found ${admins.length}.`);
  return admins[0];
}

function ensureAuthSheet(ss, name, headers) {
  const existing = ss.getSheetByName(name);
  if (existing && existing.getLastRow() > 0) return false;
  const sheet = existing || ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
  return true;
}

// Logs (never the values) when the secrets needed by auth actions are not
// usable: AUTH_PROXY_SECRET / PROXY_SECRET unset, or both set to the same value.
function warnAboutAuthProxySecret() {
  const props = PropertiesService.getScriptProperties();
  const proxySecret = props.getProperty('PROXY_SECRET');
  const authSecret = props.getProperty('AUTH_PROXY_SECRET');
  if (!proxySecret) console.warn('PROXY_SECRET is not set: auth actions and actor requests are refused.');
  if (!authSecret) {
    console.warn('AUTH_PROXY_SECRET is not set: auth actions and actor requests are refused until it is set (same value as Vercel GAS_AUTH_PROXY_SECRET).');
  } else if (proxySecret && constantTimeEquals(authSecret, proxySecret)) {
    console.warn('AUTH_PROXY_SECRET has the same value as PROXY_SECRET: use a different random value for each.');
  }
}

// Creates the Auth_* sheets that are missing and, when Auth_Users has no
// admin row at all, the admin user (sources main,yahoo; epoch 0). Idempotent.
function setupAuthSheets() {
  return runAuthEditorTask('setupAuthSheets', () => {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const created = [];
    if (ensureAuthSheet(ss, AUTH_USERS_SHEET_NAME, AUTH_USERS_HEADERS)) created.push(AUTH_USERS_SHEET_NAME);
    if (ensureAuthSheet(ss, AUTH_CREDENTIALS_SHEET_NAME, AUTH_CREDENTIALS_HEADERS)) created.push(AUTH_CREDENTIALS_SHEET_NAME);
    if (ensureAuthSheet(ss, AUTH_INVITES_SHEET_NAME, AUTH_INVITES_HEADERS)) created.push(AUTH_INVITES_SHEET_NAME);
    if (ensureAuthSheet(ss, AUTH_LINE_LINKS_SHEET_NAME, AUTH_LINE_LINKS_HEADERS)) created.push(AUTH_LINE_LINKS_SHEET_NAME);

    const users = requireAuthUsers();
    let adminUserId = null;
    const hasAdminRow = users.table.rows.some(row => users.table.text(row, 'role') === 'admin');
    if (!hasAdminRow) {
      adminUserId = newOpaqueId('u_');
      const now = new Date().toISOString();
      users.table.append({
        userId: adminUserId, displayName: '管理者', role: 'admin', sources: 'main,yahoo',
        homeSource: 'main', epoch: 0, status: 'active', createdAt: now, updatedAt: now
      });
    }
    if (created.indexOf(AUTH_USERS_SHEET_NAME) !== -1 || adminUserId) clearAuthUsersCache();
    console.log(`setupAuthSheets: created sheets ${JSON.stringify(created)}${adminUserId ? `, admin user ${adminUserId}` : ', admin user already present'}`);
    warnAboutAuthProxySecret();
    return {created: created, adminUserId: adminUserId};
  });
}

// addUser('Yuki', ['yuki', 'main'], 'yuki') -> the new userId (role member)
function addUser(displayName, sources, homeSource) {
  const name = validateSheetText(displayName);
  if (name === null) throw new Error(`displayName must be 1-${MAX_NAME_LENGTH} characters and must not start with = + - @.`);
  const list = (Array.isArray(sources) ? sources : String(sources || '').split(','))
    .map(s => String(s).trim()).filter(s => s !== '');
  if (list.length === 0) throw new Error('At least one source is required.');
  list.forEach(s => { if (!isSourceId(s)) throw new Error(`Unknown source: ${s}`); });
  const unique = list.filter((s, i) => list.indexOf(s) === i);
  if (unique.indexOf(homeSource) === -1) throw new Error('homeSource must be one of the sources.');
  return runAuthEditorTask('addUser', () => {
    const users = requireAuthUsers();
    const sameName = users.table.rows.filter(row => users.table.text(row, 'displayName') === name);
    if (sameName.length > 0) {
      // Idempotent: the same user again returns the existing userId
      const existing = sameName.length === 1 ? users.list.filter(u => u.row === sameName[0])[0] : null;
      const sameSet = (a, b) => a.length === b.length && a.every(s => b.indexOf(s) !== -1);
      if (existing && existing.role === 'member' && existing.homeSource === homeSource && sameSet(existing.sources, unique)) {
        console.log(`addUser: ${name} already exists as ${existing.userId} (status ${existing.status}); nothing added`);
        return existing.userId;
      }
      throw new Error(`A user named ${name} already exists with a different role, sources or homeSource.`);
    }
    const userId = newOpaqueId('u_');
    const now = new Date().toISOString();
    users.table.append({
      userId: userId, displayName: name, role: 'member', sources: unique.join(','),
      homeSource: homeSource, epoch: 0, status: 'active', createdAt: now, updatedAt: now
    });
    clearAuthUsersCache();
    console.log(`addUser: ${name} -> ${userId} (${unique.join(',')}, home ${homeSource})`);
    return userId;
  });
}

// Disables a user and bumps the epoch (every session ends). Returns the epoch.
function disableUser(user) {
  return runAuthEditorTask('disableUser', () => {
    const users = requireAuthUsers();
    const target = resolveAuthUser(users, user);
    users.table.set(target.row, 'status', 'disabled');
    const epoch = bumpUserEpoch(users, target);
    clearAuthUsersCache();
    console.log(`disableUser: ${target.userId} disabled, epoch ${epoch}`);
    return epoch;
  });
}

// "Log out everywhere" for any user. Returns the new epoch.
function bumpEpoch(user) {
  return runAuthEditorTask('bumpEpoch', () => {
    const users = requireAuthUsers();
    const target = resolveAuthUser(users, user);
    const epoch = bumpUserEpoch(users, target);
    clearAuthUsersCache();
    console.log(`bumpEpoch: ${target.userId} epoch ${epoch}`);
    return epoch;
  });
}

// The app origin for invite links, from Script Property APP_ORIGIN
// (https://<host>[:port], or http://localhost[:port] for development).
function getAppOrigin() {
  const origin = PropertiesService.getScriptProperties().getProperty('APP_ORIGIN');
  if (!origin || !/^(https:\/\/[A-Za-z0-9.-]+|http:\/\/localhost)(:\d{1,5})?$/.test(origin)) {
    throw new Error('Script Property APP_ORIGIN must be set to the app origin, e.g. https://<domain> (no path).');
  }
  return origin;
}

// Creates a one-time invite (purpose 'register' or 'recovery') and writes the
// link ONLY to the execution log. Valid 24 hours; an admin recovery invite 10
// minutes. Earlier unused invites of the same user stop working. Returns
// {inviteId, userId, purpose, expiresAt} (never the token).
function createInvite(user, purpose) {
  if (INVITE_PURPOSES.indexOf(purpose) === -1) throw new Error(`purpose must be one of ${INVITE_PURPOSES.join(', ')}.`);
  const origin = getAppOrigin();
  return runAuthEditorTask('createInvite', () => {
    const users = requireAuthUsers();
    const invites = loadAuthInvites();
    if (!invites) throw new Error(`${AUTH_INVITES_SHEET_NAME} is missing: run setupAuthSheets() first.`);
    const target = resolveAuthUser(users, user);
    if (target.status !== 'active') throw new Error(`User ${target.userId} is not active.`);

    const now = new Date();
    let invalidated = 0;
    invites.rows.forEach(row => {
      if (invites.text(row, 'userId') === target.userId && invites.text(row, 'usedAt') === '') {
        invites.set(row, 'usedAt', now.toISOString());
        invalidated++;
      }
    });
    const ttl = purpose === 'recovery' && target.role === 'admin' ? ADMIN_RECOVERY_INVITE_TTL_MS : INVITE_TTL_MS;
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    const token = newRandomToken();
    const inviteId = newOpaqueId('i_');
    invites.append({
      inviteId: inviteId, tokenHash: sha256Hex(token), userId: target.userId, purpose: purpose,
      expiresAt: expiresAt, createdBy: 'editor', usedAt: ''
    });
    console.log(`Invite for ${target.displayName} (${purpose}, expires ${expiresAt}${invalidated ? `, ${invalidated} older invite(s) invalidated` : ''}). Send this link privately: ${origin}/invite#${token}`);
    return {inviteId: inviteId, userId: target.userId, purpose: purpose, expiresAt: expiresAt};
  });
}

// Revokes one active passkey of `user`, chosen by its full credential id or by
// a unique prefix of at least 8 characters (as listUsers shows), and bumps the
// user's epoch.
function revokeCredential(user, credentialIdPrefix) {
  const prefix = typeof credentialIdPrefix === 'string' ? credentialIdPrefix.trim() : '';
  if (prefix.length < 8) throw new Error('Give at least 8 characters of the credential id (see listUsers()).');
  return runAuthEditorTask('revokeCredential', () => {
    const users = requireAuthUsers();
    const credentials = loadAuthCredentials();
    if (!credentials) throw new Error(`${AUTH_CREDENTIALS_SHEET_NAME} is missing: run setupAuthSheets() first.`);
    const target = resolveAuthUser(users, user);
    const active = activeCredentialsOf(credentials, target.userId);
    const exact = active.filter(row => credentialIdOf(credentials, row) === prefix);
    const matches = exact.length > 0 ? exact : active.filter(row => credentialIdOf(credentials, row).indexOf(prefix) === 0);
    if (matches.length === 0) throw new Error(`No active passkey of ${target.userId} starts with that id (not found).`);
    if (matches.length > 1) throw new Error(`More than one passkey starts with that id (ambiguous): give more characters.`);
    credentials.set(matches[0], 'revokedAt', new Date().toISOString());
    const epoch = bumpUserEpoch(users, target);
    clearAuthUsersCache();
    console.log(`revokeCredential: passkey ${prefix.slice(0, 8)}... of ${target.userId} revoked, epoch ${epoch}`);
    return epoch;
  });
}

// Logs every user and passkey (never public keys). Returns the same data.
function listUsers() {
  const users = requireAuthUsers();
  const credentials = loadAuthCredentials();
  const result = users.list.map(user => ({
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    sources: user.sources.slice(),
    homeSource: user.homeSource,
    epoch: user.epoch,
    status: user.status,
    passkeys: credentials ? credentials.rows
      .filter(row => credentials.text(row, 'userId') === user.userId)
      .map(row => ({
        credentialIdPrefix: credentialIdOf(credentials, row).slice(0, 12),
        label: credentials.text(row, 'label'),
        createdAt: credentials.text(row, 'createdAt'),
        lastUsedAt: credentials.text(row, 'lastUsedAt'),
        revokedAt: credentials.text(row, 'revokedAt')
      })) : []
  }));
  result.forEach(user => {
    console.log(`${user.displayName} ${user.userId} role=${user.role} sources=${user.sources.join(',')} home=${user.homeSource} epoch=${user.epoch} status=${user.status}`);
    user.passkeys.forEach(key => {
      console.log(`  passkey ${key.credentialIdPrefix}... "${key.label}" created=${key.createdAt} lastUsed=${key.lastUsedAt || '-'}${key.revokedAt ? ` REVOKED ${key.revokedAt}` : ''}`);
    });
  });
  return result;
}

// --- Auth: argument-free wrappers for the editor's Run button (§7.2) ---
// The editor cannot pass arguments; these cover the planned operations.
function addYukiUser() {
  return addUser('Yuki', ['yuki', 'main'], 'yuki');
}

function createYukiRegisterInvite() {
  return createInvite('Yuki', 'register');
}

function createYukiRecoveryInvite() {
  return createInvite('Yuki', 'recovery');
}

function createAdminRecoveryInvite() {
  return createInvite(requireSingleAdmin(requireAuthUsers()).userId, 'recovery');
}

function bumpAdminEpoch() {
  return bumpEpoch(requireSingleAdmin(requireAuthUsers()).userId);
}

// =====================================================================
// --- Auth: LINE linking (design 2026-11-yuki-and-passkeys §5.4) ---
// Sets the monthly report destination (SOURCES[source].lineKey) of the
// user's own lineOptional source (yuki) to that user's LINE userId:
// 1. authCreateLineLinkCode (actor): a one-time code, 10 unambiguous
//    characters, valid 10 minutes, one per user (a new one replaces the old);
//    the target source is fixed here, never by the webhook. Only its SHA-256
//    is stored (Auth_LineLinks).
// 2. authLinkLine (the Vercel webhook, after verifying X-Line-Signature):
//    a code sent by a LINE user. Rate limited; a match only stores the LINE
//    userId as a candidate (Script Cache, 10 minutes) — not a destination yet.
// 3. authGetLineLinkCandidate (actor): the candidate's LINE display name (LINE
//    profile API), shown to the user.
// 4. authConfirmLineLink (actor, confirm | cancel): only the user's own
//    confirmation writes the destination Script Property.
// main / yahoo destinations can never be set: only lineOptional sources the
// actor owns can be linked, checked at creation and again at confirmation.
// The LINE userId is stored only in the destination property (and briefly in
// the cache); the display name only goes to the response. Neither the code,
// the LINE userId, the display name nor the token is ever logged.
//
// Failed matches are counted per LINE userId (not per code as the design's
// first draft said): 3 failures within 10 minutes block that LINE user only.
// Invalidating every valid code after 3 failures would let any friend of the
// official account cancel Yuki's code with three wrong messages. A code has
// 50 bits and the overall limit allows 20 attempts per 10 minutes, so guessing
// a live code stays out of reach without invalidating codes.

const AUTH_LINE_LINKS_SHEET_NAME = 'Auth_LineLinks';
const AUTH_LINE_LINKS_HEADERS = Object.freeze(['linkId', 'userId', 'source', 'codeHash', 'status', 'expiresAt', 'candidateExpiresAt', 'createdAt', 'resolvedAt']);
const LINE_LINK_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 symbols, no 0 O 1 I l
const LINE_LINK_CODE_LENGTH = 10; // 50 bits
const LINE_LINK_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
const LINE_LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINE_LINK_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
const LINE_LINK_WINDOW_MS = 10 * 60 * 1000;
const LINE_LINK_MAX_PER_USER = 5;
const LINE_LINK_MAX_TOTAL = 20;
const LINE_LINK_MAX_FAILURES = 3;
const LINE_LINK_CACHE_PREFIX = 'kakeibo_line_';
const LINE_LINK_DECISIONS = Object.freeze(['confirm', 'cancel']);

function newLineLinkCode() {
  const bytes = newRandomBytes(); // 32 bytes; 32 symbols = 5 bits per byte, no bias
  let code = '';
  for (let i = 0; i < LINE_LINK_CODE_LENGTH; i++) code += LINE_LINK_CODE_ALPHABET.charAt(((bytes[i] + 256) % 256) & 31);
  return code;
}

function loadAuthLineLinks() {
  try {
    return readAuthTable(AUTH_LINE_LINKS_SHEET_NAME, AUTH_LINE_LINKS_HEADERS);
  } catch (err) {
    console.error(`${AUTH_LINE_LINKS_SHEET_NAME} could not be read: ${err.message}`);
    return null;
  }
}

function lineCandidateCacheKey(linkId) {
  return `${LINE_LINK_CACHE_PREFIX}candidate_${linkId}`;
}

// Cache keys never contain the LINE userId itself
function lineUserCacheKey(kind, lineUserId) {
  return `${LINE_LINK_CACHE_PREFIX}${kind}_${sha256Hex(lineUserId).slice(0, 32)}`;
}

// Timestamps (ms) stored under `key` that are still inside the window
function readRecentTimestamps(cache, key, now) {
  let list = [];
  try {
    list = JSON.parse(cache.get(key) || '[]');
  } catch (err) {
    list = [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter(t => typeof t === 'number' && t > now - LINE_LINK_WINDOW_MS && t <= now);
}

function writeTimestamps(cache, key, list) {
  cache.put(key, JSON.stringify(list), Math.ceil(LINE_LINK_WINDOW_MS / 1000) + 60);
}

// The actor's lineOptional sources (the destinations they may link)
function getLinkableSources(user) {
  return user.sources.filter(source => getSourceConfig(source).lineOptional);
}

function isLinkActive(links, row, now) {
  const status = links.text(row, 'status');
  if (status === 'pending') {
    const expiresAt = toTimestamp(links.get(row, 'expiresAt'));
    return expiresAt !== null && now < expiresAt;
  }
  if (status === 'candidate') {
    const expiresAt = toTimestamp(links.get(row, 'candidateExpiresAt'));
    return expiresAt !== null && now < expiresAt;
  }
  return false;
}

// The user's live link row (pending or candidate), or null
function findActiveLink(links, userId, now) {
  const rows = links.rows.filter(row => links.text(row, 'userId') === userId && isLinkActive(links, row, now));
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

function readLineCandidate(linkId) {
  try {
    const value = CacheService.getScriptCache().get(lineCandidateCacheKey(linkId));
    return value && LINE_USER_ID_PATTERN.test(value) ? value : null;
  } catch (err) {
    console.warn(`LINE link candidate unavailable: ${err}`);
    return null;
  }
}

function dropLineCandidate(linkId) {
  try {
    CacheService.getScriptCache().remove(lineCandidateCacheKey(linkId));
  } catch (err) {
    console.warn(`LINE link candidate cleanup failed (expires by itself): ${err}`);
  }
}

function authCreateLineLinkCode(params) {
  if (params.source !== undefined && typeof params.source !== 'string') return {error: 'Invalid input'};
  return runAuthWrite(() => {
    const users = loadAuthUsers();
    if (users.error) return users;
    const links = loadAuthLineLinks();
    if (!links) return {error: 'AuthUnavailable'};
    const actor = requireAuthActor(params, users);
    if (actor.error) return actor;

    const linkable = getLinkableSources(actor.user);
    let source;
    if (params.source !== undefined) {
      if (linkable.indexOf(params.source) === -1) return {error: 'Forbidden'};
      source = params.source;
    } else {
      if (linkable.length !== 1) return {error: 'Forbidden'};
      source = linkable[0];
    }

    const now = new Date();
    links.rows.forEach(row => {
      const status = links.text(row, 'status');
      if (links.text(row, 'userId') === actor.user.userId && (status === 'pending' || status === 'candidate')) {
        links.set(row, 'status', 'replaced');
        links.set(row, 'resolvedAt', now.toISOString());
        dropLineCandidate(links.text(row, 'linkId'));
      }
    });
    const code = newLineLinkCode();
    const expiresAt = new Date(now.getTime() + LINE_LINK_CODE_TTL_MS).toISOString();
    links.append({
      linkId: newOpaqueId('l_'), userId: actor.user.userId, source: source, codeHash: sha256Hex(code),
      status: 'pending', expiresAt: expiresAt, candidateExpiresAt: '', createdAt: now.toISOString(), resolvedAt: ''
    });
    console.log(`LINE link code issued for ${actor.user.userId} (${source})`);
    return {success: true, code: code, source: source, expiresAt: expiresAt};
  });
}

// From the Vercel webhook (signature already verified there): a LINE user
// sent something shaped like a link code.
function authLinkLine(params) {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : '';
  const lineUserId = params.lineUserId;
  if (!LINE_LINK_CODE_PATTERN.test(code) || typeof lineUserId !== 'string' || !LINE_USER_ID_PATTERN.test(lineUserId)) {
    return {error: 'Invalid input'};
  }
  return runAuthWrite(() => {
    const now = Date.now();
    let cache;
    const totalKey = `${LINE_LINK_CACHE_PREFIX}rate_all`;
    const userKey = lineUserCacheKey('rate', lineUserId);
    const failKey = lineUserCacheKey('fail', lineUserId);
    let total;
    let perUser;
    let failures;
    try {
      cache = CacheService.getScriptCache();
      total = readRecentTimestamps(cache, totalKey, now);
      perUser = readRecentTimestamps(cache, userKey, now);
      failures = readRecentTimestamps(cache, failKey, now);
    } catch (err) {
      // Without counters there is no rate limit: refuse (fail closed)
      console.warn(`LINE link rate limit unavailable; attempt refused: ${err}`);
      return {error: 'RateLimited'};
    }
    if (failures.length >= LINE_LINK_MAX_FAILURES || perUser.length >= LINE_LINK_MAX_PER_USER || total.length >= LINE_LINK_MAX_TOTAL) {
      console.warn('LINE link attempt ignored: rate limit');
      return {error: 'RateLimited'};
    }
    try {
      writeTimestamps(cache, totalKey, total.concat([now]));
      writeTimestamps(cache, userKey, perUser.concat([now]));
    } catch (err) {
      console.warn(`LINE link rate limit could not be recorded; attempt refused: ${err}`);
      return {error: 'RateLimited'};
    }

    const users = loadAuthUsers();
    if (users.error) return users;
    const links = loadAuthLineLinks();
    if (!links) return {error: 'AuthUnavailable'};
    const codeHash = sha256Hex(code);
    const rows = links.rows.filter(row =>
      links.text(row, 'codeHash') === codeHash && links.text(row, 'status') === 'pending' && isLinkActive(links, row, now));
    const owner = rows.length === 1 ? users.byId[links.text(rows[0], 'userId')] : null;
    if (!owner || owner.status !== 'active') {
      try {
        writeTimestamps(cache, failKey, failures.concat([now]));
      } catch (err) {
        console.warn(`LINE link failure could not be recorded: ${err}`);
      }
      console.log('LINE link attempt did not match a live code');
      return {error: 'LinkCodeInvalid'};
    }

    const row = rows[0];
    const linkId = links.text(row, 'linkId');
    try {
      cache.put(lineCandidateCacheKey(linkId), lineUserId, Math.ceil(LINE_LINK_CANDIDATE_TTL_MS / 1000));
    } catch (err) {
      console.warn(`LINE link candidate could not be stored: ${err}`);
      return {error: 'AuthError'};
    }
    links.set(row, 'status', 'candidate');
    links.set(row, 'candidateExpiresAt', new Date(now + LINE_LINK_CANDIDATE_TTL_MS).toISOString());
    console.log(`LINE link candidate held for ${owner.userId}; waiting for the user's confirmation`);
    return {success: true};
  });
}

// The LINE display name of a userId (profile API), or null. Logs only the
// HTTP status.
function fetchLineDisplayName(lineUserId) {
  const token = getScriptPropertyOrThrow('LINE_CHANNEL_ACCESS_TOKEN');
  let response;
  try {
    response = UrlFetchApp.fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
      method: 'get',
      headers: {Authorization: `Bearer ${token}`},
      muteHttpExceptions: true
    });
  } catch (err) {
    // The exception message may contain the request URL (= LINE userId): log a fixed message only
    console.warn('LINE profile API request failed');
    return null;
  }
  const status = response.getResponseCode();
  if (status !== 200) {
    console.warn(`LINE profile API returned ${status}`);
    return null;
  }
  try {
    const body = JSON.parse(response.getContentText());
    return typeof body.displayName === 'string' ? body.displayName : null;
  } catch (err) {
    console.warn('LINE profile API returned an unreadable body');
    return null;
  }
}

function authGetLineLinkCandidate(params) {
  const users = loadAuthUsers();
  if (users.error) return users;
  const links = loadAuthLineLinks();
  if (!links) return {error: 'AuthUnavailable'};
  const actor = requireAuthActor(params, users);
  if (actor.error) return actor;
  const now = Date.now();
  const row = findActiveLink(links, actor.user.userId, now);
  if (!row) return {success: true, status: 'none'};
  const source = links.text(row, 'source');
  if (links.text(row, 'status') === 'pending') {
    return {success: true, status: 'pending', source: source, expiresAt: links.text(row, 'expiresAt')};
  }
  const lineUserId = readLineCandidate(links.text(row, 'linkId'));
  if (!lineUserId) return {success: true, status: 'none'};
  const displayName = fetchLineDisplayName(lineUserId);
  if (displayName === null) return {error: 'ProfileUnavailable'};
  return {
    success: true,
    status: 'candidate',
    source: source,
    displayName: displayName,
    expiresAt: links.text(row, 'candidateExpiresAt')
  };
}

function authConfirmLineLink(params) {
  if (LINE_LINK_DECISIONS.indexOf(params.decision) === -1) return {error: 'Invalid input'};
  return runAuthWrite(() => {
    const users = loadAuthUsers();
    if (users.error) return users;
    const links = loadAuthLineLinks();
    if (!links) return {error: 'AuthUnavailable'};
    const actor = requireAuthActor(params, users);
    if (actor.error) return actor;
    const now = Date.now();
    const row = findActiveLink(links, actor.user.userId, now);
    if (!row || links.text(row, 'status') !== 'candidate') return {error: 'NoCandidate'};
    const linkId = links.text(row, 'linkId');
    const lineUserId = readLineCandidate(linkId);
    if (!lineUserId) return {error: 'NoCandidate'};
    // Re-check the destination: only a lineOptional source the actor owns
    const source = links.text(row, 'source');
    if (!isSourceId(source) || getLinkableSources(actor.user).indexOf(source) === -1) return {error: 'Forbidden'};

    const resolvedAt = new Date(now).toISOString();
    if (params.decision === 'cancel') {
      links.set(row, 'status', 'cancelled');
      links.set(row, 'resolvedAt', resolvedAt);
      dropLineCandidate(linkId);
      console.log(`LINE link cancelled by ${actor.user.userId}`);
      return {success: true, decision: 'cancel'};
    }

    PropertiesService.getScriptProperties().setProperty(getSourceConfig(source).lineKey, lineUserId);
    links.set(row, 'status', 'confirmed');
    links.set(row, 'resolvedAt', resolvedAt);
    dropLineCandidate(linkId);
    console.log(`LINE destination of ${source} set by ${actor.user.userId}`);
    try {
      pushLineTextMessage(lineUserId, `家計簿(${getSourceConfig(source).label})の LINE 連携が完了しました。月次レポートをこのトークへ送ります。`);
    } catch (err) {
      console.warn('LINE link confirmation message could not be sent');
    }
    return {success: true, decision: 'confirm'};
  });
}
