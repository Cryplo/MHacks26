import { describe, expect, it } from 'vitest';
import type { DecisionResult, RatingRequest } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../../src/core/canonical.ts';
import { validateDistribution } from '../../src/core/validate.ts';
import { DEFAULT_CROWD_300 } from '../../src/fixtures/crowds.ts';
import { MockProvider } from '../../src/providers/mock.ts';
import type { BehaviorProvider } from '../../src/providers/types.ts';
import { ProviderError } from '../../src/providers/types.ts';
import { ManualClock } from '../../src/runtime/clock.ts';
import { MemoryStore } from '../../src/runtime/store.ts';
import { conformance } from '../helpers/fixtures.ts';
import { fixturePark } from '../helpers/park.ts';
import { fakeServer } from '../helpers/runtime.ts';
import { CounterIds } from '../../src/runtime/commands.ts';
import { buildWorker, pump, settle } from '../helpers/worker.ts';

const req = () => conformance().decisionRequest;

class CountingProvider extends MockProvider {
  calls = 0;
  gate: Promise<void> | null = null;
  override async decide(r: Parameters<MockProvider['decide']>[0]) {
    this.calls++;
    if (this.gate) await this.gate;
    return super.decide(r);
  }
}

describe('B-05 fake port lease -> mock distribution -> result', () => {
  it('completes a decision with a validated mock distribution and unchanged identity', async () => {
    const { server } = fakeServer();
    const workId = server.enqueueWork('decision', req(), { runId: 'fixture-run', experimentId: null });
    const { worker } = buildWorker(server.client('worker'));
    expect(await worker.runOnce()).toBe(1);
    await worker.drain();
    const w = server.work.get(workId)!;
    expect(w.status).toBe('ready');
    const result = w.result as DecisionResult;
    expect(result.requestId).toBe(req().requestId);
    expect(result.observationHash).toBe(req().observationHash);
    expect(result.optionsHash).toBe(req().optionsHash);
    expect(result.source).toBe('mock');
    expect(result.originalSource).toBe('mock');
    expect(result.modelRequested).toBe('mock-policy-v1');
    expect(result.probabilities.map((p) => p.optionId)).toEqual(req().options.map((o) => o.id));
    expect(validateDistribution(req().options.map((o) => o.id), result.probabilities).ok).toBe(true);
    // A distribution, not a chosen action: no field names a selected option.
    expect(Object.keys(result)).not.toContain('chosenOptionId');
    expect(JSON.stringify(result)).not.toMatch(/"chosen/);
    expect(server.artifacts.get(result.responseArtifact.artifactId)!.ref.kind).toBe('model_response');
  });

  it('never calls world-mutation, scenario or driver commands from the worker identity', async () => {
    const { server } = fakeServer();
    for (let i = 0; i < 3; i++) server.enqueueWork('decision', req());
    const { worker } = buildWorker(server.client('worker'));
    await worker.runOnce(); await worker.drain();
    const names = new Set(server.commandLog.filter((c) => c.identity === 'worker').map((c) => c.name));
    for (const forbidden of ['createRun', 'startRun', 'scheduleEvents', 'advanceRun', 'acquireDriver', 'cancelRun', 'pauseRun', 'setSpeed', 'createExperiment', 'recordExperimentProgress']) {
      expect(names.has(forbidden)).toBe(false);
    }
    expect([...names].every((n) => ['claimWork', 'completeWork', 'recordProviderAttempt', 'renewWork', 'failWork'].includes(n))).toBe(true);
  });

  it('invalid snapshots (hash mismatch) fail visibly without a provider call', async () => {
    const { server } = fakeServer();
    const bad = { ...req(), optionsHash: 'f'.repeat(64) };
    const id = server.enqueueWork('decision', bad);
    const provider = new CountingProvider();
    const { worker } = buildWorker(server.client('worker'), { provider });
    await worker.runOnce(); await worker.drain();
    expect(provider.calls).toBe(0);
    expect(server.work.get(id)!.status).toBe('failed');
    expect(server.work.get(id)!.error!.code).toBe('INVALID_INPUT');
  });

  it('population job produces a validated artifact with exact counts', async () => {
    const { server } = fakeServer();
    const { art } = fixturePark();
    const parkRef = server.storeArtifact('operator', 'park', 'application/json', art.bytes, { runId: null, experimentId: null });
    const id = server.enqueueWork('population', { crowd: DEFAULT_CROWD_300, park: parkRef, closeAfterMs: 36_000_000 });
    const { worker } = buildWorker(server.client('worker'));
    await worker.runOnce(); await worker.drain();
    const w = server.work.get(id)!;
    expect(w.status).toBe('ready');
    const res = w.result as { artifact: { artifactId: string; kind: string }; guestCount: number; groupCount: number };
    expect(res.guestCount).toBe(300);
    expect(res.artifact.kind).toBe('population');
    const bytes = server.artifacts.get(res.artifact.artifactId)!.bytes;
    expect(JSON.parse(new TextDecoder().decode(bytes)).personas).toHaveLength(300);
  });

  it('infeasible population requests fail with actionable field errors', async () => {
    const { server } = fakeServer();
    const { art } = fixturePark();
    const parkRef = server.storeArtifact('operator', 'park', 'application/json', art.bytes, { runId: null, experimentId: null });
    const id = server.enqueueWork('population', { crowd: { ...DEFAULT_CROWD_300, guestCount: 1, shares: { young_family: 1, teens: 0, couple: 0, thrill_seekers: 0, seniors: 0, solo: 0 } }, park: parkRef, closeAfterMs: 36_000_000 });
    const { worker } = buildWorker(server.client('worker'));
    await worker.runOnce(); await worker.drain();
    expect(server.work.get(id)!.error!.code).toBe('INVALID_INPUT');
    expect(server.work.get(id)!.error!.fieldErrors[0]!.message).toMatch(/increase guestCount/);
  });

  it('rating work produces a per-member result with frozen identity', async () => {
    const { server } = fakeServer();
    const obs = req().observation;
    const rating: RatingRequest = {
      ratingId: 'rating:a002:horizon', runId: 'fixture-run', agentId: 'a002', atMs: 3600000, endpoint: 'horizon',
      evidenceHash: hashCanonical(obs), observation: obs, rubricVersion: 'satisfaction-rubric-v1',
      levels: ['very dissatisfied', 'dissatisfied', 'neutral', 'satisfied', 'very satisfied'],
    };
    const id = server.enqueueWork('rating', rating);
    const { worker } = buildWorker(server.client('worker'));
    await worker.runOnce(); await worker.drain();
    const w = server.work.get(id)!;
    expect(w.status).toBe('ready');
    expect((w.result as { ratingId: string }).ratingId).toBe('rating:a002:horizon');
  });
});

describe('B-08 durable submission and lease safety', () => {
  it('lost completeWork acknowledgement retries the same command id, not the model call', async () => {
    const { server, clock } = fakeServer();
    const id = server.enqueueWork('decision', req());
    server.faults.dropAck = { completeWork: 2 };
    const provider = new CountingProvider();
    const { worker } = buildWorker(server.client('worker'), { provider, clock });
    await worker.runOnce();
    await pump(clock, worker.drain());
    expect(server.work.get(id)!.status).toBe('ready');
    expect(provider.calls).toBe(1);
    const completes = server.commandLog.filter((c) => c.name === 'completeWork');
    expect(new Set(completes.map((c) => c.commandId)).size).toBe(1);
    expect(completes.map((c) => c.applied)).toEqual([true, false, false]);
  });

  it('restart after a persisted response resubmits with the same command id and no new provider call', async () => {
    const { server, clock } = fakeServer();
    const id = server.enqueueWork('decision', req());
    server.faults.failBefore = { completeWork: 100 };
    const store = new MemoryStore();
    const p1 = new CountingProvider();
    const a = buildWorker(server.client('worker'), { provider: p1, clock, store });
    await a.worker.runOnce();
    await pump(clock, a.worker.drain());
    expect(server.work.get(id)!.status).toBe('leased');
    const entry = await a.journal.get(id);
    expect(entry!.state).toBe('submitting');
    // "Crash": a new process with the same durable store and identity.
    server.faults.failBefore = {};
    const p2 = new CountingProvider();
    const b = buildWorker(server.client('worker'), { provider: p2, clock, store, ids: new CounterIds('b') });
    const rec = await b.worker.recover();
    expect(rec.resubmitted).toBe(1);
    expect(server.work.get(id)!.status).toBe('ready');
    expect(p1.calls + p2.calls).toBe(1);
    const ids = server.commandLog.filter((c) => c.name === 'completeWork' && c.applied).map((c) => c.commandId);
    expect(ids).toEqual([entry!.completeCommandId]);
  });

  it('expired lease reclaimed by another worker: the old completion cannot overwrite the newer attempt', async () => {
    const { server, clock } = fakeServer();
    const id = server.enqueueWork('decision', req());
    let release!: () => void;
    const slow = new CountingProvider();
    slow.gate = new Promise((r) => { release = r; });
    const old = buildWorker(server.client('worker'), { provider: slow, clock, store: new MemoryStore() });
    await old.worker.runOnce();
    await settle();
    server.expireLease(id);
    const fresh = buildWorker(server.client('worker2'), { clock, store: new MemoryStore() });
    await fresh.worker.runOnce(); await fresh.worker.drain();
    expect(server.work.get(id)!.status).toBe('ready');
    const winner = structuredClone(server.work.get(id)!.result);
    expect(server.work.get(id)!.completions).toHaveLength(1);
    expect(server.work.get(id)!.completions[0]!.attempt).toBe(2);
    release();
    await old.worker.drain();
    expect(server.work.get(id)!.result).toEqual(winner);
    expect(server.work.get(id)!.completions).toHaveLength(1);
    expect((await old.journal.get(id))!.state).toBe('lost');
  });

  it('renewal loss aborts in-flight work and its late result is discarded', async () => {
    const { server, clock } = fakeServer();
    const id = server.enqueueWork('decision', req());
    let release!: () => void;
    const slow = new CountingProvider();
    slow.gate = new Promise((r) => { release = r; });
    const w = buildWorker(server.client('worker'), { provider: slow, clock });
    await w.worker.runOnce();
    await settle();
    server.expireLease(id);
    await w.worker.renewNow();
    release();
    await w.worker.drain();
    expect(server.work.get(id)!.completions).toHaveLength(0);
    expect((await w.journal.get(id))!.state).toBe('lost');
  });

  it('renewal extends a long job under a controllable clock', async () => {
    const { server, clock } = fakeServer();
    const id = server.enqueueWork('decision', req());
    let release!: () => void;
    const slow = new CountingProvider();
    slow.gate = new Promise((r) => { release = r; });
    const w = buildWorker(server.client('worker'), { provider: slow, clock, options: { leaseMs: 30_000 } });
    await w.worker.runOnce(); await settle();
    for (let i = 0; i < 5; i++) { clock.advance(20_000); await w.worker.renewNow(); }
    release();
    await w.worker.drain();
    expect(server.work.get(id)!.status).toBe('ready');
  });

  it('superseded work: completion is rejected and ignored', async () => {
    const { server, clock } = fakeServer();
    const id = server.enqueueWork('decision', req());
    let release!: () => void;
    const slow = new CountingProvider();
    slow.gate = new Promise((r) => { release = r; });
    const w = buildWorker(server.client('worker'), { provider: slow, clock });
    await w.worker.runOnce(); await settle();
    server.setStatus(id, 'superseded');
    release();
    await w.worker.drain();
    expect(server.work.get(id)!.status).toBe('superseded');
    expect((await w.journal.get(id))!.state).toBe('lost');
  });

  it('journal refuses an older attempt overwriting a newer one', async () => {
    const store = new MemoryStore();
    const { journal } = buildWorker(fakeServer().server.client('worker'), { store });
    const base = { workId: 'w1', kind: 'decision' as const, payloadHash: 'x', state: 'claimed' as const, callIds: [], result: null, completeCommandId: null, note: null, updatedAtEpochMs: 0 };
    expect(await journal.write({ ...base, lease: { workId: 'w1', attempt: 2, leaseToken: 'b', expiresAtEpochMs: 1, ownerIdentity: 'x' } })).toBe(true);
    expect(await journal.write({ ...base, lease: { workId: 'w1', attempt: 1, leaseToken: 'a', expiresAtEpochMs: 1, ownerIdentity: 'x' } })).toBe(false);
    expect((await journal.get('w1'))!.lease.attempt).toBe(2);
  });

  it('restart during a provider call relinquishes the claim and leaves the attempt as unknown usage', async () => {
    const { server, clock } = fakeServer();
    const id = server.enqueueWork('decision', req());
    const store = new MemoryStore();
    const hang: BehaviorProvider = Object.assign(new MockProvider(), { decide: () => new Promise<never>(() => undefined) });
    const a = buildWorker(server.client('worker'), { provider: hang, clock, store });
    await a.worker.runOnce(); await settle();
    expect((await a.journal.get(id))!.state).toBe('calling');
    const b = buildWorker(server.client('worker'), { clock, store, ids: new CounterIds('b') });
    await b.worker.recover();
    expect(server.work.get(id)!.status).toBe('pending');
    const totals = await b.ledger.totals();
    expect(totals.unknownCalls).toBe(1);
    expect(totals.calls).toBe(1);
    await b.worker.runOnce(); await b.worker.drain();
    expect(server.work.get(id)!.status).toBe('ready');
  });

  it('permanent provider errors fail visibly and stop provider-backed claims', async () => {
    const { server, clock } = fakeServer();
    const id1 = server.enqueueWork('decision', req());
    const auth: BehaviorProvider = Object.assign(new MockProvider(), { decide: async () => { throw new ProviderError('auth', 'HTTP 401', { status: 401 }); } });
    const w = buildWorker(server.client('worker'), { provider: auth, clock, options: { capacity: { behavior: 1, measurement: 1, text: 1, experiment: 0 } } });
    await w.worker.runOnce(); await w.worker.drain();
    expect(server.work.get(id1)!.status).toBe('failed');
    expect(server.work.get(id1)!.error!.retryable).toBe(false);
    const id2 = server.enqueueWork('decision', req());
    expect(await w.worker.runOnce()).toBe(0);
    expect(server.work.get(id2)!.status).toBe('pending');
    expect(w.worker.status().disabledKinds).toContain('decision');
  });
});

describe('graceful shutdown', () => {
  it('stops claiming, relinquishes unfinished work after the deadline, flushes and closes', async () => {
    const clock = new ManualClock();
    const { server } = fakeServer({}, clock);
    const id = server.enqueueWork('decision', req());
    const slow = new CountingProvider();
    slow.gate = new Promise(() => undefined);
    const w = buildWorker(server.client('worker'), { provider: slow, clock, options: { shutdownDeadlineMs: 1000 } });
    await w.worker.runOnce(); await settle();
    const report = await pump(clock, w.worker.shutdown());
    expect(report.relinquished).toEqual([id]);
    expect(server.work.get(id)!.status).toBe('pending');
    await expect(server.client('worker').query('capabilities', {})).resolves.toBeTruthy();
    await expect(w.worker.runOnce()).resolves.toBe(0);
  });

  it('status is machine-readable', async () => {
    const { server } = fakeServer();
    server.enqueueWork('decision', req());
    const w = buildWorker(server.client('worker'));
    await w.worker.runOnce(); await w.worker.drain();
    const s = w.worker.status();
    expect(s.schema).toBe('worker-status.v1');
    expect(s.outcomes['completed:decision']).toBe(1);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
