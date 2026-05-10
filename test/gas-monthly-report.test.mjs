import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadGasSandbox() {
  const source = fs.readFileSync(join(__dirname, '../public/GAS.txt'), 'utf8');
  const sandbox = {
    console,
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, removeAll: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (body) => ({ body, setMimeType: () => ({ body }) }),
    },
    GmailApp: {},
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => ({
          LINE_CHANNEL_ACCESS_TOKEN: 'token',
          LINE_DESTINATION_MAIN: 'main-group',
          LINE_DESTINATION_YAHOO: 'yahoo-user',
        })[key],
      }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: {},
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    Utilities: {
      formatDate: (date, _timezone, format) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        if (format === 'yyyy/MM') return `${year}/${month}`;
        if (format === 'yyyy/MM/dd') return `${year}/${month}/${day}`;
        if (format === 'MM/dd') return `${month}/${day}`;
        return `${year}-${month}-${day}`;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test('monthly report summarizes income, expenses, balance, categories, and top expenses', () => {
  const gas = loadGasSandbox();
  const rows = [
    [new Date(2026, 3, 1), 'Salary', 300000, '給与', 'm1', new Date(), 'Income'],
    ['2026/04/03', 'Rent', 100000, '住居', 'm2', new Date(), 'Expense'],
    ['2026/04/04', 'Grocery', 25000, '', 'm3', new Date(), 'Expense'],
    ['2026/04/05', 'Book', 3000, '教養', 'm4', new Date(), 'Expense'],
  ];
  const previousRows = [
    ['2026/03/01', 'Salary', 280000, '給与', 'p1', new Date(), 'Income'],
    ['2026/03/03', 'Rent', 100000, '住居', 'p2', new Date(), 'Expense'],
    ['2026/03/04', 'Grocery', 20000, '食費', 'p3', new Date(), 'Expense'],
  ];

  const text = gas.buildMonthlyKakeiboReportText('main', new Date(2026, 3, 1), rows, previousRows);

  assert.equal(text, [
    'たむたむ（先月の出費はこんな感じたま〜',
    '対象月: 2026/04',
    '',
    'サマリー (前月比)',
    '収入: ¥300,000 (+¥20,000)',
    '支出: ¥128,000 (+¥8,000)',
    '収支: ¥172,000 (+¥12,000)',
    '',
    'カテゴリ別支出 (前月比)',
    '住居: ¥100,000 (+¥0)',
    '未分類: ¥25,000 (+¥25,000)',
    '教養: ¥3,000 (+¥3,000)',
    '',
    '高額支出トップ5',
    '04/03 Rent [住居] ¥100,000',
    '04/04 Grocery [未分類] ¥25,000',
    '04/05 Book [教養] ¥3,000',
    '',
    'この調子でがんばるたま〜）',
  ].join('\n'));
  assert.doesNotMatch(text, /Salary \[給与\]/);
});

test('monthly report uses overspending closing when balance is negative', () => {
  const gas = loadGasSandbox();
  const rows = [
    ['2026/04/01', 'Salary', 100000, '給与', 'm1', new Date(), 'Income'],
    ['2026/04/03', 'Rent', 150000, '住居', 'm2', new Date(), 'Expense'],
  ];

  const text = gas.buildMonthlyKakeiboReportText('main', new Date(2026, 3, 1), rows, []);

  assert.match(text, /対象月: 2026\/04/);
  assert.match(text, /収支: -¥50,000 \(-¥50,000\)/);
  assert.match(text, /ちょっとお金使いすぎたまね〜）$/);
});

test('monthly report uses source-specific LINE destinations', () => {
  const gas = loadGasSandbox();

  assert.equal(gas.getMonthlyReportDestinationPropertyKey('main'), 'LINE_DESTINATION_MAIN');
  assert.equal(gas.getMonthlyReportDestinationPropertyKey('yahoo'), 'LINE_DESTINATION_YAHOO');
});

test('monthly report target month is the previous calendar month', () => {
  const gas = loadGasSandbox();
  const target = gas.getMonthlyReportTargetMonth(new Date(2026, 0, 10, 9, 0, 0));

  assert.equal(target.getFullYear(), 2025);
  assert.equal(target.getMonth(), 11);
  assert.equal(target.getDate(), 1);
});
