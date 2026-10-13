import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { ownedWorkPaths, prepareWorkProvenance, provenanceAdmissionHold } = require('../lib/store/work-provenance.js');

const declaredFiles = ['lib/provenance.js', 'test/provenance.test.js'] as const;
const thinPreparedAt = '2026-01-01T00:00:00.000Z';

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-work-provenance-'));
  const git = (...argumentsList: string[]) => execFileSync('git', argumentsList, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const commit = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
    git('add', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Sidequest Test');
  git('config', 'user.email', 'sidequest@example.invalid');
  const base = commit('README.md', 'base\n');
  git('checkout', '-q', '-b', 'producer');
  const first = commit(declaredFiles[0], 'module.exports = 2;\n');
  const candidate = commit(declaredFiles[1], "require('node:assert').equal(require('../lib/provenance'), 2);\n");
  git('checkout', '-q', 'main');
  const integration = commit('README.md', 'integration moved on\n');
  return { root, git, base, first, candidate, integration };
}

// The shape a 5.9.0 attempt copy kept: route, token and timestamps, with no baseCommit or sanctionedCommits.
function thinProducer(candidate: string, captures: readonly { id: string; value: string; completedAt: string }[], baseCommit?: string) {
  const thin = { preparedAt: thinPreparedAt, terminalAt: '2026-01-01T01:00:00.000Z', outcome: 'released', tokenPrefix: 'thin-token', declaredFiles,
    route: { model: 'opus', effort: 'high' }, ...(baseCommit ? { baseCommit } : {}) };
  return {
    id: 'producer-id', ref: 'SQ-1', claim: null, dispatchNonce: null,
    dispatch: { preparedAt: '2026-02-01T00:00:00.000Z', terminalAt: '2026-02-01T01:00:00.000Z', outcome: 'released', baseCommit: candidate,
      declaredFiles, sanctionedCommits: [], attempts: [thin] },
    verificationCaptures: captures.map(capture => ({ id: capture.id, ticket: 'SQ-1', command: 'node --test', status: 'passed',
      candidate: { source: 'git', value: capture.value }, completedAt: capture.completedAt, dispatchNonce: 'thin-token-nonce' })),
  };
}

function declaration(commit: string) {
  return { kind: 'behavior-preserving-refactor', sources: [{ ref: 'SQ-1', preparedAt: thinPreparedAt, commit }] };
}

test('a thin archived generation is accepted through baseCommit and sanctionedCommits derived from its own capture', () => {
  const fixture = repository();
  const producer = thinProducer(fixture.candidate, [
    { id: 'capture-in-generation', value: fixture.candidate, completedAt: '2026-01-01T00:30:00.000Z' },
    { id: 'capture-of-later-generation', value: fixture.integration, completedAt: '2026-02-01T00:30:00.000Z' },
  ]);
  const lookup = () => producer;
  const provenance = prepareWorkProvenance(fixture.root, declaration(fixture.candidate), 'main-session', lookup, fixture.integration);
  const [source] = provenance.sources;
  assert.equal(source.generation.baseCommit, fixture.base);
  assert.deepEqual(source.generation.sanctionedCommits, [fixture.first, fixture.candidate]);
  assert.deepEqual(source.derivedFacts, [
    { fact: 'baseCommit', derivedFrom: ['capture:capture-in-generation'], integrationCommit: fixture.integration },
    { fact: 'sanctionedCommits', derivedFrom: ['capture:capture-in-generation'] },
  ]);
  assert.deepEqual(source.files.map((file: { path: string }) => file.path), declaredFiles);
  assert.equal(producer.dispatch.attempts.some(attempt => 'baseCommit' in attempt || 'sanctionedCommits' in attempt), false, 'derivation never rewrites the producer generation');
  assert.match(provenanceAdmissionHold(provenance).message,
    /Derived producer facts, not recorded by their generation: SQ-1 2026-01-01T00:00:00\.000Z baseCommit from capture:capture-in-generation; SQ-1 2026-01-01T00:00:00\.000Z sanctionedCommits from capture:capture-in-generation\./);

  fixture.git('checkout', '-q', 'producer');
  fixture.git('merge', '-q', '--no-edit', 'main');
  assert.deepEqual(ownedWorkPaths(fixture.root, provenance, [...declaredFiles, 'lib/new.js'], lookup), ['lib/new.js'],
    'the frozen integration commit replays the same derivation after the integration branch has moved');
});

test('an ambiguous or captureless thin generation is still refused by the fact it lacks', () => {
  const fixture = repository();
  fixture.git('merge', '-q', '--no-edit', 'producer');
  const merged = fixture.git('rev-parse', 'HEAD');
  const capture = { id: 'capture-in-generation', value: fixture.candidate, completedAt: '2026-01-01T00:30:00.000Z' };
  assert.throws(() => prepareWorkProvenance(fixture.root, declaration(fixture.candidate), 'main-session', () => thinProducer(fixture.candidate, [capture]), merged),
    { message: `work provenance refused: producer generation ${thinPreparedAt} missing baseCommit; derivation is ambiguous: capture capture-in-generation candidate ${fixture.candidate} is already on integration commit ${merged} or shares no single merge base with it` });

  const captureless = thinProducer(fixture.candidate, []);
  assert.throws(() => prepareWorkProvenance(fixture.root, declaration(fixture.candidate), 'main-session', () => captureless, merged),
    { message: `work provenance refused: producer generation ${thinPreparedAt} missing baseCommit; no verification capture in that generation records a git candidate to derive it from` });

  const capturelessWithBase = thinProducer(fixture.candidate, [], fixture.base);
  assert.throws(() => prepareWorkProvenance(fixture.root, declaration(fixture.candidate), 'main-session', () => capturelessWithBase, merged),
    { message: `work provenance refused: producer generation ${thinPreparedAt} missing sanctionedCommits; no verification capture in that generation records a git candidate descending from baseCommit ${fixture.base}` });
});
