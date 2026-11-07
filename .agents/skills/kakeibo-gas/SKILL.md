---
name: kakeibo-gas
description: Use when changing or deploying the kakeibo Google Apps Script, spreadsheet schema, expense API actions, email imports, fixed costs, or monthly LINE reports.
---

# kakeibo GAS Automation

Use this skill when editing the kakeibo Google Apps Script stored in `gas/コード.js`.
Read `docs/SPECIFICATION.md` before changing an API action, sheet schema, cache behavior,
or deployment flow. That specification is the design source of truth.

## Required Workflow

1. Update `gas/コード.js`; never treat the deployed Apps Script editor as the only source.
2. Preserve source separation (`main` / `yahoo` / `yuki`). Resolve every per-source value through the
   `SOURCES` registry (`getTargetSheets` / `getSourceConfig`); never add an `if (source === 'yahoo') … else main`
   style fallback. An unknown or missing source must throw.
3. Add or update a `test/gas-*.test.mjs` regression test.
4. Clear the affected GAS cache after every successful write.
5. Run `npm test`, `npm run lint`, and `npm run build`.
6. Keep the GAS change backward compatible with the currently deployed UI (old UI + new GAS
   must work). Pushing to `main` (after the user approves the push) runs
   `.github/workflows/deploy.yml`: test → GAS deploy when `gas/` differs from the build the
   live Web App reports (`?action=version`) → verify the new build → Vercel deploy
   (no reviewer on the `production` environment: the push itself is the only approval gate). GAS and UI changes may go in the same push.
7. Keep the line `const GAS_BUILD = 'dev';` exactly as is: the workflow replaces it with the
   commit SHA before `clasp push`.

Manual fallback: `npm run gas:push` / `npm run gas:deploy` (requires `npx clasp login`
and a local `.clasp.json`; the script id is stored only in GitHub Secrets and local
`.clasp.json`, never in the repository). Rollback: `npx clasp deploy -V <previous version>
-i <deploymentId>` (see `docs/SPECIFICATION.md`).

## Sources

Registry: `SOURCES` in `gas/コード.js` (sheets, label, LINE destination property, `requiresActor`).

- `main`: 家庭用 kakeibo
- `yahoo`: 個人用 kakeibo
- `yuki`: Yuki 用 kakeibo. `requiresActor: true`: the Web App serves it only to a verified actor
  (`{ error: 'Forbidden' }` without one, whatever `AUTHZ_ENFORCE` says). Time-driven functions
  (fixed costs, monthly report) and `backfillRowIds` include it.

Adding a source: add a `SOURCES` entry and its own `CATEGORY_GROUPS` group, run `setupSourceSheets()` from the
editor (idempotent; creates only missing sheets with the headers below), and update `docs/SPECIFICATION.md`.

## Actor verification (doGet / doPost)

Order: `key` check → `normalizeSource` → `authorizeDataRequest(params, source)` → action. Nothing is read or
written before all three pass. The proxy sends `actorUserId` / `actorEpoch`; the actor is trusted only when
`PROXY_SECRET` is set (otherwise `Unauthorized`). Errors: `Invalid actor`, `Forbidden` (no actor where one is
required, or source not in the user's `sources`), `SessionRevoked` (unknown / not active / epoch mismatch),
`AuthUnavailable` (`Auth_Users` missing or unreadable: fail closed). `AUTHZ_ENFORCE=1` requires an actor on
every data request; while unset, requests without actor keep working for main / yahoo (current UI).

- The user table is read from `Auth_Users` (columns found by header name; a userId on several rows, valid or
  not, is ignored entirely) through the Script Cache with a generation token like the data lists
  (`kakeibo_auth_users_gen`, table `kakeibo_auth_users_v1_<gen>`, 10 min).
- Contract for every `Auth_Users` write (G3): write under the script lock, then call `clearAuthUsersCache()`
  before releasing it. It flushes, then rotates the generation (never throws; on rotation failure it removes
  the current table), so the next request sees the new epoch / status / sources immediately.
- `updateCategory` writes only `getCategoryUpdateSources(source, actor)` = the source's `CATEGORY_GROUPS`
  group ∩ the actor's sources (no actor: the whole group, i.e. main + yahoo as before), and clears only
  those sources' caches. Never add a write that crosses groups.
- New data actions must take the `actor` passed to `handleWriteAction` into account when they touch more
  than the requested source.

`normalizeSource` maps an absent / empty Web App `source` to `main` for old clients only (doGet/doPost);
internal functions (`getTargetSheets`, `getCacheSourceKey` / `clearCache`, `processFixedCostsForSource`,
`sendMonthlyKakeiboReportForSource`) require an exact registry id and throw otherwise.
`processFixedCosts` / `sendMonthlyKakeiboReports` loop over the registry with a try/catch per source and rethrow
the failed sources at the end. Fixed costs skip a source whose sheets do not exist before taking the lock.

## Spreadsheet

The spreadsheet ID is configured through the GAS Script Property `SHEET_ID`. Do not store the real ID in this skill; use `<SPREADSHEET_ID>` in documentation.

### main sheets

- `Data`
- `Config`
- `Fixed`

### yahoo sheets

- `Yahoo_Data`
- `Yahoo_Config`
- `Yahoo_Fixed`

### yuki sheets

- `Yuki_Data`
- `Yuki_Config`
- `Yuki_Fixed`

Created by `setupSourceSheets()` / `setupSourceSheets('yuki')` (Yuki_Data already has the H1 `RowId` header).

### Config / Yahoo_Config / Yuki_Config columns

- A: 支払い先
- B: 分類

### Fixed / Yahoo_Fixed / Yuki_Fixed columns

- A: Type
- B: Name
- C: Amount
- D: Day
- E: Category

### Data / Yahoo_Data / Yuki_Data columns

- A: Date
- B: Merchant
- C: Amount
- D: Category
- E: MessageId
- F: Timestamp
- G: Type
- H: RowId (UUID value, unique per row; assigned on every insert path; `backfillRowIds()` fills old rows).
  Only UUID-shaped values count as RowIds; anything else in H (e.g. a manual note) is ignored and the
  row is matched the legacy way.

RowId maintenance:

- After adding rows to Data / Yahoo_Data by hand, run `backfillRowIds()` again from the editor.
- When copying/pasting rows in the sheet, clear column H of the pasted rows first (a duplicated RowId makes
  the copies uneditable), then run `backfillRowIds()` again.
- If column H is already used for something else, `backfillRowIds()` aborts without writing to either
  sheet (the error names the sheet and the count only). Move the existing H contents to another column,
  then run it again.

For aggregation, treat `Type === "Income"` as income and all other rows as expenses. If `Category` is empty, use `未分類`.

MessageId is not guaranteed to be unique because one email can produce multiple transaction
rows. Single-row mutations (`updateTransactionDate`, `updateTransaction`, `deleteTransaction`)
therefore match date, merchant, and amount in addition to the id. `deleteTransaction` keeps a
legacy id-only first-match fallback for old clients; new callers must send the strict fields.
When the request also carries `rowId`, the row with that RowId is used only if the strict fields
match too (otherwise `Transaction not found`); an unknown rowId falls back to rows without a RowId.
Never insert columns before H: code depends on column numbers (G = Type).

## API Actions

- GET default: read transactions
- GET `getFixedCosts`: read fixed costs
- GET `version`: `{ build }` only (commit SHA stamped by the deploy workflow, `dev` otherwise); authenticated
- POST `addTransaction`
- POST `deleteTransaction` (strict match with date/merchant/amount; id-only falls back to legacy first match)
- POST `updateTransactionDate`
- POST `updateTransaction` (strict match; updates amount/merchant/category on one row)
- POST `updateCategory` (category group of the source ∩ the actor's sources; see Actor verification)
- POST `addFixedCost`
- POST `deleteFixedCost`

When adding or changing an action, update the caller, GAS implementation, tests, and
`docs/SPECIFICATION.md` together.

## Monthly LINE Reports

GAS sends previous-month reports for every registry source on a monthly Apps Script trigger:

- Trigger function: `sendMonthlyKakeiboReports`
- Schedule: every month on the 10th at 09:00
- Period: previous calendar month
- Manual test functions:
  - `testSendMonthlyKakeiboReports()`
  - `testSendMonthlyKakeiboReportMain()`
  - `testSendMonthlyKakeiboReportYahoo()`

Report content:

- Target month
- Income total and previous-month difference
- Expense total and previous-month difference
- Balance and previous-month difference
- Expense totals by category and category previous-month difference
- Top 5 high expense rows, expense only, sorted by amount descending

## Email Imports

`runEmailExtraction()` imports card notification emails into the spreadsheet:

- Rakuten card emails go to `Data`.
- Vpass / Olive emails go to `Yahoo_Data`.
- JCB shopping notification emails from `mail@qa.jcb.co.jp` go to `Yahoo_Data`.

JCB parser fields:

- `【ご利用日時(日本時間)】` -> Date
- `【ご利用金額】` -> Amount
- `【ご利用先】` -> Merchant

## LINE Messaging API

Use the LINE Messaging API Push endpoint:

- URL: `https://api.line.me/v2/bot/message/push`
- `main` destination: `LINE_DESTINATION_MAIN` groupId
- `yahoo` destination: `LINE_DESTINATION_YAHOO` userId
- `yuki` destination: `LINE_DESTINATION_YUKI` userId (optional; set by LINE linking, design G4)

An unset destination is a failure for `main` / `yahoo` (`Missing Script Property`; the other sources are
still sent, then the run throws naming the failed source). Only a `lineOptional` source (`yuki`) is skipped
with a warning while its property is unset. A report is never sent to another source's destination.

Script Properties required:

- `SHEET_ID`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DESTINATION_MAIN`
- `LINE_DESTINATION_YAHOO`
- `LINE_DESTINATION_YUKI` (optional until Yuki links LINE)
- `PROXY_SECRET` (optional during migration: shared secret checked as `key`; must equal Vercel `GAS_PROXY_SECRET`;
  required for any request carrying an actor)
- `AUTHZ_ENFORCE` (optional, not secret: `1` requires an actor on every data request)

Never store these values in the repository, project skills, tests, or documentation:

- Spreadsheet ID actual value
- LINE Channel Access Token
- LINE userId / groupId actual values
- Real transaction details
- App password
