import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { splitRows, timelineRows } from './events.mjs';

const read = async p => JSON.parse(await readFile(new URL(p, import.meta.url), 'utf8'));
const fixture = await read('../fixtures/sample_output.json');
const workflow = await read('../n8n/keyword-watchlist.json');
const watchlist = await read('../examples/keyword-watchlist.json');
const ACTOR_ID = 'WecREidW3gHipWFzP';

test('sample output: new signals, baseline and a partial group stay separate', () => {
  const parts = splitRows(fixture);
  assert.deepEqual(new Set(parts.events.map(r => r.change_type)), new Set(['BREAKOUT_NEW', 'RISING_QUERY_CHANGED']));
  assert.deepEqual(parts.baseline.map(r => r.change_type), ['BASELINE']);
  assert.equal(parts.groupStatus.length, 2);
  assert.deepEqual(parts.problems.map(r => r.status), ['PARTIAL']);
});

test('a partial observation never becomes a signal', () => {
  const event = splitRows(fixture).events[0];
  const parts = splitRows([{ ...event, status: 'PARTIAL' }]);
  assert.equal(parts.events.length, 0);
  assert.equal(parts.problems.length, 1);
});

test('NOT_FOUND is a verified empty answer, not a problem', () => {
  const parts = splitRows([{ record_type: 'group_status', status: 'NOT_FOUND' }]);
  assert.equal(parts.problems.length, 0);
  assert.equal(parts.groupStatus.length, 1);
});

test('timeline rows keep the partial-day flag', () => {
  assert.deepEqual(timelineRows(fixture).map(r => r.is_partial), [false, true]);
});

const node = name => workflow.nodes.find(n => n.name === name);
const code = name => new Function('$input', '$', node(name).parameters.jsCode);

test('n8n workflow is inactive, has no credentials and runs the documented input', () => {
  assert.equal(workflow.active, false);
  assert.ok(workflow.nodes.every(n => !n.credentials));
  const start = node('Run Actor').parameters;
  assert.equal(start.actorId, 'automa-flow~google-trends-monitor');
  assert.deepEqual(JSON.parse(start.customBody), watchlist);
  assert.equal(start.maxTotalChargeUsd, 0.05);
});

test('n8n rejects unfinished runs, other Actors and oversized datasets', () => {
  const execute = (name, json) => code(name)({ first: () => ({ json }) });
  assert.throws(() => execute('Require completed run', { status: 'FAILED', actId: ACTOR_ID }));
  assert.throws(() => execute('Require completed run', { status: 'SUCCEEDED', actId: 'other' }));
  assert.throws(() => execute('Validate size', { body: { data: { itemCount: 10001 } } }));
  assert.equal(execute('Validate size', { body: { data: { itemCount: 0 } } })[0].json.itemCount, 0);
});

test('n8n requires a complete dataset and a summary, and keeps problems visible', () => {
  const values = {
    'Validate size': { itemCount: 0 },
    'Read summary': { body: { isFinal: true } },
    'Require completed run': { id: 'fixtureRun', actId: ACTOR_ID, status: 'SUCCEEDED' },
  };
  const select = name => ({ first: () => ({ json: values[name] }) });
  const execute = rows => code('Useful output')({ first: () => ({ json: { body: rows } }) }, select);
  assert.equal(execute([])[0].json.rows.length, 0);
  values['Validate size'].itemCount = 2;
  assert.throws(() => execute([{}]), /Incomplete/);
  values['Validate size'].itemCount = fixture.length;
  const result = execute(fixture)[0].json;
  assert.equal(result.events.length, 2);
  assert.equal(result.problems.length, 1);
  values['Read summary'].body = null;
  assert.throws(() => execute(fixture), /SUMMARY/);
});
