/**
 * Fixture-backed integration of the runtime service layer. This proves UI-side protocol
 * handling against scripted data ONLY; it is not evidence of real subscriptions or Jev.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrowdSpec, RunManifest } from '../../contract/behavior-v1';
import { FixtureRuntimeClient, memoryFixtureStorage } from '../../src/fixture/client';
import { FixtureServer, FIXTURE_OPERATOR_TOKEN } from '../../src/fixture/server';
import { CommandRunner } from '../../src/runtime/commands';
import { awaitWork } from '../../src/runtime/work';
import { LiveConnection } from '../../src/data/liveConnection';
import { canonicalJson, sha256Hex } from '../../src/domain/canonical';
import { generateShareToken, hashShareToken } from '../../src/features/sharing/shareToken';
import { buildManifest, defaultRunConfig } from '../../src/features/setup/plan';

const crowd: CrowdSpec = { guestCount: 200, seed: 'seed-int', shares: { young_family: 0.4, teens: 0.1, couple: 0.2, thrill_seekers: 0.1, seniors: 0.1, solo: 0.1 }, contextNotes: '', generatorVersion: 'fixture-pop-v1' };

let now = 1_000_000;
const clock = () => now;
const fast = { sleep: async () => undefined };

async function setup(faults = {}) {
  const server = new FixtureServer(memoryFixtureStorage(), clock, faults);
  const op = new FixtureRuntimeClient(server, server.connect(FIXTURE_OPERATOR_TOKEN).identity, { latencyMs: 0, tickMs: 20 });
  const anon = new FixtureRuntimeClient(server, server.connect(null).identity, { latencyMs: 0, tickMs: 20 });
  const runner = new CommandRunner(op, fast);
  const parks = await op.query('listParks', { cursor: null });
  const park = parks.items[0]!.artifact;
  const req = await runner.run('requestProductWork', { request: { kind: 'population', crowd, park } }, 'pop');
  if (req.kind !== 'accepted') throw new Error('population rejected');
  now += 5000;
  const work = await awaitWork<'population'>(op, req.result.workId, { sleep: async () => { now += 500; } });
  const popRef = work.result!.artifact;
  const manifest: RunManifest = buildManifest({ park, population: popRef, scenario: { id: 'baseline', revision: '1', label: 'Baseline', events: [] }, seed: 'seed-int', config: { ...defaultRunConfig('mock'), horizonMs: 3600_000 } });
  return { server, op, anon, runner, park, popRef, manifest };
}

beforeEach(() => { now = 1_000_000; });
afterEach(() => vi.useRealTimers());

describe('fixture runtime protocol', () => {
  it('population artifact bytes match the ref hash and length', async () => {
    const { op, popRef } = await setup();
    const bytes = await op.getArtifact(popRef);
    expect(bytes.length).toBe(popRef.byteLength);
    expect(await sha256Hex(bytes)).toBe(popRef.sha256);
  });

  it('createRun lost acknowledgement + retry with same ID creates exactly one run', async () => {
    const { server, op, manifest } = await setup({ dropAck: ['createRun'] });
    const runner = new CommandRunner(op, fast);
    const out = await runner.run('createRun', { manifest }, 'create:x', { durable: true });
    expect(out.kind).toBe('accepted');
    const again = await runner.run('createRun', { manifest }, 'create:x', { durable: true });
    expect(again.kind === 'accepted' && out.kind === 'accepted' && again.result.runId === out.result.runId).toBe(true);
    const session = server.query('fixture:operator', 'session', {});
    expect(session.runIds.length).toBe(1);
  });

  it('same command ID with a different payload is a CONFLICT receipt', async () => {
    const { op, manifest } = await setup();
    await op.command('createRun', { manifest }, 'fixed-id');
    const r = await op.command('createRun', { manifest: { ...manifest, replicateSeed: 'other' } }, 'fixed-id');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
  });

  it('start requires ready; control commands compare controlRevision', async () => {
    const { runner, manifest, op } = await setup();
    const created = await runner.run('createRun', { manifest }, 'c');
    if (created.kind !== 'accepted') throw new Error('x');
    const runId = created.result.runId;
    const early = await runner.run('startRun', { runId }, 's1');
    expect(early).toMatchObject({ kind: 'rejected', error: { code: 'INVALID_STATE', retryable: true } });
    now += 2000;
    const started = await runner.run('startRun', { runId }, 's2');
    expect(started.kind).toBe('accepted');
    const stale = await runner.run('pauseRun', { runId, expectedControlRevision: 0 }, 'p0');
    expect(stale).toMatchObject({ kind: 'rejected', error: { code: 'STALE_REVISION' } });
    const view = await op.query('getRun', { runId });
    const ok = await runner.run('pauseRun', { runId, expectedControlRevision: view.controlRevision }, 'p1');
    expect(ok.kind).toBe('accepted');
  });

  it('viewer grants: no role by default, share issue/redeem/revoke, viewer cannot control (C-14/C-15)', async () => {
    const { runner, manifest, anon, server } = await setup();
    const created = await runner.run('createRun', { manifest }, 'c');
    if (created.kind !== 'accepted') throw new Error('x');
    const runId = created.result.runId;
    await expect(anon.query('getRun', { runId })).rejects.toMatchObject({ error: { code: 'FORBIDDEN' }, transport: false });
    const token = generateShareToken();
    const issued = await runner.run('issueShare', { runId, access: 'viewer', tokenHash: await hashShareToken(token), expiresAtEpochMs: now + 60_000 }, 'share');
    expect(issued.kind).toBe('accepted');
    // The server stores only the hash, never the token.
    expect(JSON.stringify(server.query('fixture:operator', 'session', {}))).not.toContain(token);
    const redeemed = await anon.command('redeemShare', { token }, 'redeem-1');
    expect(redeemed).toMatchObject({ ok: true, result: { runId, role: 'viewer' } });
    expect((await anon.query('getRun', { runId })).runId).toBe(runId);
    const ctl = await anon.command('pauseRun', { runId, expectedControlRevision: 0 }, 'try-pause');
    expect(ctl).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const sched = await anon.command('scheduleEvents', { runId, expectedScenarioRevision: '1', draftId: null, events: [] }, 'try-sched');
    expect(sched).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    if (issued.kind !== 'accepted') throw new Error('x');
    await runner.run('revokeShare', { grantId: issued.result.grantId }, 'revoke');
    await expect(anon.query('getRun', { runId })).rejects.toMatchObject({ error: { code: 'FORBIDDEN', message: expect.stringMatching(/revoked or has expired/) } });
    // Expired link
    const t2 = generateShareToken();
    await runner.run('issueShare', { runId, access: 'viewer', tokenHash: await hashShareToken(t2), expiresAtEpochMs: now + 1000 }, 'share2');
    now += 5000;
    expect(await anon.command('redeemShare', { token: t2 }, 'redeem-2')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', message: expect.stringMatching(/expired/) } });
  });

  it('scheduleEvents: stale revision conflict, past-time conflict, experiment arm frozen (C-13)', async () => {
    const { runner, manifest, op } = await setup();
    const c = await runner.run('createRun', { manifest }, 'c');
    if (c.kind !== 'accepted') throw new Error('x');
    const runId = c.result.runId;
    now += 2000;
    await runner.run('startRun', { runId }, 's');
    now += 1000;
    const view = await op.query('getRun', { runId });
    const ev = (atMs: number, id = 'e1') => [{ id, atMs, order: 0, change: { kind: 'closure' as const, placeId: 'coaster_tempest', closed: true } }];
    const stale = await op.command('scheduleEvents', { runId, expectedScenarioRevision: '0', draftId: null, events: ev(view.earliestSchedulableMs + 60_000) }, 'k1');
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    const past = await op.command('scheduleEvents', { runId, expectedScenarioRevision: view.scenarioRevision, draftId: null, events: ev(0) }, 'k2');
    expect(past).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const ok = await op.command('scheduleEvents', { runId, expectedScenarioRevision: view.scenarioRevision, draftId: null, events: ev(view.earliestSchedulableMs + 60_000) }, 'k3');
    expect(ok.ok).toBe(true);
    const armRun = await runner.run('createRun', { manifest: { ...manifest, experiment: { experimentId: 'x', pairId: 'p', arm: 'B' } } }, 'arm');
    if (armRun.kind !== 'accepted') throw new Error('x');
    const armEdit = await op.command('scheduleEvents', { runId: armRun.result.runId, expectedScenarioRevision: '1', draftId: null, events: ev(600_000, 'e2') }, 'k4');
    expect(armEdit).toMatchObject({ ok: false, error: { code: 'INVALID_STATE', message: expect.stringMatching(/experiment arm/) } });
    const discount = await op.command('scheduleEvents', { runId, expectedScenarioRevision: '2', draftId: null, events: [{ id: 'd', atMs: view.earliestSchedulableMs + 60_000, order: 0, change: { kind: 'app_message', messageId: 'm', text: '20% off churros', expiresAtMs: 3000_000, suggestedPlaceId: 'churro_cart', discount: { productIds: ['churro'], discountBps: 2000, maxUsesPerGroup: 1 } } }] }, 'k5');
    expect(discount).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
  });

  it('live connection: snapshot, patches, injected gap -> resync, duplicates ignored (C-02/C-16)', async () => {
    const { runner, manifest, server } = await setup();
    const c = await runner.run('createRun', { manifest }, 'c');
    if (c.kind !== 'accepted') throw new Error('x');
    const runId = c.result.runId;
    now += 2000;
    await runner.run('startRun', { runId }, 's');
    const faulty = new FixtureRuntimeClient(server, 'fixture:operator', { latencyMs: 0, tickMs: 10, patchFaults: { duplicateEvery: 2, dropOnceAtCount: 3 } });
    const conn = new LiveConnection(faulty);
    const other = new LiveConnection(new FixtureRuntimeClient(server, 'fixture:operator', { latencyMs: 0, tickMs: 10 }));
    conn.connect(runId);
    other.connect(runId);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(60);
    expect(conn.store.getState().revision).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 8; i++) { now += 600; await wait(40); }
    const a = conn.store.getState();
    const b = other.store.getState();
    expect(a.counters.gaps).toBeGreaterThanOrEqual(1);
    expect(a.counters.duplicates).toBeGreaterThanOrEqual(1);
    expect(a.stale).toBe(false);
    expect(a.revision).toBe(b.revision);
    // Same agent states; Map insertion order may differ between resync and patch paths.
    const byId = (m: typeof a.agents) => [...m.values()].sort((x, y) => (x.agentId < y.agentId ? -1 : 1));
    expect(canonicalJson(byId(a.agents))).toBe(canonicalJson(byId(b.agents)));
    const seqs = a.events.map((e) => e.sequence);
    expect(new Set(seqs).size).toBe(seqs.length);
    conn.disconnect();
    other.disconnect();
  });
});
