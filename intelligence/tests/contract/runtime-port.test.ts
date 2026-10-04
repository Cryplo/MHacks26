import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SequenceJitter } from '../../src/runtime/clock.ts';
import { runCommand } from '../../src/runtime/commands.ts';
import { loadRuntimeClient } from '../../src/runtime/loader.ts';
import { conformance } from '../helpers/fixtures.ts';
import { fakeServer } from '../helpers/runtime.ts';

describe('scripted fake RuntimeClient (orchestration-only)', () => {
  it('stores durable receipts: same id/same payload returns original, different payload conflicts', async () => {
    const { server } = fakeServer();
    server.enqueueWork('decision', conformance().decisionRequest);
    const c = server.client('worker');
    const input = { kinds: ['decision' as const], limit: 1, workerNonce: 'n1', leaseMs: 30_000 };
    const r1 = await c.command('claimWork', input, 'cmd-1');
    const r2 = await c.command('claimWork', input, 'cmd-1');
    expect(r2).toEqual(r1);
    const r3 = await c.command('claimWork', { ...input, limit: 2 }, 'cmd-1');
    expect(r3.ok === false && r3.error.code).toBe('CONFLICT');
  });

  it('rejects claims for unauthorized kinds by role', async () => {
    const { server } = fakeServer();
    const w = await server.client('worker').command('claimWork', { kinds: ['experiment'], limit: 1, workerNonce: 'n', leaseMs: 30_000 }, 'c1');
    expect(w.ok === false && w.error.code).toBe('FORBIDDEN');
    const k = await server.client('coordinator').command('claimWork', { kinds: ['decision'], limit: 1, workerNonce: 'n', leaseMs: 30_000 }, 'c2');
    expect(k.ok === false && k.error.code).toBe('FORBIDDEN');
  });

  it('runCommand retries a lost acknowledgement with the same command id', async () => {
    const { server, clock } = fakeServer();
    server.enqueueWork('decision', conformance().decisionRequest);
    server.faults.dropAck = { claimWork: 1 };
    const c = server.client('worker');
    const p = runCommand(c, 'claimWork', { kinds: ['decision'], limit: 1, workerNonce: 'n', leaseMs: 30_000 }, 'cmd-x', { clock, jitter: new SequenceJitter([0]) });
    await new Promise((r) => setTimeout(r, 0));
    clock.advanceToNext();
    const r = await p;
    expect(r.ok && r.result.items).toHaveLength(1);
    const forId = server.commandLog.filter((e) => e.commandId === 'cmd-x');
    expect(forId.map((e) => e.applied)).toEqual([true, false]);
    expect(server.work.values().next().value!.attempt).toBe(1);
  });
});

describe('runtime loader', () => {
  it('fixture mode uses the supplied factory', async () => {
    const { server } = fakeServer();
    const c = await loadRuntimeClient({ mode: 'fixture', create: () => server.client('worker') });
    expect(c.contractVersion).toBe('behavior.v1');
  });

  it('spacetime mode fails explicitly when the adapter is missing (no fixture fallback)', async () => {
    await expect(loadRuntimeClient({ mode: 'spacetime', adapterModulePath: '/nonexistent/node.js', config: { uri: 'ws://x', database: 'd', token: null } }))
      .rejects.toThrow(/not found/);
  });

  it('spacetime mode loads createRuntimeClient from a module path and checks contract version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
    const good = join(dir, 'good.mjs');
    writeFileSync(good, "export async function createRuntimeClient(cfg){ return { contractVersion: 'behavior.v1', cfg, close: async()=>{} }; }");
    const c = await loadRuntimeClient({ mode: 'spacetime', adapterModulePath: good, config: { uri: 'ws://x', database: 'd', token: null } });
    expect(c.contractVersion).toBe('behavior.v1');
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, "export async function createRuntimeClient(){ return { contractVersion: 'behavior.v0', close: async()=>{} }; }");
    await expect(loadRuntimeClient({ mode: 'spacetime', adapterModulePath: bad, config: { uri: 'ws://x', database: 'd', token: null } })).rejects.toThrow(/behavior.v0/);
    const none = join(dir, 'none.mjs');
    writeFileSync(none, 'export const x = 1;');
    await expect(loadRuntimeClient({ mode: 'spacetime', adapterModulePath: none, config: { uri: 'ws://x', database: 'd', token: null } })).rejects.toThrow(/does not export/);
  });
});
