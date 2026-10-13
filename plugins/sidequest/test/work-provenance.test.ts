import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { prepareWorkProvenance, ownedWorkPaths } = require('../lib/store/work-provenance.js');

const ownedFile = 'lib/owned.js';

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-work-provenance-'));
  const git = (argumentsList: string[]) => execFileSync('git', argumentsList, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const commitFile = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
    git(['add', file]);
    git(['commit', '-m', `write ${file}`]);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  const base = commitFile('README.md', 'base\n');
  return { root, git, commitFile, base };
}

// A producer that fast-forwards a trial branch, optionally adds a raw foreign commit, then makes one sanctioned commit.
function producerAfterTrialMerge(foreignAfterInheritedTip: boolean) {
  const fixture = repository();
  fixture.git(['checkout', '-b', 'trial']);
  fixture.commitFile('lib/trial.js', 'one\n');
  const inheritedTip = fixture.commitFile('lib/trial.js', 'two\n');
  fixture.git(['checkout', 'main']);
  fixture.git(['merge', '--ff-only', 'trial']);
  if (foreignAfterInheritedTip) fixture.commitFile('lib/foreign.js', 'foreign\n');
  const sanctioned = fixture.commitFile(ownedFile, 'owned\n');
  const producer = { id: 'tk_producer', ref: 'SQ-1', claim: null, dispatchNonce: null, dispatch: {
    preparedAt: '2026-10-10T20:37:42.310Z', terminalAt: '2026-10-10T21:00:00.000Z', outcome: 'released',
    baseCommit: fixture.base, declaredFiles: [ownedFile], sanctionedCommits: [sanctioned] } };
  const declaration = { kind: 'inherited-read-only', sources: [{ ref: 'SQ-1', preparedAt: producer.dispatch.preparedAt, commit: sanctioned }] };
  return { ...fixture, inheritedTip, declaration, lookup: () => producer };
}

test('a fast-forwarded trial branch is inherited, so only the sanctioned commit is judged', () => {
  const { root, git, inheritedTip, declaration, lookup } = producerAfterTrialMerge(false);
  const provenance = prepareWorkProvenance(root, declaration, 'main-session', lookup);
  assert.deepEqual(provenance.sources[0].inheritedTips, [inheritedTip]);
  assert.deepEqual(provenance.sources[0].files.map((file: { path: string }) => file.path), [ownedFile]);
  git(['branch', '-f', 'trial', git(['commit-tree', `${inheritedTip}^{tree}`, '-p', inheritedTip, '-m', 'trial moved on'])]);
  assert.deepEqual(ownedWorkPaths(root, provenance, [ownedFile], lookup), []);
});

test('a foreign commit after the inherited trial tip is still refused', () => {
  const { root, declaration, lookup } = producerAfterTrialMerge(true);
  assert.throws(() => prepareWorkProvenance(root, declaration, 'main-session', lookup),
    { message: 'work provenance refused: range includes work not owned by this producer' });
});
