// Scans source, content and built bundles for secrets, and proves the live bundle has no
// fixture adapter or fixture credentials. Usage: npm run check:secrets
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const SECRET = [/sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{12,}['"]/i, /Bearer\s+[A-Za-z0-9._-]{20,}/];
let failures = 0;
const fail = (m) => { failures++; console.error(`FAIL ${m}`); };

for (const dir of ['src', 'content', 'contract', 'fixtures', 'scripts', 'tests']) {
  for (const f of walk(join(root, dir))) {
    if (!/\.(ts|tsx|js|mjs|json|md|css|html)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const re of SECRET) if (re.test(text)) fail(`${relative(root, f)} matches ${re}`);
  }
}
for (const f of readdirSync(root).filter((f) => f.startsWith('.env'))) {
  const text = readFileSync(join(root, f), 'utf8');
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (!/^VITE_RUNTIME_(PROFILE|ADAPTER_URL|URI|DATABASE)=/.test(line)) fail(`${f}: unexpected variable "${line.split('=')[0]}" (only public VITE_RUNTIME_* settings allowed)`);
    if (/TOKEN|KEY|SECRET|PASSWORD/i.test(line.split('=')[0])) fail(`${f}: credential-like variable`);
  }
}

console.log('Building live profile bundle for inspection (adapter not required for this check)...');
execSync('npx vite build --mode live --outDir dist/live-check --logLevel error', { cwd: root, stdio: 'inherit' });
const live = walk(join(root, 'dist', 'live-check')).filter((f) => /\.(js|html|css)$/.test(f));
const forbidden = ['fixture-operator-local', 'FixtureServer', 'fixture-mock-policy-v1', 'harbor-lights-s1-v1', '__BEHAVIOR_FIXTURE_FAULTS__'];
for (const f of live) {
  const text = readFileSync(f, 'utf8');
  for (const s of forbidden) if (text.includes(s)) fail(`live bundle ${relative(root, f)} contains fixture marker "${s}"`);
  for (const re of SECRET) if (re.test(text)) fail(`live bundle ${relative(root, f)} matches ${re}`);
}
if (existsSync(join(root, 'dist', 'fixture'))) {
  for (const f of walk(join(root, 'dist', 'fixture')).filter((x) => /\.js$/.test(x))) {
    for (const re of SECRET) if (re.test(readFileSync(f, 'utf8'))) fail(`fixture bundle ${relative(root, f)} matches ${re}`);
  }
}
console.log(failures ? `${failures} problem(s).` : `OK: no secrets found; live bundle (${live.length} files) contains no fixture adapter or fixture credentials.`);
process.exit(failures ? 1 : 0);
