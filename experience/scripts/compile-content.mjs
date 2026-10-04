// Compiles the authored Harbor Lights PNG + metadata with ENGINE's compiler (the only
// navigation/reachability validator) into experience/assets/. Stage 1 is also written to
// assets/park.bundle.json, the integration launcher's default PARK_BUNDLE_PATH.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = join(here, '..', '..', 'engine');
const content = join(here, '..', 'content', 'harbor-lights', 'generated');
const assets = join(here, '..', 'assets');
if (!existsSync(join(engineDir, 'tools', 'compile-park.ts'))) {
  console.log('NOT RUN: engine/tools/compile-park.ts is not present in this checkout.');
  process.exit(2);
}
mkdirSync(assets, { recursive: true });
for (const stage of ['1', '2']) {
  const out = join(assets, `harbor-lights-stage${stage}.bundle.json`);
  const r = spawnSync('npx', ['tsx', 'tools/compile-park.ts', join(content, `stage${stage}`, 'grid.png'), join(content, `stage${stage}`, 'metadata.json'), out], { cwd: engineDir, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`Engine compiler rejected stage ${stage} (exit ${r.status}).`); process.exit(1); }
}
copyFileSync(join(assets, 'harbor-lights-stage1.bundle.json'), join(assets, 'park.bundle.json'));
console.log('Compiled with Engine: assets/harbor-lights-stage1.bundle.json, assets/harbor-lights-stage2.bundle.json (park.bundle.json = stage 1).');
