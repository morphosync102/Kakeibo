/**
 * Kakeibo Automation - Universal Ver 2.2 (Multi-Source Support + Caching)
 * Supports: Main & Yahoo (Olive) Sheets
 */

const SHEET_ID = PropertiesService.getScriptProperties().getProperty('SHEET_ID');

// Default Sheets
const DATA_SHEET_NAME = 'Data';
const CONFIG_SHEET_NAME = 'Config';
const FIXED_SHEET_NAME = 'Fixed';

// Yahoo (Olive) Sheets
const YAHOO_DATA_SHEET_NAME = 'Yahoo_Data';
const YAHOO_CONFIG_SHEET_NAME = 'Yahoo_Config';
const YAHOO_FIXED_SHEET_NAME = 'Yahoo_Fixed';

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
// Accepted: absent (undefined / null / '') or 'main' -> 'main', 'yahoo' -> 'yahoo'.
// Anything else returns null and must be rejected with {error: 'Invalid source'}
// so a typo can never write personal data into the household sheets.
function normalizeSource(source) {
  if (source === undefined || source === null || source === '' || source === 'main') return 'main';
  if (source === 'yahoo') return 'yahoo';
  return null;
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
function getTargetSheets(source) {
  if (source === 'yahoo') {
    return {
      data: YAHOO_DATA_SHEET_NAME,
      config: YAHOO_CONFIG_SHEET_NAME,
      fixed: YAHOO_FIXED_SHEET_NAME
    };
  }
  return {
    data: DATA_SHEET_NAME,
    config: CONFIG_SHEET_NAME,
    fixed: FIXED_SHEET_NAME
  };
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

// Callers pass an already-validated source; undefined / '' / 'main' share a key.
function getCacheSourceKey(source) {
  return `kakeibo_${normalizeSource(source) || 'main'}`;
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
// generation. Called after a successful write, so it never throws: reporting
// an error for a write that already landed would make the UI resend it.
// 1. flush: commit pending sheet writes first, otherwise a doGet could pick up
//    the new generation, read the pre-write sheet and cache the stale list.
// 2. rotate the generation (invalidates everything cached under the old one).
// 3. remove the old generation's chunks and the legacy key. This is
//    housekeeping when rotation worked, and the fallback when it failed.
// Returns true when the generation was rotated.
function clearCache(source) {
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
  const source = normalizeSource(e.parameter.source); // 'main' | 'yahoo' | null
  if (!source) return responseJSON({error: 'Invalid source'});

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

    const source = normalizeSource(params.source); // 'main' | 'yahoo' | null
    if (!source) return responseJSON({error: 'Invalid source'});

    if (WRITE_ACTIONS.indexOf(params.action) === -1) {
      return responseJSON({error: 'Unknown action'});
    }

    // Rows are (re)read and matched inside the lock, so a concurrent write
    // cannot shift row numbers between the read and the write.
    const result = runWithScriptLock(
      () => handleWriteAction(params, source),
      () => ({error: 'Busy'})
    );
    return responseJSON(result);

  } catch (err) {
    return responseJSON({error: err.toString()});
  }
}

// Must be called while holding the script lock. Returns the response object.
function handleWriteAction(params, source) {
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
      // Update BOTH Main and Yahoo sheets
      ['main', 'yahoo'].forEach(src => {
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

      // Clear cache for ALL sources since category update affects all
      clearCache('main');
      clearCache('yahoo');
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
function processFixedCosts() {
  processFixedCostsForSource(); // Default
  processFixedCostsForSource('yahoo'); // Yahoo
}

function processFixedCostsForSource(source) {
  console.log(`--- Checking Fixed Costs for: ${source || 'default'} ---`);
  // Only rows whose day equals today are added, so a run that cannot get the
  // lock is NOT retried by tomorrow's trigger: wait longer and log loudly.
  runWithScriptLock(
    () => addDueFixedCosts(source),
    () => console.warn(`Fixed costs for ${source || 'main'} were NOT added today: lock busy for ${FIXED_COST_LOCK_WAIT_MS / 1000}s. Tomorrow's trigger does not catch up (not retried); run processFixedCosts() again today or add them manually.`),
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
       const uniqueId = `fixed_${currentMonthStr.replace('/', '')}_${row[1]}_${source || 'main'}`;

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
// Fills column H for every Data / Yahoo_Data row that has no RowId yet, writes
// the header when H1 is empty, and never changes an existing value, so running
// it again is harmless (rerun it after adding rows to the sheet by hand).
// Both sheets are inspected first: if column H is already used for something
// else (H1 neither empty nor "RowId", or non-UUID values below it) it aborts
// with an error naming the sheet and count, and writes nothing to either sheet.
// Otherwise each sheet is written with one setValues call under the script
// lock and that source's cache is invalidated. Returns the counts per source.
function backfillRowIds() {
  return runWithScriptLock(() => {
    const plans = ['main', 'yahoo'].map(planRowIdBackfill);
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

function sendMonthlyKakeiboReports() {
  sendMonthlyKakeiboReportForSource('main');
  sendMonthlyKakeiboReportForSource('yahoo');
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

function sendMonthlyKakeiboReportForSource(source, now) {
  const targetMonth = getMonthlyReportTargetMonth(now || new Date());
  const previousMonth = getPreviousMonthlyReportMonth(targetMonth);
  const rows = getMonthlyReportRows(source, targetMonth);
  const previousRows = getMonthlyReportRows(source, previousMonth);
  const text = buildMonthlyKakeiboReportText(source, targetMonth, rows, previousRows);
  const destinationKey = getMonthlyReportDestinationPropertyKey(source);
  const destination = getScriptPropertyOrThrow(destinationKey);

  pushLineTextMessage(destination, text);

  return {
    source: source || 'main',
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

function getMonthlyReportDestinationPropertyKey(source) {
  return source === 'yahoo' ? 'LINE_DESTINATION_YAHOO' : 'LINE_DESTINATION_MAIN';
}

function getMonthlyReportSourceLabel(source) {
  return source === 'yahoo' ? '個人用' : '家庭用';
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
