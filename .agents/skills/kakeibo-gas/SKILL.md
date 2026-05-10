---
name: kakeibo-gas
description: Project-specific guidance for the kakeibo Google Apps Script automation, spreadsheet schema, and monthly LINE reports.
---

# kakeibo GAS Automation

Use this skill when editing the kakeibo Google Apps Script stored in `public/GAS.txt`.

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
