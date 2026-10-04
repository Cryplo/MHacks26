import { describe, expect, it } from 'vitest';
import type { Narrative, RatingRequest, RatingResult, ScenarioDraft } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../../src/core/canonical.ts';
import { DEFAULT_CROWD_300 } from '../../src/fixtures/crowds.ts';
import { RUBRICS, displayScore, summarizeTerminalRatings } from '../../src/measurements/rating.ts';
import { MockProvider } from '../../src/providers/mock.ts';
import type { ManualClock } from '../../src/runtime/clock.ts';
import { conformance } from '../helpers/fixtures.ts';
import { ScriptedJev } from '../helpers/providers.ts';
import { fakeServer } from '../helpers/runtime.ts';
import { appliedDecision, scenarioSetup } from '../helpers/scenario.ts';
import { buildWorker, pump } from '../helpers/worker.ts';

const levels = [...RUBRICS['satisfaction-rubric-v1']!.levels];
function ratingReq(agentId: string, over: Partial<RatingRequest> = {}): RatingRequest {
  const obs = structuredClone(conformance().decisionRequest.observation);
  obs.members.forEach((m, i) => { m.needs = { ...m.needs, fun: 20 + 30 * i, patience: 30 + 20 * i }; });
  return {
    ratingId: `rating:${agentId}:${over.endpoint ?? 'periodic'}`, runId: 'run-1', agentId, atMs: obs.atMs, endpoint: 'periodic',
    evidenceHash: hashCanonical(obs), observation: obs, rubricVersion: 'satisfaction-rubric-v1', levels, ...over,
  };
}
const WORKER_COMMANDS = new Set(['claimWork', 'renewWork', 'completeWork', 'failWork', 'recordProviderAttempt']);

async function runAll(_server: ReturnType<typeof fakeServer>['server'], w: ReturnType<typeof buildWorker<ManualClock>>) {
  for (let i = 0; i < 20; i++) {
    const n = await w.worker.runOnce();
    await pump(w.clock, w.worker.drain());
    if (n === 0) return;
  }
  throw new Error('work did not drain');
}

describe('B-13 ratings', () => {
  it('per-member frozen ratings answer exactly their request and never touch behavior', async () => {
    const { server } = fakeServer();
    const ids = ['a001', 'a002', 'a003'].map((a) => server.enqueueWork('rating', ratingReq(a)));
    const w = buildWorker(server.client('worker'));
    await runAll(server, w);
    const results = ids.map((id) => server.work.get(id)!);
    expect(results.map((r) => r.status)).toEqual(['ready', 'ready', 'ready']);
    const rs = results.map((r) => r.result as RatingResult);
    expect(rs.map((r) => r.ratingId)).toEqual(['rating:a001:periodic', 'rating:a002:periodic', 'rating:a003:periodic']);
    for (const r of rs) {
      expect(r.probabilities).toHaveLength(5);
      expect(r.scoreIndex).toBeGreaterThanOrEqual(0);
      expect(r.scoreIndex).toBeLessThanOrEqual(4);
      expect(r.source).toBe('mock');
      expect(r.rubricVersion).toBe('satisfaction-rubric-v1');
    }
    expect(new Set(rs.map((r) => JSON.stringify(r.probabilities))).size).toBeGreaterThan(1);
    const used = new Set(server.commandLog.filter((c) => c.identity === 'worker').map((c) => c.name));
    for (const n of used) expect(WORKER_COMMANDS.has(n)).toBe(true);
    expect([...server.work.values()].filter((x) => x.kind === 'decision')).toHaveLength(0);
  });

  it('rejects wrong member, wrong rubric levels and unknown rubric as INVALID_INPUT', async () => {
    const { server } = fakeServer();
    const bad = [
      server.enqueueWork('rating', ratingReq('a999')),
      server.enqueueWork('rating', ratingReq('a001', { levels: ['bad', 'ok', 'good'] })),
      server.enqueueWork('rating', ratingReq('a001', { rubricVersion: 'made-up' })),
      server.enqueueWork('rating', ratingReq('a001', { evidenceHash: 'nothex' })),
    ];
    const w = buildWorker(server.client('worker'));
    await runAll(server, w);
    for (const id of bad) {
      const rec = server.work.get(id)!;
      expect(rec.status).toBe('failed');
      expect(rec.error?.code).toBe('INVALID_INPUT');
    }
  });

  it('out-of-range provider scores are invalid (not cached, not clamped); fractional scores map to the nearest level', async () => {
    const { server } = fakeServer();
    const p = new ScriptedJev();
    let score: number = 7;
    p.rate = async () => ({ raw: new TextEncoder().encode('{}'), modelReturned: p.model, probabilities: [0, 0, 0.4, 0.6, 0], score, usage: p.usage, httpMs: 1 });
    const id = server.enqueueWork('rating', ratingReq('a001'));
    const w = buildWorker(server.client('worker'), { provider: p, inference: { maxAttempts: 1 } });
    await runAll(server, w);
    expect(server.work.get(id)!.status).not.toBe('ready');
    score = 2.6;
    const id2 = server.enqueueWork('rating', ratingReq('a002'));
    await runAll(server, w);
    expect((server.work.get(id2)!.result as RatingResult).scoreIndex).toBe(3);
    expect(displayScore(server.work.get(id2)!.result as RatingResult)).toBe(75);
  });

  it('terminal ratings after departure use the frozen snapshot; periodic and terminal are distinct jobs', async () => {
    const { server } = fakeServer();
    const periodic = ratingReq('a001');
    const termObs = structuredClone(periodic.observation);
    termObs.atMs = 30_000_000;
    termObs.currentActivity = 'departed';
    const terminal = ratingReq('a001', { endpoint: 'departure', atMs: 30_000_000, observation: termObs, evidenceHash: hashCanonical(termObs) });
    const a = server.enqueueWork('rating', periodic);
    const b = server.enqueueWork('rating', terminal);
    await runAll(server, buildWorker(server.client('worker')));
    const ra = server.work.get(a)!.result as RatingResult;
    const rb = server.work.get(b)!.result as RatingResult;
    expect(ra.ratingId).toBe('rating:a001:periodic');
    expect(rb.ratingId).toBe('rating:a001:departure');
    expect(rb.evidenceHash).toBe(terminal.evidenceHash);
    expect(rb.evidenceHash).not.toBe(ra.evidenceHash);
  });

  it('missing ratings are never imputed; null when none; zero is a real value', () => {
    const r = (scoreIndex: number) => ({ scoreIndex, probabilities: [0.2, 0.2, 0.2, 0.2, 0.2] });
    const some = summarizeTerminalRatings(['a', 'b', 'c', 'd'], new Map([['a', r(4)], ['c', r(0)]]));
    expect(some).toMatchObject({ value: 50, n: 2, denominator: 2, coverage: 0.5, complete: false });
    expect(some.missingReason).toMatch(/2 of 4 terminal ratings missing/);
    const none = summarizeTerminalRatings(['a', 'b'], new Map());
    expect(none).toMatchObject({ value: null, n: 0, denominator: null, coverage: 0, complete: false });
    const all = summarizeTerminalRatings(['a'], new Map([['a', r(0)]]));
    expect(all).toMatchObject({ value: 0, complete: true, missingReason: null });
  });
});

describe('text jobs through the worker (B-14/B-16 integration)', () => {
  it('parse_scenario returns a confirmation-required draft and issues no scenario commands', async () => {
    const { server } = fakeServer();
    const s = scenarioSetup();
    const ref = server.storeArtifact('operator', 'park', 'application/json', s.art.bytes, { runId: null, experimentId: null });
    const ctx = { ...s.context, park: { ...s.context.park, artifact: ref } };
    const id = server.enqueueWork('parse_scenario', { text: 'raise passes to $25 at 11am and move the taco stand', context: ctx });
    const stale = server.enqueueWork('parse_scenario', { text: 'close the comet', context: { ...ctx, park: { ...ctx.park, revision: 'fixture-0' } } });
    await runAll(server, buildWorker(server.client('worker')));
    const draft = server.work.get(id)!.result as ScenarioDraft;
    expect(draft.requiresConfirmation).toBe(true);
    expect(draft.events.map((e) => e.change)).toEqual([{ kind: 'pass_price', unitPriceCents: 2500 }]);
    expect(draft.unsupported).toHaveLength(1);
    expect(server.work.get(stale)!.error?.code).toBe('INVALID_INPUT');
    expect(server.work.get(stale)!.error?.message).toMatch(/stale or invalid scenario context/);
    expect(server.commandLog.some((c) => c.name === 'scheduleEvents')).toBe(false);
  });

  it('parse_crowd proposes; thought narrates once per evidence/member; report works offline', async () => {
    const { server } = fakeServer();
    const crowd = server.enqueueWork('parse_crowd', { text: 'fewer teens, more couples', current: DEFAULT_CROWD_300 });
    const ev = appliedDecision();
    const t1 = server.enqueueWork('thought', { evidence: ev, agentId: 'a002' });
    const t2 = server.enqueueWork('thought', { evidence: ev, agentId: 'a002' });
    const bad = server.enqueueWork('thought', { evidence: ev, agentId: 'a999' });
    const facts = { contractVersion: 'behavior.v1' as const, id: 'facts-run-1', asOfMs: 3_600_000, sourceHash: 'c'.repeat(64), quality: null, scope: { runId: 'run-1', experimentId: null }, facts: [] };
    const rep = server.enqueueWork('report', { facts });
    const w = buildWorker(server.client('worker'), { provider: new MockProvider() });
    await runAll(server, w);
    const proposal = server.work.get(crowd)!.result as { proposal: typeof DEFAULT_CROWD_300 };
    expect(proposal.proposal.shares.teens).toBeLessThan(DEFAULT_CROWD_300.shares.teens);
    const n1 = server.work.get(t1)!.result as Narrative;
    const n2 = server.work.get(t2)!.result as Narrative;
    expect(n1).toEqual(n2);
    expect(n1.label).toBe('narrated from state');
    expect(server.work.get(bad)!.error?.code).toBe('INVALID_INPUT');
    const report = server.work.get(rep)!.result as Narrative;
    expect(report.label).toBe('modeled-results report');
    expect(report.origin).toBe('template');
    expect(await w.store.list('narration/')).toHaveLength(1);
  });
});
