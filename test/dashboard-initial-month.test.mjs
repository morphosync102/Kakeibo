import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardSource = fs.readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');

test('dashboard initially scrolls to the current month card instead of the last month', () => {
  assert.match(dashboardSource, /const currentMonth = format\(new Date\(\), 'yyyy\/MM'\);/);
  assert.match(dashboardSource, /querySelector<HTMLElement>\(`\[data-month="\$\{currentMonth\}"\]`\)/);
  assert.match(dashboardSource, /currentMonthCard\?\.scrollIntoView\(\{ behavior: 'auto', block: 'nearest', inline: 'center' \}\)/);
  assert.doesNotMatch(dashboardSource, /container\.scrollLeft = container\.scrollWidth/);
});
