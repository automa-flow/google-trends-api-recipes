import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTOR_ID, collect, makeCall, readItems } from './run.mjs';

// A fake Apify API: each call takes the next scripted response.
function fakeCall(responses) {
  const calls = [];
  const call = async (method, urlPath) => {
    calls.push([method, urlPath]);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { call, calls };
}

const run = overrides => ({
  id: 'run1', actId: ACTOR_ID, status: 'SUCCEEDED', defaultKeyValueStoreId: 'store1', defaultDatasetId: 'dataset1', ...overrides,
});

test('every dataset page is read and checked against itemCount', async () => {
  const page = Array.from({ length: 1000 }, (_, n) => ({ n }));
  const { call, calls } = fakeCall([{ data: { itemCount: 1001 } }, page, [{ n: 'last' }], []]);
  assert.equal((await readItems(call, 'dataset1')).length, 1001);
  assert.match(calls[2][1], /offset=1000/);
});

test('fewer rows than the dataset count is an error, not a smaller result', async () => {
  const { call } = fakeCall([{ data: { itemCount: 3 } }, [{ n: 1 }], []]);
  await assert.rejects(readItems(call, 'dataset1'), /Read 1 of 3 rows/);
});

test('collect keeps failed rows and requires RUN_SUMMARY', async () => {
  const rows = [{ status: 'FAILED', record_type: 'group_status' }, { status: 'SUCCESS' }];
  const ok = fakeCall([{ isFinal: true }, { data: { itemCount: 2 } }, rows, []]);
  assert.deepEqual((await collect(ok.call, run())).rows, rows);
  const missing = fakeCall([Object.assign(new Error('HTTP 404'), { status: 404 })]);
  await assert.rejects(collect(missing.call, run()), /RUN_SUMMARY is missing/);
});

test('collect refuses other Actors, unfinished and failed runs', async () => {
  const { call } = fakeCall([]);
  await assert.rejects(collect(call, run({ actId: 'other' })), /different Actor/);
  await assert.rejects(collect(call, run({ status: 'RUNNING' })), /still RUNNING\. Read it later with --resume run1/);
  await assert.rejects(collect(call, run({ status: 'TIMED-OUT' })), /Run is TIMED-OUT/);
});

test('the run start is sent once; reads retry temporary errors', async () => {
  const statuses = [503, 503, 200];
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.method);
    const status = statuses.shift();
    return { status, ok: status < 400, text: async () => JSON.stringify({ data: { id: 'run1' } }) };
  };
  const call = makeCall('test-token', fetchImpl, async () => {});
  await assert.rejects(call('POST', '/acts/x/runs', { body: {}, attempts: 1 }), /HTTP 503/);
  assert.equal((await call('GET', '/actor-runs/run1')).data.id, 'run1');
  assert.deepEqual(seen, ['POST', 'GET', 'GET']);
});
