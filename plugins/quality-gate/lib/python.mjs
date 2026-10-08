import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const adapter = fileURLToPath(new URL('./python/crap_adapter.py', import.meta.url));

export function pythonRuntime(root) {
  for (const [command, argumentsList] of [['python3', []], ['py', ['-3']]]) {
    const result = spawnSync(command, [...argumentsList, '--version'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status === 0 && /Python 3\./.test(result.stdout)) return { command, argumentsList };
  }
  throw new Error('Python 3 is unavailable. Put the project Python 3 on PATH as python3 or py -3, then rerun the gate. Radon is not required.');
}

export function pythonDescriptors(text, file, root) {
  const { command, argumentsList } = pythonRuntime(root);
  const result = spawnSync(command, [...argumentsList, '-I', adapter], { cwd: root, input: JSON.stringify({ text, file }), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Python source adapter failed for ${file}: ${result.stderr || result.error?.message}. Fix the source or Python runtime, then rerun the gate.`);
  return JSON.parse(result.stdout).rows;
}
