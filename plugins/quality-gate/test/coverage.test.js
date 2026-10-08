import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAnalyzer, functionCoverage, readCoverage } from '../lib/core.mjs';
import { measureSource } from '../lib/measure.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const corePath = new URL('../lib/core.mjs', import.meta.url).href;
const analyzer = await createAnalyzer(pluginRoot);
const { transform } = createRequire(new URL('../../sidequest/package.json', import.meta.url))('esbuild');

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

test('owned spans exclude parameter callbacks and keep a returned nested arrow separate', async () => {
  const fixture = await captureFixture('function parameter(callback = () => 1) { return callback; }\nparameter(() => 2);\nconst outer = () => () => 3;\nouter();\n');
  try {
    const metrics = await fixtureMetrics(fixture);
    assert.deepEqual(metrics.map(metric => [metric.name, metric.coverage]), [['parameter', 1], ['<anonymous>', 0], ['<anonymous>', 0], ['outer', 1], ['<anonymous>', 0]]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('duplicate exact runtime records and absent executed bytes stay unverified', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nsubject();\n');
  try {
    const [file] = await fs.readdir(fixture.coverageDirectory);
    const reportPath = path.join(fixture.coverageDirectory, file);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    const script = report.result.find(script => script.url === pathToFileURL(fixture.sourcePath).href);
    script.functions.push(script.functions.find(record => record.functionName === 'subject'));
    await fs.writeFile(reportPath, JSON.stringify(report));
    assert.match((await fixtureMetrics(fixture))[0].unverified, /ambiguous exact runtime range/);
    delete script.source;
    await fs.writeFile(reportPath, JSON.stringify(report));
    assert.match((await fixtureMetrics(fixture))[0].unverified, /missing executed script bytes/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function compilerFixture(source, changeOutput = text => text) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm', sourcemap: 'inline', sourcesContent: true, sourcefile: 'original.ts', minify: true });
  const fixture = await captureFixture(changeOutput(code));
  fixture.originalPath = path.join(fixture.root, 'original.ts');
  await fs.writeFile(fixture.originalPath, source);
  return fixture;
}

async function compilerMetrics(fixture) {
  return measureSource(fixture.originalPath, await readCoverage(fixture.coverageDirectory), { projectRoot: fixture.root, analyzer, outputPaths: [fixture.sourcePath] });
}

test('authentic compiler maps bind minified nested bodies without naming or scaling', async () => {
  const fixture = await compilerFixture('export function outer(values: number[]): number[] {\n  return values.map((value: number) => value + 1);\n}\nouter([1]);\n');
  try {
    const metrics = await compilerMetrics(fixture);
    assert.deepEqual(metrics.map(metric => [metric.name, metric.coverage]), [['outer', 1], ['<anonymous>', 1]]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('malformed compiler maps and a map naming another source stay unverified', async () => {
  const source = 'export function subject(): number { return 1; }\nsubject();\n';
  const malformed = await compilerFixture(source, text => text.replace(/base64,[^\s]+/, 'base64,e30='));
  try {
    assert.match((await compilerMetrics(malformed))[0].unverified, /matching source map/);
  } finally {
    await fs.rm(malformed.root, { recursive: true, force: true });
  }
  const wrongPath = await compilerFixture(source);
  try {
    const originalPath = wrongPath.originalPath;
    wrongPath.originalPath = path.join(wrongPath.root, 'different.ts');
    await fs.copyFile(originalPath, wrongPath.originalPath);
    assert.match((await compilerMetrics(wrongPath))[0].unverified, /matching source map/);
  } finally {
    await fs.rm(wrongPath.root, { recursive: true, force: true });
  }
});

test('an absent owned runtime record stays unverified rather than inheriting module execution', async () => {
  const fixture = await captureFixture('export function outer() { return () => 1; }\n');
  try {
    const metrics = await fixtureMetrics(fixture);
    const nested = metrics.find(metric => metric.name === '<anonymous>');
    assert.equal(nested.coverage, undefined);
    assert.match(nested.unverified, /no captured exact runtime range/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
