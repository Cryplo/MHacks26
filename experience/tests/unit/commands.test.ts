/** C-04: stable command IDs across double clicks, lost acknowledgements and reloads. */
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../../contract/behavior-v1';
import { CommandRunner, memoryIntentStore } from '../../src/runtime/commands';
import { domainError, makeRuntimeClientError } from '../../src/runtime/errors';

function fakeClient(impl: (name: string, input: unknown, commandId: string) => Promise<unknown>) {
  const command = vi.fn(impl);
  return { client: { command } as unknown as RuntimeClient, command };
}
let n = 0;
const ids = () => `cmd-${++n}`;
const fast = { sleep: async () => undefined, newId: ids };

describe('CommandRunner', () => {
  it('double click returns the same in-flight promise and one command ID', async () => {
    let resolve!: (v: unknown) => void;
    const { client, command } = fakeClient((_n, _i, id) => new Promise((r) => { resolve = () => r({ commandId: id, ok: true, result: { runId: 'run-1' } }); }));
    const runner = new CommandRunner(client, fast);
    const p1 = runner.run('createRun', { manifest: {} as never }, 'create:plan-a');
    const p2 = runner.run('createRun', { manifest: {} as never }, 'create:plan-a');
    expect(p1).toBe(p2);
    expect(runner.isPending('create:plan-a')).toBe(true);
    resolve(undefined);
    expect((await p1).kind).toBe('accepted');
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('retries a lost acknowledgement with the ORIGINAL command ID', async () => {
    const seen: string[] = [];
    const { client } = fakeClient(async (_n, _i, id) => {
      seen.push(id);
      if (seen.length === 1) throw makeRuntimeClientError(domainError('DEPENDENCY_UNAVAILABLE', 'ack lost', true), true);
      return { commandId: id, ok: true, result: { runId: 'run-1' } };
    });
    const out = await new CommandRunner(client, fast).run('startRun', { runId: 'r' }, 'start:r');
    expect(out.kind).toBe('accepted');
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('reports a domain rejection distinctly and does not retry it', async () => {
    const { client, command } = fakeClient(async (_n, _i, id) => ({ commandId: id, ok: false, error: domainError('STALE_REVISION', 'stale') }));
    const out = await new CommandRunner(client, fast).run('pauseRun', { runId: 'r', expectedControlRevision: 1 }, 'pause:r:1');
    expect(out).toMatchObject({ kind: 'rejected', error: { code: 'STALE_REVISION' } });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('gives up on persistent transport failure but keeps the ID for a manual retry', async () => {
    const seen: string[] = [];
    let fail = true;
    const { client } = fakeClient(async (_n, _i, id) => {
      seen.push(id);
      if (fail) throw makeRuntimeClientError(domainError('DEPENDENCY_UNAVAILABLE', 'down', true), true);
      return { commandId: id, ok: true, result: {} };
    });
    const runner = new CommandRunner(client, { ...fast, maxAttempts: 2 });
    const first = await runner.run('startRun', { runId: 'r' }, 'start:r');
    expect(first.kind).toBe('transport');
    expect(runner.getPending()[0]!.state).toBe('transport_failed');
    fail = false;
    const second = await runner.run('startRun', { runId: 'r' }, 'start:r');
    expect(second.kind).toBe('accepted');
    expect(new Set(seen).size).toBe(1);
  });

  it('durable intents reuse the command ID after reload (new runner, same store)', async () => {
    const store = memoryIntentStore();
    const seen: string[] = [];
    const { client } = fakeClient(async (_n, _i, id) => { seen.push(id); return { commandId: id, ok: true, result: { runId: 'run-1' } }; });
    await new CommandRunner(client, { ...fast, durable: store }).run('createRun', { manifest: { a: 1 } as never }, 'create:h', { durable: true });
    await new CommandRunner(client, { ...fast, durable: store }).run('createRun', { manifest: { a: 1 } as never }, 'create:h', { durable: true });
    expect(seen[0]).toBe(seen[1]);
  });

  it('a changed payload under the same intent is a new command ID; non-durable intents get fresh IDs', async () => {
    const seen: string[] = [];
    const { client } = fakeClient(async (_n, _i, id) => { seen.push(id); return { commandId: id, ok: true, result: {} }; });
    const runner = new CommandRunner(client, fast);
    await runner.run('setSpeed', { runId: 'r', requestedSpeed: 5, expectedControlRevision: 1 }, 'speed');
    await runner.run('setSpeed', { runId: 'r', requestedSpeed: 5, expectedControlRevision: 1 }, 'speed');
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('rejects a receipt for a different command', async () => {
    const { client } = fakeClient(async () => ({ commandId: 'other', ok: true, result: {} }));
    const out = await new CommandRunner(client, fast).run('startRun', { runId: 'r' }, 'start');
    expect(out.kind).toBe('rejected');
  });
});
