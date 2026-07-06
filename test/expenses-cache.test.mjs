import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => fs.readFileSync(join(__dirname, '..', path), 'utf8');

const routeSource = read('app/api/expenses/route.ts');
const manageSource = read('components/ManageView.tsx');
const hookSource = read('hooks/useExpenses.ts');
const apiSource = read('lib/api.ts');

test('fixed costs are cached under their own tag instead of cache busting', () => {
  assert.match(routeSource, /'fixedCosts' : 'expenses'/);
  assert.match(routeSource, /revalidateTag\('fixedCosts', 'max'\)/);
  assert.match(routeSource, /revalidateTag\('expenses', 'max'\)/);
  assert.doesNotMatch(manageSource, /t=\$\{Date\.now\(\)\}/);
});

test('useExpenses exposes optimistic mutations and keeps cache on fetch failure', () => {
  assert.match(hookSource, /removeLocal/);
  assert.match(hookSource, /updateLocal/);
  assert.match(hookSource, /setError\('データの取得に失敗しました'\)/);
  // The catch path must not persist data (which would wipe the cache)
  assert.doesNotMatch(hookSource, /catch[^}]*localStorage\.setItem/s);
});

test('fetchExpenses surfaces failures instead of returning an empty list', () => {
  assert.match(apiSource, /throw new Error/);
  assert.doesNotMatch(apiSource, /return \[\]/);
});
