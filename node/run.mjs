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
import { pathToFileURL } from 'node:url';
import { splitRows } from './events.mjs';

const API = 'https://api.apify.com/v2';
const ACTOR = 'automa-flow~google-trends-monitor';
export const ACTOR_ID = 'WecREidW3gHipWFzP';
const MAX_CHARGE_USD = 0.05;
const TIMEOUT_SECS = 300;
const MEMORY_MB = 512;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The Apify API answers these calls directly. Refusing redirects means the token can never follow one.
export function makeCall(token, fetchImpl = fetch, wait = sleep) {
  return async function call(method, urlPath, { body, attempts = 4 } = {}) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${API}${urlPath}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        if (attempt >= attempts) throw error;
        await wait(2 ** attempt * 1000);
        continue;
      }
      if (RETRYABLE.has(response.status) && attempt < attempts) {
        await wait(2 ** attempt * 1000);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
      }
      return text ? JSON.parse(text) : null;
    }
  };
}

// Read every page, then check the count against the Dataset's own itemCount.
export async function readItems(call, datasetId) {
  const expected = (await call('GET', `/datasets/${datasetId}`)).data.itemCount;
  const rows = [];
  for (;;) {
    const page = await call('GET', `/datasets/${datasetId}/items?offset=${rows.length}&limit=1000`);
    if (!page?.length) break;
    rows.push(...page);
  }
  if (Number.isInteger(expected) && rows.length < expected) {
    throw new Error(`Read ${rows.length} of ${expected} rows, so the result is incomplete. Try --resume later`);
  }
  return rows;
}

// A SUCCEEDED run is necessary but not sufficient: keep the summary and every row.
export async function collect(call, run) {
  if (run.actId !== ACTOR_ID) throw new Error('This run belongs to a different Actor');
  if (!TERMINAL.has(run.status)) throw new Error(`Run ${run.id} is still ${run.status}. Read it later with --resume ${run.id}`);
  if (run.status !== 'SUCCEEDED') {
    throw new Error(`Run is ${run.status}. Inspect it before starting another: https://console.apify.com/view/runs/${run.id}`);
  }
  const summary = await call('GET', `/key-value-stores/${run.defaultKeyValueStoreId}/records/RUN_SUMMARY`).catch(error => {
    if (error.status === 404) throw new Error('RUN_SUMMARY is missing, so completeness is unknown');
    throw error;
  });
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error('RUN_SUMMARY is not an object, so completeness is unknown');
  }
  return { runId: run.id, summary, rows: await readItems(call, run.defaultDatasetId) };
}

async function main(args) {
  const resumeAt = args.indexOf('--resume');
  const resumeId = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
  if (resumeAt >= 0 && !/^[A-Za-z0-9]+$/.test(resumeId ?? '')) throw new Error('--resume expects an Apify run ID');
  const inputPath = args.find(a => !a.startsWith('--') && a !== resumeId) ?? 'examples/quick-start.json';

  let input;
  if (!resumeId) {
    input = JSON.parse(await readFile(inputPath, 'utf8'));
    if (!args.includes('--execute')) {
      console.log(JSON.stringify({ input, maxChargeUsd: MAX_CHARGE_USD }, null, 2));
      console.error('Preview only. Add --execute to start a paid run.');
      return 0;
    }
  }
  if (!process.env.APIFY_TOKEN) throw new Error('Set APIFY_TOKEN first');
  const call = makeCall(process.env.APIFY_TOKEN);

  let runId = resumeId;
  if (!runId) {
    const query = new URLSearchParams({ build: 'latest', memory: MEMORY_MB, timeout: TIMEOUT_SECS, maxTotalChargeUsd: MAX_CHARGE_USD });
    try {
      // One attempt only: a lost response can still mean the run exists.
      runId = (await call('POST', `/acts/${ACTOR}/runs?${query}`, { body: input, attempts: 1 })).data.id;
    } catch (error) {
      console.error(`Could not confirm the run start (${error.message}). A paid run may still have been created: check ` +
        'https://console.apify.com/actors/runs before trying again, then use --resume RUN_ID.');
      return 2;
    }
    console.error(`Started run ${runId}. If this script stops, continue with: --resume ${runId}`);
  }

  let run;
  const deadline = Date.now() + (TIMEOUT_SECS + 120) * 1000;
  do {
    run = (await call('GET', `/actor-runs/${runId}?waitForFinish=60`)).data;
  } while (!TERMINAL.has(run.status) && Date.now() < deadline);

  const result = await collect(call, run);
  const parts = splitRows(result.rows);
  const out = path.join('runs', runId);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    runId,
    rows: result.rows.length,
    newSignals: parts.events.length,
    baselineRows: parts.baseline.length,
    groups: parts.groupStatus.length,
    partialOrFailedRows: parts.problems.length,
    saved: path.join(out, 'results.json'),
  }, null, 2));
  if (parts.problems.length) console.error('Some checks are PARTIAL or FAILED. Read their error before using that data.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => { console.error(error.message); process.exitCode = 1; },
  );
}
