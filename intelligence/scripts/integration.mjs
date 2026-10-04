// Launcher entry points for the all-lanes integration (integration/run.mjs):
//   dev:integration        -> worker + coordinator processes on the real Engine (mock provider
//                             unless BEHAVIOR_PROVIDER=jev is explicitly configured)
//   test:integration:engine -> B-18/B-21 real-Engine experiment gates
// Credentials come from engine/.local/integration.env (written by
// integration/bootstrap-identities.mjs); they are passed via environment, never printed.
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.INTEGRATION_ENV_FILE ? resolve(process.env.INTEGRATION_ENV_FILE) : resolve(root, '..', 'engine', '.local', 'integration.env');
if (!existsSync(envFile)) { console.error(`Missing ${envFile}: run node integration/bootstrap-identities.mjs first.`); process.exit(1); }
const fileEnv = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const base = { ...process.env, ...fileEnv, BEHAVIOR_RUNTIME_MODE: 'spacetime', BEHAVIOR_PARK_BUNDLE: process.env.BEHAVIOR_PARK_BUNDLE ?? resolve(root, '..', 'experience', 'assets', 'park.bundle.json') };
const children = [];
const start = (args, env) => { const c = spawn('npm', args, { cwd: root, env, stdio: 'inherit' }); children.push(c); return c; };
const stop = (code) => { for (const c of children) c.kill('SIGTERM'); process.exitCode = code; };
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => stop(0));

if (process.argv[2] === 'test') {
  start(['exec', '--', 'vitest', 'run', 'tests/experiments/engine-adapter.test.ts'], base).on('exit', (c) => process.exit(c ?? 1));
} else {
  for (const role of ['worker', 'coordinator']) {
    start(['run', 'dev:worker'], { ...base, BEHAVIOR_ROLE: role, INTELLIGENCE_DATA_DIR: process.env.INTELLIGENCE_DATA_DIR ?? '.data/integration' })
      .on('exit', (c) => { console.error(`${role} exited (${c})`); stop(c ?? 1); });
  }
}
