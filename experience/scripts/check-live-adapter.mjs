// Gate for the live profile: Engine's bundled browser adapter must be present at the
// configured same-origin path. There is no fallback to fixture data.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.live'), 'utf8').split('\n').filter((l) => /^VITE_RUNTIME_\w+=/.test(l)).map((l) => l.split('=')));
const url = process.env.VITE_RUNTIME_ADAPTER_URL ?? env.VITE_RUNTIME_ADAPTER_URL ?? '/runtime/browser.js';
const file = join(root, 'public', url.replace(/^\//, ''));
if (!existsSync(file)) {
  console.error(`Live adapter missing: ${file}\nBuild Engine's browser client (engine/client/dist/browser.js) and copy it here with A's integration launcher (integration/), or run the fixture profile (npm run dev).`);
  process.exit(1);
}
const src = readFileSync(file, 'utf8');
if (!/createRuntimeClient/.test(src)) {
  console.error(`${file} does not appear to export createRuntimeClient.`);
  process.exit(1);
}
console.log(`Live adapter present: ${file}`);
