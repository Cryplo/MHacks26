// `npm run dev:integration`: used by the repository launcher (integration/run.mjs) after
// Engine is published and the park is registered. Copies Engine's bundled browser adapter
// into public/runtime/ (gitignored), builds the LIVE profile and serves it.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!installAdapter()) { console.error('Engine browser adapter missing: build engine (npm run build in engine/) first.'); process.exit(1); }
  const b = spawnSync('npm', ['run', 'build:live'], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
  const port = process.env.EXPERIENCE_PORT ?? '4317';
  const p = spawn('npx', ['vite', 'preview', '--mode', 'live', '--outDir', 'dist/live', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'inherit' });
  console.log(`Experience (live profile) on http://127.0.0.1:${port} — sign in with the operator credential from engine/.local/integration.env`);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => p.kill(s));
  p.on('exit', (c) => process.exit(c ?? 0));
}
