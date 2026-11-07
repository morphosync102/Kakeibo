#!/usr/bin/env node
// Prints the build id (commit SHA) the deployed GAS Web App reports via
// `doGet ?action=version`, or nothing when it is unknown (old GAS without the
// action, a 'dev' build, an error). Used by .github/workflows/deploy.yml to
// decide whether gas/ must be deployed and to verify a deployment.
//
// Env: GAS_API_URL (Web App /exec URL), GAS_PROXY_SECRET (optional key).
// Never prints the response body (an old GAS answers this request with the
// full expense list) nor the key. Only a GAS `error` string goes to stderr.

const SHA = /^[0-9a-f]{40}$/;

async function main() {
  const base = process.env.GAS_API_URL;
  if (!base) {
    console.error('gas-build: GAS_API_URL is not set');
    return '';
  }
  const url = new URL(base);
  url.searchParams.set('action', 'version');
  if (process.env.GAS_PROXY_SECRET) url.searchParams.set('key', process.env.GAS_PROXY_SECRET);

  let data;
  try {
    // Apps Script answers with a redirect to googleusercontent.com; fetch follows it
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.error(`gas-build: HTTP ${res.status}`);
      return '';
    }
    data = await res.json();
  } catch (error) {
    console.error(`gas-build: request failed (${error instanceof Error ? error.name : 'error'})`);
    return '';
  }

  if (data && !Array.isArray(data) && typeof data === 'object') {
    if (typeof data.error === 'string') {
      console.error(`gas-build: GAS error: ${data.error.slice(0, 100)}`);
      return '';
    }
    if (typeof data.build === 'string' && SHA.test(data.build)) return data.build;
  }
  console.error('gas-build: no build id in the response');
  return '';
}

process.stdout.write(await main());
