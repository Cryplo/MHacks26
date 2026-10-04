// Runs Engine's park compiler on the authored Harbor Lights assets when the Engine lane is
// present in this checkout. Experience does not ship a second navigation compiler.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const engineDir = join(repo, 'engine');
const content = join(here, '..', 'content', 'harbor-lights');
if (!existsSync(join(engineDir, 'package.json'))) {
  console.log('NOT RUN: engine/ is not present in this checkout. Engine owns the compiler/reachability validator.');
  console.log(`When available: (cd ${engineDir} && npm run compile:park -- --source ${content} --stage 1|2)`);
  process.exit(2);
}
let failed = false;
for (const stage of ['1', '2']) {
  const r = spawnSync('npm', ['run', '-s', 'compile:park', '--', '--source', content, '--stage', stage], { cwd: engineDir, stdio: 'inherit' });
  if (r.status !== 0) { failed = true; console.error(`Engine compiler failed for stage ${stage} (exit ${r.status}).`); }
}
process.exit(failed ? 1 : 0);
