import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAnalyzer, functionCoverage, readCoverage } from '../lib/core.mjs';
import { measureSource } from '../lib/measure.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const corePath = new URL('../lib/core.mjs', import.meta.url).href;
const analyzer = await createAnalyzer(pluginRoot);

test('historical export getter cannot cover the idle production body', () => {
  const descriptor = { identity: '<root>/FunctionDeclaration:negativeControlRecoveryGuidance#0', parent: '<root>', name: 'negativeControlRecoveryGuidance', start: 27983, end: 29293 };
  const records = [
    { functionName: descriptor.name, ranges: [{ startOffset: 1626, endOffset: 1663, count: 1 }] },
    { functionName: descriptor.name, ranges: [{ startOffset: 24396, endOffset: 25691, count: 0 }] },
  ];
  const result = functionCoverage(descriptor, [{ descriptors: [descriptor], records: [] }, { relativePath: 'lib/refusal-guidance.js', records }]);
  assert.equal(result.coverage, undefined, 'historical export getter is never accepted coverage');
  assert.match(result.unverified, /executed|capture|source map/);
});

async function captureFixture(text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-v8-'));
  const sourcePath = path.join(root, 'subject.mjs');
  const coverageDirectory = path.join(root, 'coverage');
  await fs.mkdir(coverageDirectory);
  assert.deepEqual(await fs.readdir(coverageDirectory), []);
  await fs.writeFile(sourcePath, text);
  const { NODE_TEST_CONTEXT, NODE_V8_COVERAGE, ...environment } = process.env;
  const execution = spawnSync(process.execPath, ['--import', corePath, sourcePath], { encoding: 'utf8', timeout: 30000, env: { ...environment, QUALITY_GATE_V8_CAPTURE: coverageDirectory } });
  assert.equal(execution.status, 0, execution.stderr);
  return { root, sourcePath, coverageDirectory };
}

async function fixtureMetrics(fixture) {
  return measureSource(fixture.sourcePath, await readCoverage(fixture.coverageDirectory), { projectRoot: fixture.root, analyzer });
}

test('same-byte direct source owns nested callbacks and distinguishes duplicate names and getters', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nconst exports = { get subject() { return subject; } };\nvoid exports.subject;\nconst first = { duplicate() { return 1; } };\nconst second = { duplicate() { return 2; } };\nfirst.duplicate();\n[1].map((value) => value + 1);\nvoid second;\n');
  try {
    const metrics = await fixtureMetrics(fixture);
    assert.deepEqual(metrics.map((metric) => [metric.name, metric.coverage]), [['subject', 0], ['subject', 1], ['duplicate', 1], ['duplicate', 0], ['<anonymous>', 1]]);
    assert.ok(metrics.every((metric) => !metric.unverified));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('executed source mismatch stays unverified even when the path and ranges match', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nsubject();\n');
  try {
    await fs.writeFile(fixture.sourcePath, 'export function subject() { return 2; }\nsubject();\n');
    const [metric] = await fixtureMetrics(fixture);
    assert.match(metric.unverified, /executed bytes.*differ/);
    assert.equal(metric.coverage, undefined);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('raw V8 reports cannot acquire executed-byte proof from the current file', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nsubject();\n');
  try {
    const files = await fs.readdir(fixture.coverageDirectory);
    const reportPath = path.join(fixture.coverageDirectory, files[0]);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    delete report.qualityGate;
    await fs.writeFile(reportPath, JSON.stringify(report));
    const [metric] = await fixtureMetrics(fixture);
    assert.match(metric.unverified, /capture binding/);
    assert.equal(metric.coverage, undefined);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
