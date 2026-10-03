// Live-integration browser suite. Always proves the missing-adapter error path; runs the
// integrated suite only when Engine's adapter and an operator credential are available.
// Exit codes: 0 integrated suite passed; 1 failure; 2 integrated suite NOT RUN.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (mode) => spawnSync('npx', ['playwright', 'test', '--config', 'playwright.live.config.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, E2E_LIVE_MODE: mode } }).status;

console.log('== Live profile without adapter (C-01: explicit error, no fixture fallback) ==');
if (run('missing') !== 0) process.exit(1);
console.log('== Live profile with a contract stub adapter (adapter swaps in by configuration) ==');
if (run('stub') !== 0) process.exit(1);

const adapter = join(root, 'public', 'runtime', 'browser.js');
const missing = [];
if (!existsSync(adapter)) missing.push(`Engine browser adapter at ${adapter} (copied by A's integration launcher)`);
if (!process.env.BEHAVIOR_OPERATOR_TOKEN) missing.push('BEHAVIOR_OPERATOR_TOKEN from Engine dev:seed (trusted local allowlist)');
if (missing.length) {
  console.log(`\nNOT RUN: integrated live suite (C-14/C-16/C-22 against real backend; C-23 real Jev).\nMissing:\n- ${missing.join('\n- ')}\nStart A's launcher (integration/) with B's mock worker, then rerun npm run test:e2e:live.`);
  process.exit(2);
}
console.log('== Integrated live suite against real backend state ==');
process.exit(run('integrated') === 0 ? 0 : 1);
