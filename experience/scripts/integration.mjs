// `npm run dev:integration`: used by the repository launcher (integration/run.mjs) after
// Engine is published and the park is registered. Copies Engine's bundled browser adapter
// into public/runtime/ (gitignored), builds the LIVE profile and serves it on 127.0.0.1.
// The local UI signs in automatically as the local operator: the launcher writes the operator
// credential from engine/.local/integration.env into the served build (dist/, gitignored).
// Never run this against a shared or deployed database.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export function installAdapter() {
  const src = join(root, '..', 'engine', 'client', 'dist', 'browser.js');
  if (!existsSync(src)) return false;
  mkdirSync(join(root, 'public', 'runtime'), { recursive: true });
  copyFileSync(src, join(root, 'public', 'runtime', 'browser.js'));
  return true;
}
const LOCAL_SESSION_PATH = '/runtime/local-session.json';
function localOperatorToken() {
  const file = join(root, '..', 'engine', '.local', 'integration.env');
  if (!existsSync(file)) return null;
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('BEHAVIOR_OPERATOR_TOKEN='));
  return line ? line.slice('BEHAVIOR_OPERATOR_TOKEN='.length).trim() || null : null;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!installAdapter()) { console.error('Engine browser adapter missing: build engine (npm run build in engine/) first.'); process.exit(1); }
  const token = localOperatorToken();
  const b = spawnSync('npm', ['run', 'build:live'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, VITE_RUNTIME_PROVIDER: process.env.BEHAVIOR_PROVIDER ?? 'mock', ...(token ? { VITE_RUNTIME_LOCAL_SESSION_URL: LOCAL_SESSION_PATH } : {}) },
  });
  if (b.status !== 0) process.exit(b.status ?? 1);
  if (token) writeFileSync(join(root, 'dist', 'live', LOCAL_SESSION_PATH.slice(1)), JSON.stringify({ token }), { mode: 0o600 });
  const port = process.env.EXPERIENCE_PORT ?? '4317';
  const p = spawn('npx', ['vite', 'preview', '--mode', 'live', '--outDir', 'dist/live', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'inherit' });
  console.log(`Experience (live profile) on http://127.0.0.1:${port}` + (token
    ? ' — signed in automatically as the local operator'
    : ' — no engine/.local/integration.env found; run node integration/bootstrap-identities.mjs, or sign in on /session'));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => p.kill(s));
  p.on('exit', (c) => process.exit(c ?? 0));
}
