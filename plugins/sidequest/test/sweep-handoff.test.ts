import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runSweep, reportFile, drainReport } from '../src/hooks/shared/sweep-handoff.js';
import { acquireSweepFlight, reclaimSweepFlight, releaseSweepFlight } from '../src/hooks/shared/sweep-flight.js';

const plugin = path.resolve(__dirname, '..');
const { isProcessTerminal } = require('../scripts/owned-process-tree.js') as { isProcessTerminal(pid: number): boolean };

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await delay(25);
  assert.ok(check(), 'owned sweep settles within the test deadline');
}

test('overlapping SessionStart handoffs start one sweep and the worker deadline ends its descendants', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-flight-'));
  const marker = path.join(home, 'workers.jsonl');
  const preload = path.join(home, 'stall-maintenance.cjs');
  const environment = { ...process.env };
  fs.writeFileSync(preload, `
const Module = require('node:module');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/lib/store.js') || request.endsWith('\\\\lib\\\\store.js')) {
    const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ worker: process.pid, descendant: descendant.pid }) + '\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
  return load.call(this, request, parent, isMain);
};
`);
  Object.assign(process.env, {
    SIDEQUEST_HOME: home,
    CLAUDE_PLUGIN_ROOT: plugin,
    SIDEQUEST_SWEEP_DEADLINE_MS: '0',
    SIDEQUEST_SWEEP_WORKER_DEADLINE_MS: '3000',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${preload.replaceAll(path.sep, '/')}"`,
  });
  try {
    const notices = await Promise.all([runSweep({ cwd: home }), runSweep({ cwd: home })]);
    for (const result of notices) assert.match(result.join('\n'), /still running in the background/);
    await waitUntil(() => fs.existsSync(marker));
    const workers = fs.readFileSync(marker, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { worker: number; descendant: number });
    assert.equal(workers.length, 1, 'overlapping SessionStart invocations start one maintenance worker');
    assert.ok(workers[0]);
    await delay(3500);
    assert.ok(isProcessTerminal(workers[0].worker), 'deadline cleanup ends the worker');
    assert.ok(isProcessTerminal(workers[0].descendant), 'deadline cleanup ends the owned descendant');
    assert.match((drainReport(home) || []).join('\n'), /worker deadline/);
  } finally {
    await waitUntil(() => !fs.existsSync(reportFile(home).replace(/\.json$/, '.flight')));
    process.env = environment;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dead sweep ownership is reclaimed without letting an old token release its successor', () => {
  const environment = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-reclaim-'));
  process.env.SIDEQUEST_HOME = home;
  try {
    const flight = acquireSweepFlight(home)!;
    assert.equal(acquireSweepFlight(home), null, 'a live sweep retains single-flight ownership');
    flight.transfer(99999999);
    reclaimSweepFlight(home);
    const successor = acquireSweepFlight(home)!;
    releaseSweepFlight(home, flight.token);
    reclaimSweepFlight(home);
    assert.equal(acquireSweepFlight(home), null, 'stale release cannot remove a live successor');
    successor.release();
    assert.ok(acquireSweepFlight(home));
  } finally {
    process.env = environment;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
