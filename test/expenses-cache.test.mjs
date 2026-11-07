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
  // Writes must expire immediately: 'max' is stale-while-revalidate and would
  // serve pre-write data to the refetch that follows every edit.
  assert.match(routeSource, /revalidateTag\('fixedCosts', \{ expire: 0 \}\)/);
  assert.match(routeSource, /revalidateTag\('expenses', \{ expire: 0 \}\)/);
  assert.doesNotMatch(routeSource, /revalidateTag\([^)]*'max'\)/);
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

test('fetch results are gated by local edits and pending writes', () => {
  // Otherwise a slow background fetch (or one returning before a queued write
  // lands) would roll back an optimistic edit
  assert.match(hookSource, /mutationVersion/);
  assert.match(hookSource, /shouldApplyFetch\(\{/);
  assert.match(hookSource, /pendingWrites: getPendingWrites\(\)/);
  // A discarded result is retried once the queue drains, so the screen converges
  assert.match(hookSource, /subscribePendingWrites\(/);
  assert.match(hookSource, /reloadAfterWrites\.current = true/);
});

test('refetches after writes and manual refreshes bypass the server cache; startup uses it', () => {
  // refresh() is the write-completion callback (onUpdate) and the manual button
  assert.match(hookSource, /const refresh = useCallback\(\(\) => runLoad\(true\)/);
  assert.match(hookSource, /if \(next === 'reload-now'\) return load\(true\)/);
  assert.match(hookSource, /load\(true\)\.catch/, 'the drain reload is fresh');
  assert.match(hookSource, /runLoad\(false\)/, 'startup without local cache uses the server cache');
  assert.match(hookSource, /load\(false\)\.catch/, 'startup background fetch uses the server cache');
});
