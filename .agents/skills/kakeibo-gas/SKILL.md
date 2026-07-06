---
name: kakeibo-gas
description: Use when changing or deploying the kakeibo Google Apps Script, spreadsheet schema, expense API actions, email imports, fixed costs, or monthly LINE reports.
---

# kakeibo GAS Automation

Use this skill when editing the kakeibo Google Apps Script stored in `public/GAS.txt`.
Read `docs/SPECIFICATION.md` before changing an API action, sheet schema, cache behavior,
or deployment flow. That specification is the design source of truth.

## Required Workflow

1. Update `public/GAS.txt`; never treat the deployed Apps Script editor as the only source.
2. Preserve `main` and `yahoo` source separation.
3. Add or update a `test/gas-*.test.mjs` regression test.
4. Clear the affected GAS cache after every successful write.
5. Run `npm test`, `npm run lint`, and `npm run build`.
6. Deploy the new Apps Script version before deploying a Web UI that calls a new action.

Apps Script deployment and Vercel deployment are separate operations.

## Sources

- `main`: 家庭用 kakeibo
- `yahoo`: 個人用 kakeibo

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

### Config / Yahoo_Config columns

- A: 支払い先
- B: 分類

### Fixed / Yahoo_Fixed columns

- A: Type
- B: Name
- C: Amount
- D: Day
- E: Category

### Data / Yahoo_Data columns

- A: Date
- B: Merchant
- C: Amount
- D: Category
- E: MessageId
- F: Timestamp
- G: Type

For aggregation, treat `Type === "Income"` as income and all other rows as expenses. If `Category` is empty, use `未分類`.

MessageId is not guaranteed to be unique because one email can produce multiple transaction
rows. For new or changed single-row mutations, match the additional fields required by the API
contract in `docs/SPECIFICATION.md`. Existing `deleteTransaction` is a documented limitation;
when changing it, migrate the caller and GAS implementation to strict matching together.

## API Actions

- GET default: read transactions
- GET `getFixedCosts`: read fixed costs
- POST `addTransaction`
- POST `deleteTransaction`
- POST `updateTransactionDate`
- POST `updateCategory`
- POST `addFixedCost`
- POST `deleteFixedCost`

When adding or changing an action, update the caller, GAS implementation, tests, and
`docs/SPECIFICATION.md` together.

## Monthly LINE Reports

GAS sends previous-month reports for both sources on a monthly Apps Script trigger:

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

Script Properties required:

- `SHEET_ID`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DESTINATION_MAIN`
- `LINE_DESTINATION_YAHOO`

Never store these values in the repository, project skills, tests, or documentation:

- Spreadsheet ID actual value
- LINE Channel Access Token
- LINE userId / groupId actual values
- Real transaction details
- App password
