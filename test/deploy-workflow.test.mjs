import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structure checks for the single deploy pipeline. No YAML dependency: the
// workflow is split into blocks by indentation, which is enough for these rules.
// (actionlint is used separately for full validation when available.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(__dirname, '../.github/workflows');
const source = fs.readFileSync(join(workflowsDir, 'deploy.yml'), 'utf8');

// Lines of the block that starts at `header` (exact line) until the next line
// with indentation <= the header's.
function block(text, header) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line === header);
  assert.notEqual(start, -1, `missing ${JSON.stringify(header)}`);
  const indent = header.length - header.trimStart().length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}
const job = (name) => block(source, `  ${name}:`);

test('one workflow replaces the GAS-only one', () => {
  assert.deepEqual(fs.readdirSync(workflowsDir).sort(), ['deploy.yml']);
});

test('runs on push to main and manually, one run at a time without cancelling a deploy', () => {
  const on = block(source, 'on:');
  assert.match(on, /push:\n\s+branches: \[main\]/);
  assert.match(on, /workflow_dispatch:/);
  const concurrency = block(source, 'concurrency:');
  assert.match(concurrency, /group: \S+/);
  assert.match(concurrency, /cancel-in-progress: false/);
  assert.match(block(source, 'permissions:'), /contents: read/);
});

test('job order: test -> gas -> vercel (production environment)', () => {
  const jobs = block(source, 'jobs:');
  const names = [...jobs.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map(m => m[1]);
  assert.deepEqual(names, ['test', 'gas', 'vercel']);
  assert.doesNotMatch(job('test'), /needs:/);
  assert.match(job('gas'), /needs: test/);
  const vercel = job('vercel');
  assert.match(vercel, /needs: \[test, gas\]/);
  assert.match(vercel, /needs\.test\.result == 'success'/);
  assert.match(vercel, /needs\.gas\.result == 'success' \|\| needs\.gas\.result == 'skipped'/);
  assert.match(vercel, /environment: production/);
  assert.doesNotMatch(job('gas'), /environment:/, 'GAS deploys before the approval gate');
});

test('test job runs install, tests, lint and build in order on Node 24', () => {
  const steps = job('test');
  const order = ['npm ci', 'npm test', 'npm run lint', 'npm run build'].map(cmd => steps.indexOf(`run: ${cmd}`));
  assert.ok(order.every(i => i !== -1), `missing step: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(source, /node-version: 24/);
  assert.doesNotMatch(source, /node-version: (?!24)/);
});

test('every external action is pinned to a full commit SHA', () => {
  const uses = [...source.matchAll(/uses: (\S+)/g)].map(m => m[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
});

test('gas job deploys only when gas/ changed since the build GAS reports, then verifies the new build', () => {
  const gas = job('gas');
  assert.match(gas, /fetch-depth: 0/, 'needs history to diff against the deployed build');
  assert.match(gas, /deployed=\$\(node scripts\/gas-build\.mjs\)/);
  assert.match(gas, /git diff --quiet "\$deployed" "\$GITHUB_SHA" -- gas\//);
  assert.match(gas, /merge-base --is-ancestor/);
  // deploy steps are conditional on the detection output
  const conditional = [...gas.matchAll(/- name: ([^\n]+)\n\s+if: steps\.changes\.outputs\.deploy == 'true'/g)].map(m => m[1]);
  for (const step of ['Stamp build id', 'Push source to Apps Script', 'Deploy new version', 'Verify deployed build']) {
    assert.ok(conditional.some(name => name.startsWith(step)), `${step} must be conditional`);
  }
  assert.match(gas, /sed -i "s\/\^const GAS_BUILD = 'dev';\$\/const GAS_BUILD = '\$GITHUB_SHA';\/"/);
  assert.match(gas, /grep -c "\^const GAS_BUILD = '\$GITHUB_SHA';\$"/);
  assert.match(gas, /npx clasp push -f/);
  assert.match(gas, /npx clasp deploy -i "\$GAS_DEPLOYMENT_ID"/);
  assert.match(gas, /build=\$\(node scripts\/gas-build\.mjs\)/);
  assert.match(gas, /\[ "\$build" = "\$GITHUB_SHA" \]/);
  const order = ['Stamp build id', 'Push source to Apps Script', 'Deploy new version', 'Verify deployed build'].map(n => gas.indexOf(`- name: ${n}`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('vercel job builds and deploys the prebuilt output with a pinned CLI', () => {
  const vercel = job('vercel');
  const cli = [...vercel.matchAll(/npx --yes (vercel@\S+)/g)].map(m => m[1]);
  assert.equal(cli.length, 3);
  for (const pkg of cli) assert.match(pkg, /^vercel@\d+\.\d+\.\d+$/);
  assert.equal(new Set(cli).size, 1, 'one CLI version');
  const order = ['pull --yes --environment=production', 'build --prod', 'deploy --prebuilt --prod'].map(c => vercel.indexOf(c));
  assert.ok(order.every(i => i !== -1));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(vercel, /VERCEL_ORG_ID: \$\{\{ secrets\.VERCEL_ORG_ID \}\}/);
  assert.match(vercel, /VERCEL_PROJECT_ID: \$\{\{ secrets\.VERCEL_PROJECT_ID \}\}/);
});

test('secrets reach scripts only through env, never interpolated into run lines', () => {
  // Collect script text: single-line `run: cmd` and the body of `run: |` blocks
  const lines = source.split('\n');
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)run: (.*)$/);
    if (!match) continue;
    if (match[2] !== '|') { scripts.push(match[2]); continue; }
    const indent = match[1].length;
    for (i += 1; i < lines.length && (lines[i].trim() === '' || lines[i].length - lines[i].trimStart().length > indent); i++) scripts.push(lines[i]);
    i -= 1;
  }
  assert.ok(scripts.length > 10);
  for (const line of scripts) assert.doesNotMatch(line, /\$\{\{/, `no expressions inside scripts: ${line.trim()}`);
  for (const name of ['CLASPRC_JSON', 'GAS_SCRIPT_ID', 'GAS_DEPLOYMENT_ID', 'GAS_API_URL', 'GAS_PROXY_SECRET', 'VERCEL_TOKEN']) {
    assert.match(source, new RegExp(`\\$\\{\\{ secrets\\.${name} \\}\\}`), name);
  }
});

// ---------------------------------------------------------------- scripts/gas-build.mjs

import http from 'node:http';
import { execFile } from 'node:child_process';

const SHA = 'a'.repeat(40);
const DUMMY_KEY = 'dummy-key-for-tests';

function serve(handler) {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => { requests.push(req.url); handler(req, res); });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/exec` }));
  });
}
function run(env) {
  return new Promise(resolve => {
    execFile(process.execPath, [join(__dirname, '../scripts/gas-build.mjs')], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}
const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('gas-build prints the deployed build SHA, following the Apps Script redirect and sending the key', async () => {
  const { server, requests, url } = await serve((req, res) => {
    if (req.url.startsWith('/exec')) { res.writeHead(302, { Location: '/echo' + req.url.slice(5) }); res.end(); return; }
    json(res, { build: SHA });
  });
  try {
    const out = await run({ GAS_API_URL: url, GAS_PROXY_SECRET: DUMMY_KEY });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, SHA);
    const query = new URL(requests[0], 'http://x').searchParams;
    assert.equal(query.get('action'), 'version');
    assert.equal(query.get('key'), DUMMY_KEY);
    assert.ok(!out.stderr.includes(DUMMY_KEY));

    const noKey = await run({ GAS_API_URL: url });
    assert.equal(noKey.stdout, SHA);
    assert.equal(new URL(requests.at(-2), 'http://x').searchParams.get('key'), null, 'no key without a secret');
  } finally { server.close(); }
});

test('gas-build prints nothing for unknown builds and never echoes the response body', async () => {
  for (const body of [{ build: 'dev' }, { error: 'Unauthorized' }, [{ merchant: 'synthetic-private-row' }], 'not json']) {
    const { server, url } = await serve((req, res) => (typeof body === 'string' ? res.end(body) : json(res, body)));
    try {
      const out = await run({ GAS_API_URL: url, GAS_PROXY_SECRET: DUMMY_KEY });
      assert.equal(out.stdout, '', JSON.stringify(body));
      assert.ok(!out.stderr.includes('synthetic-private-row'), 'response bodies are never printed');
      assert.ok(!out.stderr.includes(DUMMY_KEY));
      if (body.error) assert.match(out.stderr, /Unauthorized/, 'a GAS error string is reported');
    } finally { server.close(); }
  }
  const missing = await run({});
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /GAS_API_URL/);
});
