/**
 * B-22 gate: the billable smoke never runs implicitly, and routine tests never target the real
 * vendor endpoint. The live smoke itself is run by an operator with `npm run smoke:jev -- --billable`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tsx = join(root, 'node_modules', '.bin', 'tsx');

function runSmoke(args: string[], env: Record<string, string | undefined>) {
  const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return spawnSync(tsx, ['src/cli/jev-smoke.ts', ...args], { cwd: root, env: clean, encoding: 'utf8', timeout: 60_000 });
}

describe('B-22 real-Jev smoke gate (no network or billing in routine tests)', () => {
  it('without --billable prints NOT RUN and exits 2', () => {
    const r = runSmoke([], { JEV_API_KEY: 'jv_test_not_a_key' });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ gate: 'B-22 real-Jev smoke', status: 'NOT RUN' });
    expect(r.stdout).not.toContain('jv_test_not_a_key');
  }, 60_000);

  it('with --billable but no key prints NOT RUN and exits 2', () => {
    const r = runSmoke(['--billable'], { JEV_API_KEY: undefined });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ status: 'NOT RUN', reason: 'JEV_API_KEY is not set' });
  }, 60_000);

  it('no test file sends requests to the production endpoint', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(join(root, 'tests'));
    for (const f of files) {
      if (f.endsWith('smoke-gate.test.ts')) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('api.typesafe.ai')) continue;
        expect(line, `${f} must only use the production endpoint in constructor-rejection tests`).toMatch(/apiKey: ''.*toThrow/);
      }
    }
  });
});
