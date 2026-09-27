// Run Google Trends Scraper & Breakout Monitor on Apify and keep every result row.
// Node.js 18+, no dependencies.
//
//   node node/run.mjs examples/quick-start.json              preview, free
//   node node/run.mjs examples/quick-start.json --execute    one paid run, capped at $0.05
//   node node/run.mjs --resume RUN_ID                        read an existing run
//
// The token comes from APIFY_TOKEN. With Node 20.6+ you can use: node --env-file=.env node/run.mjs ...

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { splitRows } from './events.mjs';

const API = 'https://api.apify.com/v2';
const ACTOR = 'automa-flow~google-trends-monitor';
const ACTOR_ID = 'WecREidW3gHipWFzP';
const MAX_CHARGE_USD = 0.05;
const TIMEOUT_SECS = 300;
const MEMORY_MB = 512;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const args = process.argv.slice(2);
const resumeAt = args.indexOf('--resume');
const resumeId = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
const execute = args.includes('--execute');
const inputPath = args.find(a => !a.startsWith('--') && a !== resumeId) ?? 'examples/quick-start.json';
if (resumeAt >= 0 && !/^[A-Za-z0-9]+$/.test(resumeId ?? '')) throw new Error('--resume expects an Apify run ID');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(method, urlPath, { body, attempts = 4 } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('Set APIFY_TOKEN first');
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(`${API}${urlPath}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (RETRYABLE.has(response.status) && attempt < attempts) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
    return text ? JSON.parse(text) : null;
  }
}

let input;
if (!resumeId) {
  input = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!execute) {
    console.log(JSON.stringify({ input, maxChargeUsd: MAX_CHARGE_USD }, null, 2));
    console.error('Preview only. Add --execute to start a paid run.');
    process.exit(0);
  }
}

let runId = resumeId;
if (!runId) {
  const query = new URLSearchParams({ build: 'latest', memory: MEMORY_MB, timeout: TIMEOUT_SECS, maxTotalChargeUsd: MAX_CHARGE_USD });
  // One attempt only: a lost response can still mean the run exists. Check Console, then --resume.
  runId = (await call('POST', `/acts/${ACTOR}/runs?${query}`, { body: input, attempts: 1 })).data.id;
  console.error(`Started run ${runId}. If this script stops, continue with: --resume ${runId}`);
}

let run;
const deadline = Date.now() + (TIMEOUT_SECS + 120) * 1000;
do {
  run = (await call('GET', `/actor-runs/${runId}?waitForFinish=60`)).data;
} while (!TERMINAL.has(run.status) && Date.now() < deadline);

if (run.actId !== ACTOR_ID) throw new Error('This run belongs to a different Actor');
if (run.status !== 'SUCCEEDED') {
  throw new Error(`Run is ${run.status}. Inspect it before starting another: https://console.apify.com/view/runs/${runId}`);
}

const summary = await call('GET', `/key-value-stores/${run.defaultKeyValueStoreId}/records/RUN_SUMMARY`).catch(error => {
  if (error.status === 404) throw new Error('RUN_SUMMARY is missing, so completeness is unknown');
  throw error;
});
const rows = [];
for (;;) {
  const page = await call('GET', `/datasets/${run.defaultDatasetId}/items?offset=${rows.length}&limit=1000`);
  if (!page?.length) break;
  rows.push(...page);
}

const parts = splitRows(rows);
const out = path.join('runs', runId);
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'results.json'), JSON.stringify({ runId, summary, rows }, null, 2));
console.log(JSON.stringify({
  runId,
  rows: rows.length,
  newSignals: parts.events.length,
  baselineRows: parts.baseline.length,
  groups: parts.groupStatus.length,
  partialOrFailedRows: parts.problems.length,
  saved: path.join(out, 'results.json'),
}, null, 2));
if (parts.problems.length) console.error('Some checks are PARTIAL or FAILED. Read their error before using that data.');
