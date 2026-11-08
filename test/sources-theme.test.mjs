import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, SOURCE_IDS, getSource, isSourceId, sourceFromPathname, sourceHref } from '../lib/sources.ts';
import { ACCENT_CLASSES, pickMode } from '../lib/theme.ts';
import { isAllowedSource } from '../lib/expenses-proxy.ts';

// Source registry and per-source theme (design 2026-11-yuki-and-passkeys §2.2, §4, §11 U1).

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => fs.readFileSync(join(root, path), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadGasRegistry() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('gas/コード.js'), sandbox);
  return { ids: plain(vm.runInContext('SOURCE_IDS', sandbox)), sources: plain(vm.runInContext('SOURCES', sandbox)) };
}

// ---------------------------------------------------------------- registry

test('the UI registry lists the same sources, in the same order and with the same labels, as GAS SOURCES', () => {
  const gas = loadGasRegistry();
  assert.deepEqual([...SOURCE_IDS], gas.ids);
  for (const id of gas.ids) {
    assert.equal(SOURCES[id].id, id);
    assert.equal(SOURCES[id].label, gas.sources[id].label, `${id} label`);
  }
});

test('the proxy accepts exactly the registry ids (plus an omitted source for old clients)', () => {
  for (const id of SOURCE_IDS) assert.equal(isAllowedSource(id), true, id);
  assert.equal(isAllowedSource(undefined), true);
  assert.equal(isAllowedSource(null), true);
  for (const bad of ['', 'Yuki', 'YAHOO', 'other', 'constructor', 'toString', 1, {}, []]) assert.equal(isAllowedSource(bad), false, JSON.stringify(bad));
});

test('isSourceId accepts only own registry ids', () => {
  for (const id of SOURCE_IDS) assert.equal(isSourceId(id), true);
  for (const bad of [undefined, null, '', 'Yuki', 'constructor', '__proto__', 'hasOwnProperty', ['yuki'], 1]) assert.equal(isSourceId(bad), false, String(bad));
  assert.throws(() => getSource('other'), /Unknown source/);
  assert.throws(() => getSource(undefined), /Unknown source/);
});

test('routes: the first path segment picks the source; tabs map to that source\'s routes', () => {
  const cases = [
    ['/', 'main'], ['/statistics', 'main'], ['/calendar', 'main'], ['/manage', 'main'],
    ['/yahoo', 'yahoo'], ['/yahoo/statistics', 'yahoo'], ['/yahoo/calendar', 'yahoo'], ['/yahoo/manage', 'yahoo'],
    ['/yuki', 'yuki'], ['/yuki/statistics', 'yuki'], ['/yuki/calendar', 'yuki'], ['/yuki/manage', 'yuki'],
    ['/yukiX', 'main'], ['/yahoo-manifest.json', 'main'],
  ];
  for (const [path, source] of cases) assert.equal(sourceFromPathname(path), source, path);
  const tabs = { home: '', statistics: '/statistics', calendar: '/calendar', manage: '/manage' };
  for (const [tab, suffix] of Object.entries(tabs)) {
    assert.equal(sourceHref('main', tab), suffix || '/');
    assert.equal(sourceHref('yahoo', tab), `/yahoo${suffix}`);
    assert.equal(sourceHref('yuki', tab), `/yuki${suffix}`);
  }
});

test('themes: main light + indigo, yahoo dark + indigo (unchanged), yuki light + pink', () => {
  assert.deepEqual(plain(SOURCES.main.theme), { dark: false, accent: 'indigo', background: '#ffffff', themeColor: '#ffffff' });
  assert.deepEqual(plain(SOURCES.yahoo.theme), { dark: true, accent: 'indigo', background: '#020617', themeColor: '#020617' });
  assert.deepEqual(plain(SOURCES.yuki.theme), { dark: false, accent: 'pink', background: '#fdf2f8', themeColor: '#fdf2f8' });
  assert.equal(SOURCES.main.dashboardTitle, 'My kakeibo');
  assert.equal(SOURCES.yahoo.dashboardTitle, '個人kakeibo');
  assert.equal(SOURCES.main.manageTitle, '管理・入力');
  assert.equal(SOURCES.yahoo.manageTitle, '個人kakeibo管理');
  assert.throws(() => { SOURCES.yuki.theme.accent = 'indigo'; }, TypeError, 'frozen');
});

// ---------------------------------------------------------------- accent class table

// The indigo table must hold exactly the classes the views used before, so
// main and yahoo render the same as before the registry.
const INDIGO = {
  navActive: { light: 'text-indigo-600', dark: 'text-indigo-400' },
  navBar: { light: 'bg-white border-gray-200', dark: 'bg-slate-900 border-slate-800' },
  segmentActive: 'bg-indigo-600 text-white',
  monthCardRing: { light: 'ring-indigo-300', dark: 'ring-indigo-900' },
  monthCardCurrent: { light: 'bg-gradient-to-br from-indigo-600 to-indigo-800', dark: 'bg-gradient-to-br from-indigo-900 to-indigo-950' },
  dotActive: 'bg-indigo-500',
  categorySelected: { light: 'bg-indigo-50 border-indigo-500 ring-1 ring-indigo-500', dark: 'bg-indigo-900/30 border-indigo-500 ring-1 ring-indigo-500' },
  linkText: 'text-indigo-500',
  balancePositive: { light: 'text-indigo-600', dark: 'text-indigo-400' },
  selectedDayBorder: 'border-indigo-500',
  todayText: 'text-indigo-500',
  todayDot: 'bg-indigo-500',
  tabActive: 'bg-indigo-50 text-indigo-600',
  icon: 'text-indigo-500',
  focusRing: 'focus:ring-indigo-100',
  primaryButton: 'bg-indigo-600 hover:bg-indigo-700 text-white',
  solidButton: 'bg-indigo-600',
  expenseBar: 'bg-indigo-400',
  addButtonHover: { light: 'hover:border-indigo-200 hover:text-indigo-400', dark: 'hover:text-indigo-400 hover:border-indigo-900' },
  panelBorder: { light: 'border-indigo-100', dark: 'border-indigo-900' },
  pageBg: { light: 'bg-gray-50', dark: 'bg-slate-950' },
  calendarPageBg: { light: 'bg-white', dark: 'bg-slate-950' },
  card: { light: 'bg-white border-gray-100', dark: 'bg-slate-900 border-slate-800' },
  statsCard: { light: 'bg-white border-gray-200', dark: 'bg-slate-900 border-slate-800' },
};

test('the indigo table holds exactly the previous main / yahoo classes', () => {
  assert.deepEqual(plain(ACCENT_CLASSES.indigo), INDIGO);
});

test('the pink table has the same tokens, only full static class names, no indigo, and the same dark surfaces', () => {
  const pink = plain(ACCENT_CLASSES.pink);
  assert.deepEqual(Object.keys(pink).sort(), Object.keys(INDIGO).sort());
  for (const [token, value] of Object.entries(pink)) {
    assert.equal(typeof value, typeof INDIGO[token], token);
    const values = typeof value === 'string' ? [value] : [value.light, value.dark];
    if (typeof value !== 'string') assert.deepEqual(Object.keys(value).sort(), ['dark', 'light'], token);
    for (const classes of values) {
      assert.ok(!/indigo/.test(classes), `${token}: ${classes}`);
      // Tailwind detects class names statically: whole literal names only
      for (const name of classes.split(' ')) assert.match(name, /^[a-z0-9:/.-]+$/, `${token}: ${name}`);
    }
  }
  for (const token of ['navBar', 'pageBg', 'calendarPageBg', 'card', 'statsCard']) {
    assert.equal(pink[token].dark, INDIGO[token].dark, `${token} dark surface`);
    assert.match(pink[token].light, /pink|bg-white/, `${token} light surface is pinkish`);
  }
  assert.equal(pink.pageBg.light, 'bg-pink-50');
  assert.equal(pickMode({ light: 'a', dark: 'b' }, false), 'a');
  assert.equal(pickMode({ light: 'a', dark: 'b' }, true), 'b');
  for (const id of SOURCE_IDS) assert.ok(ACCENT_CLASSES[SOURCES[id].theme.accent], id);
});

test('lib/theme.ts is a file Tailwind scans (no dynamic class construction)', () => {
  const source = read('lib/theme.ts');
  assert.ok(!source.includes('${'), 'no template literals building class names');
  assert.ok(!/['"`](bg|text|border|ring)-['"`]\s*\+/.test(source), 'no string concatenation of class names');
});

// ---------------------------------------------------------------- views and pages

const VIEWS = ['components/BottomNav.tsx', 'components/Dashboard.tsx', 'components/CalendarView.tsx', 'components/ManageView.tsx', 'components/StatisticsView.tsx', 'components/ExpenseDetailModal.tsx'];

test('views take colors from the accent table and source facts from the registry', () => {
  for (const path of VIEWS) {
    const code = read(path);
    assert.ok(!/indigo-/.test(code), `${path}: no hard-coded indigo`);
    assert.ok(!/isYahoo/.test(code), `${path}: no yahoo special case`);
    assert.ok(!/source === ['"]yahoo['"]/.test(code), `${path}: no yahoo comparison`);
    assert.ok(!/source\?:/.test(code), `${path}: source is required`);
    assert.ok(!/source = ['"]main['"]/.test(code), `${path}: no default main`);
    assert.ok(!/searchParams\.get\(['"]source['"]\)/.test(code), `${path}: source is not taken from the query`);
  }
  for (const path of ['components/Dashboard.tsx', 'components/CalendarView.tsx', 'components/ManageView.tsx', 'components/StatisticsView.tsx']) {
    const code = read(path);
    assert.match(code, /getSource\(source\)/, `${path}: theme from the registry`);
    assert.ok(!/isDarkMode = false/.test(code), `${path}: dark mode follows the source`);
  }
  assert.match(read('components/BottomNav.tsx'), /sourceFromPathname\(pathname\)/);
  assert.match(read('components/Dashboard.tsx'), /dashboardTitle/);
  assert.match(read('components/ManageView.tsx'), /manageTitle/);
});

test('hooks and API helpers require a source (no fallback to main)', () => {
  assert.match(read('hooks/useExpenses.ts'), /export function useExpenses\(source: SourceId\)/);
  assert.match(read('lib/api.ts'), /export async function fetchExpenses\(source: SourceId,/);
  assert.match(read('components/ManageView.tsx'), /params\.set\('source', source\)/);
  assert.ok(!/if \(source\) params\.set/.test(read('components/ManageView.tsx')));
});

test('fetchExpenses always sends the source, main included', async (t) => {
  const { fetchExpenses } = await import('../lib/api.ts');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return Response.json([]); });
  await fetchExpenses('main');
  await fetchExpenses('yuki', { fresh: true });
  assert.deepEqual(urls, ['/api/expenses?source=main', '/api/expenses?source=yuki&fresh=1']);
});

const PAGES = [
  ['app/page.tsx', 'Dashboard', 'main'], ['app/statistics/page.tsx', 'StatisticsView', 'main'],
  ['app/calendar/page.tsx', 'CalendarView', 'main'], ['app/manage/page.tsx', 'ManageView', 'main'],
  ['app/yahoo/page.tsx', 'Dashboard', 'yahoo'], ['app/yahoo/statistics/page.tsx', 'StatisticsView', 'yahoo'],
  ['app/yahoo/calendar/page.tsx', 'CalendarView', 'yahoo'], ['app/yahoo/manage/page.tsx', 'ManageView', 'yahoo'],
  ['app/yuki/page.tsx', 'Dashboard', 'yuki'], ['app/yuki/statistics/page.tsx', 'StatisticsView', 'yuki'],
  ['app/yuki/calendar/page.tsx', 'CalendarView', 'yuki'], ['app/yuki/manage/page.tsx', 'ManageView', 'yuki'],
];

test('every page passes its source explicitly (and no separate dark-mode flag)', () => {
  for (const [path, view, source] of PAGES) {
    const code = read(path);
    assert.match(code, new RegExp(`<${view} source="${source}"`), path);
    assert.ok(!/isDarkMode/.test(code), `${path}: no isDarkMode prop`);
  }
});

test('the yuki layout and PWA manifest use the light pink theme, start at /yuki and keep scope /', () => {
  const layout = read('app/yuki/layout.tsx');
  assert.match(layout, /manifest: ['"]\/yuki-manifest\.json['"]/);
  assert.match(layout, /themeColor: SOURCES\.yuki\.theme\.themeColor/);
  assert.match(layout, /<BodyBackgroundSetter color=\{SOURCES\.yuki\.theme\.background\} \/>/);
  assert.match(layout, /statusBarStyle: ['"]default['"]/);
  const manifest = JSON.parse(read('public/yuki-manifest.json'));
  assert.equal(manifest.start_url, '/yuki');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, SOURCES.yuki.theme.themeColor);
  assert.equal(manifest.background_color, SOURCES.yuki.theme.background);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(join(root, 'public', icon.src)), icon.src);
});

test('the /yuki pages are protected by the login middleware (everything but public paths; see access.test.mjs)', () => {
  assert.match(read('middleware.ts'), /decideAccess\(/);
});
