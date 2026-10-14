// Runs a Python script with the project's virtual environment (.venv), on Windows or Unix.
//   node scripts/refdata/run-python.mjs scripts/refdata/export-wordfreq.py [args…]
// Create the environment once (see docs/lookup-refdata.md):
//   py -m venv .venv   (or: python3 -m venv .venv)
//   .venv/Scripts/python -m pip install wordfreq      (Windows)   |   .venv/bin/python -m pip install wordfreq   (Unix)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const candidates = [resolve(root, '.venv', 'Scripts', 'python.exe'), resolve(root, '.venv', 'bin', 'python')];
const python = candidates.find((p) => existsSync(p));

if (!python) {
  console.error('No virtual environment found at .venv. Create it first:\n  py -m venv .venv\n  .venv\\Scripts\\python -m pip install wordfreq');
  process.exit(1);
}

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/refdata/run-python.mjs <script.py> [args…]');
  process.exit(1);
}

const result = spawnSync(python, [resolve(root, script), ...args], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
