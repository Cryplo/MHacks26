// Creates separate worker and coordinator identities on the local Engine database,
// provisions their roles with the operator (CLI publisher) identity, and writes all
// local session credentials to engine/.local/integration.env (gitignored, mode 0600).
// Tokens are never printed. Reuses existing identities when the file already exists.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
// INTEGRATION_ENV_FILE overrides the credentials file (e.g. for a second local stack).
const file = process.env.INTEGRATION_ENV_FILE ? resolve(process.env.INTEGRATION_ENV_FILE) : resolve(root, 'engine/.local/integration.env');
const uri = process.env.SPACETIME_URI ?? 'http://127.0.0.1:3000';
const database = process.env.SPACETIME_DATABASE ?? 'mhacks-engine';
const adapter = resolve(root, 'engine/client/dist/node.js');
if (!existsSync(adapter)) throw new Error(`Build Engine first: ${adapter} missing`);

let operator = process.env.SPACETIME_OPERATOR_TOKEN;
if (!operator) {
  const out = execFileSync(process.env.SPACETIME_CLI ?? 'spacetime', ['login', 'show', '--token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  operator = out.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];
}
if (!operator) throw new Error('No operator token: log the SpacetimeDB CLI in or set SPACETIME_OPERATOR_TOKEN.');

const existing = existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : {};
const { createRuntimeClient } = await import(pathToFileURL(adapter).href);

async function identityFor(name, roles) {
  let token = existing[`BEHAVIOR_${name}_TOKEN`] || null;
  const c = await createRuntimeClient({ uri, database, token, onToken: (t) => { token = t; } });
  const session = await c.query('session', {});
  await c.close();
  if (!session.roles.some((r) => roles.includes(r))) {
    // Engine's own provisioning tool; only the publisher/operator may grant roles.
    execFileSync('npm', ['run', '-s', 'provision', '--', session.identity, ...roles], {
      cwd: resolve(root, 'engine'), stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, SPACETIME_URI: uri, SPACETIME_DATABASE: database, SPACETIME_OPERATOR_TOKEN: operator },
    });
  }
  return { token, identity: session.identity };
}

const worker = await identityFor('WORKER', ['worker']);
const coordinator = await identityFor('COORDINATOR', ['coordinator']);
const lines = [
  `BEHAVIOR_RUNTIME_ADAPTER=${adapter}`, `BEHAVIOR_RUNTIME_URI=${uri}`, `BEHAVIOR_RUNTIME_DATABASE=${database}`,
  `BEHAVIOR_OPERATOR_TOKEN=${operator}`, `BEHAVIOR_WORKER_TOKEN=${worker.token}`, `BEHAVIOR_COORDINATOR_TOKEN=${coordinator.token}`,
];
writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Identities ready (worker ${worker.identity.slice(0, 10)}…, coordinator ${coordinator.identity.slice(0, 10)}…). Credentials written to ${file} (0600).`);
