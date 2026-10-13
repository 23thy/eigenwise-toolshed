import crypto from 'node:crypto';
import fs from 'node:fs';
import { reportFile } from './sweep-handoff.js';
import path from 'node:path';

export type SweepFlight = Readonly<{ token: string; transfer(pid: number): void; release(): void }>;

function readOwner(file: string): { pid: number; token: string } | null {
  try {
    const match = fs.readFileSync(file, 'utf8').match(/^(\d+):([a-f0-9-]{36})$/);
    return match ? { pid: Number(match[1]), token: match[2] || '' } : null;
  } catch {
    return null;
  }
}

function ownerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function flightFile(cwd: string): string {
  return reportFile(cwd).replace(/\.json$/, '.flight');
}

export function releaseSweepFlight(cwd: string, token: string): void {
  const file = flightFile(cwd);
  if (readOwner(file)?.token === token) fs.rmSync(file, { force: true });
}

export function acquireSweepFlight(cwd: string): SweepFlight | null {
  const file = flightFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  try {
    fs.writeFileSync(file, `${process.pid}:${token}`, { flag: 'wx' });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    return null;
  }
  return {
    token,
    transfer(pid) {
      if (readOwner(file)?.token === token) fs.writeFileSync(file, `${pid}:${token}`);
    },
    release: () => releaseSweepFlight(cwd, token),
  };
}

export function sweepFlightOwned(cwd: string, token: string): boolean {
  const owner = readOwner(flightFile(cwd));
  return owner?.token === token && owner.pid === process.pid;
}

export function reclaimSweepFlight(cwd: string): void {
  const file = flightFile(cwd);
  const owner = readOwner(file);
  if (!owner || ownerAlive(owner.pid)) return;
  try {
    // Keep the dead generation's tombstone so delayed reclaimers cannot delete its successor.
    fs.mkdirSync(`${file}.reclaimed-${owner.token}`);
  } catch {
    return;
  }
  releaseSweepFlight(cwd, owner.token);
}
