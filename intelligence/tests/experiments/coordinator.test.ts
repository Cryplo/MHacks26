/**
 * Coordinator tests on the ORCHESTRATION-ONLY fake runtime: run scripts and metrics are fixtures,
 * the worker uses the deterministic mock provider. These prove durability, fencing and reporting,
 * not park behaviour. Real-Engine A/A and A/B are in engine-adapter.test.ts (NOT RUN without the adapter).
 */
import { describe, expect, it } from 'vitest';
import type { ExperimentReport, FactBundle, Narrative } from '../../contract/behavior-v1.ts';
import type { ResponseTape } from '../../src/cache/response-cache.ts';
import { canonicalBytes, sha256Hex } from '../../src/core/canonical.ts';
import { readExperimentState } from '../../src/experiments/coordinator.ts';
import { scenarioDiff } from '../../src/experiments/preflight.ts';
import { validateReportShape } from '../../src/experiments/report.ts';
import { validateFactBundle, validateReportNarrative } from '../../src/reports/narrative.ts';
import { appliedAdvanceSteps, experimentWorld } from '../helpers/experiment.ts';
import type { WorldOptions } from '../helpers/experiment.ts';

const decode = <T>(b: Uint8Array): T => JSON.parse(new TextDecoder().decode(b)) as T;
const TOTAL_STEPS = 12;

async function finish(w: ReturnType<typeof experimentWorld>) {
  const st = await readExperimentState(w.coordinatorStore, w.spec.experimentId);
  const exp = w.server.experiments.get(w.spec.experimentId)!;
  const artifact = <T>(ref: { artifactId: string } | null | undefined) => (ref ? decode<T>(w.server.artifacts.get(ref.artifactId)!.bytes) : null);
  const report = artifact<ExperimentReport>(st?.artifacts.report);
  const facts = artifact<FactBundle>(st?.artifacts.facts);
  return { st, exp, report, facts, tape: artifact<ResponseTape>(st?.artifacts.tape), narrative: artifact<Narrative>(st?.artifacts.narrative) };
}

async function cleanRun(o: WorldOptions = {}) {
  const w = experimentWorld(o);
  await w.create();
  const c = w.makeCoordinator();
  await w.runCoordinator(c);
  return { w, c, ...(await finish(w)) };
}

const coordinatorCreates = (w: ReturnType<typeof experimentWorld>) =>
  [...w.server.receipts.entries()].filter(([k, v]) => k.startsWith('coordinator\u0000') && k.endsWith(':create') && v.receipt.ok).length;
const factValue = (f: FactBundle, id: string) => f.facts.find((x) => x.id === id)?.value;

describe('B-21 mock A/B pass price 1500 -> 2500 through the fake port (orchestration-only)', () => {
  it('completes every requested pair and reports the scripted revenue difference with labels', async () => {
    const r = await cleanRun();
    expect(r.st?.phase).toBe('done');
    expect(r.report!.status).toBe('complete');
    expect(r.report!.pairs.map((p) => [p.seed, p.status])).toEqual([['s1', 'complete'], ['s2', 'complete'], ['s3', 'complete']]);
    expect(r.report!.limitations.join(' ')).toMatch(/ORCHESTRATION-ONLY/);
    expect(r.report!.limitations.join(' ')).toMatch(/MOCK experiment/);
    expect(r.report!.exploratory).toBe(true);
    const rev = r.report!.summaries.find((s) => s.metricId === 'net_revenue_cents')!;
    expect(rev.pairCount).toBe(3);
    expect(rev.differences).toEqual([-1000, -1000, -1000]);
    expect(rev.mean).toBe(-1000);
    expect(rev.interval).toBeNull();
    for (const p of r.report!.pairs) {
      expect(p.aRunId).not.toBe(p.bRunId);
      expect(p.initialStateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(p.a!.measures.net_revenue_cents.value).toBe(6000);
      expect(p.b!.measures.net_revenue_cents.value).toBe(5000);
    }
    expect(new Set(r.report!.pairs.map((p) => p.populationHash)).size).toBe(3);
    expect(r.exp.reports.at(-1)!.status).toBe('complete');
    expect(r.exp.reports.map((x) => x.revision)).toEqual(r.exp.reports.map((_, i) => i + 1));
  });

  it('every child manifest differs only in the declared scenario; all decisions answered by the mock worker', async () => {
    const r = await cleanRun({ seeds: ['s1'] });
    const runs = [...r.w.server.runs.values()];
    expect(runs).toHaveLength(2);
    const [a, b] = runs.map((x) => x.manifest);
    expect({ ...a!, scenario: null, experiment: null }).toEqual({ ...b!, scenario: null, experiment: null });
    const d = scenarioDiff(a!.scenario, b!.scenario);
    expect(d.kinds).toEqual(['pass_price']);
    expect(d.changed).toHaveLength(1);
    const decisions = [...(r.w.server as unknown as { work: Map<string, { kind: string; status: string; lease: { ownerIdentity: string } | null }> }).work.values()].filter((x) => x.kind === 'decision');
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((x) => x.status === 'applied')).toBe(true);
    expect(r.report!.limitations.join(' ')).toMatch(/illustration/);
  });

  it('paired_t with n>=2 yields an interval and the documented assumptions', async () => {
    const r = await cleanRun({ spec: (s) => ({ ...s, analysis: 'paired_t' }) });
    const q = r.report!.summaries.find((s) => s.metricId === 'queue_minutes_per_guest')!;
    expect(q.pairCount).toBe(3);
    const rev = r.report!.summaries.find((s) => s.metricId === 'net_revenue_cents')!;
    expect(rev.interval).toEqual({ kind: 'paired_t_mean', lower: -1000, upper: -1000, level: 0.95 });
    expect(r.report!.limitations.join(' ')).toMatch(/paired/i);
  });
});

describe('B-18 fake A/A with frozen responses (orchestration-only)', () => {
  it('identical arms produce exactly zero deltas, identical final state, and B is served from the A responses', async () => {
    const r = await cleanRun({
      runIndependentIds: true,
      spec: (s) => ({ ...s, variant: structuredClone(s.baseline), changedLever: 'none', interventionLabel: 'A/A identical arms' }),
    });
    expect(r.report!.status).toBe('complete');
    for (const p of r.report!.pairs) {
      expect(Object.keys(p.deltas).length).toBeGreaterThan(5);
      for (const v of Object.values(p.deltas)) expect(v).toBe(0);
    }
    for (const s of r.report!.summaries) if (s.pairCount) { expect(s.mean).toBe(0); expect(s.min).toBe(0); expect(s.max).toBe(0); }
    const st = r.st!;
    for (const p of st.pairs) expect(p.arms.A.finalHash).toBe(p.arms.B.finalHash);
    expect(st.pairs[0]!.arms.A.quality!.behaviorCounts.mock).toBeGreaterThan(0);
    for (const p of st.pairs) {
      const a = p.arms.A.quality!.behaviorCounts;
      const b = p.arms.B.quality!.behaviorCounts;
      expect(b.mock).toBe(0);
      expect(b.cache).toBe(a.mock + a.cache);
    }
    expect(factValue(r.facts!, 'exp.diff')).toBe('none (A/A)');
    expect(r.report!.limitations.join(' ')).toMatch(/ORCHESTRATION-ONLY/);
  });
});

describe('B-17 durable resume, idempotent commands and fencing', () => {
  const PHASES = [
    'population:pair-s1', 'created:pair-s1:A', 'created:pair-s1:B', 'initial-hash:pair-s1',
    'advance:pair-s1:A:2', 'advance:pair-s1:A:12', 'measured:pair-s1:A', 'advance:pair-s1:B:7', 'measured:pair-s1:B',
    'pair-stored:pair-s1', 'population:pair-s2', 'advance:pair-s2:B:12', 'aggregate',
  ];

  it.each(PHASES)('crash at %s then restart: no duplicate runs or steps, same populations and hashes', async (phase) => {
    const clean = await cleanRun({ seeds: ['s1', 's2'] });
    let fired = 0;
    const w = experimentWorld({ seeds: ['s1', 's2'], faultAt: (p) => { if (p === phase && fired++ === 0) throw new Error(`injected crash at ${p}`); } });
    await w.create();
    await w.runCoordinator(w.makeCoordinator());
    expect(fired, `phase ${phase} was reached`).toBe(1);
    const mid = await readExperimentState(w.coordinatorStore, w.spec.experimentId);
    expect(mid?.phase).not.toBe('done');
    await w.clock.sleep(120_000);
    await w.runCoordinator(w.makeCoordinator(() => undefined));
    const r = await finish(w);
    expect(r.st?.phase).toBe('done');
    expect(r.report!.status).toBe('complete');
    expect(w.server.runs.size).toBe(4);
    expect(coordinatorCreates(w)).toBe(4);
    const steps = appliedAdvanceSteps(w.server);
    expect([...steps.values()]).toEqual([TOTAL_STEPS, TOTAL_STEPS, TOTAL_STEPS, TOTAL_STEPS]);
    for (const run of w.server.runs.values()) expect(run.step).toBe(TOTAL_STEPS);
    expect(r.report!.pairs.map((p) => p.populationHash)).toEqual(clean.report!.pairs.map((p) => p.populationHash));
    expect(r.report!.pairs.map((p) => p.initialStateHash)).toEqual(clean.report!.pairs.map((p) => p.initialStateHash));
    expect(r.report!.summaries).toEqual(clean.report!.summaries);
    expect(new Set([...w.server.artifacts.values()].filter((a) => a.ref.kind === 'population').map((a) => a.ref.sha256)).size).toBe(2);
  });

  it('warmup start: crash after the warmup checkpoint reuses it; arms start from the warmup hash', async () => {
    const warm = (s: Parameters<NonNullable<WorldOptions['spec']>>[0]) => ({ ...s, start: { kind: 'warmup' as const, toMs: 10_000, warmupScenario: { ...s.baseline, id: 'warmup', events: [] } } });
    let fired = 0;
    const w = experimentWorld({ seeds: ['s1'], spec: warm, faultAt: (p) => { if (p === 'warmup:pair-s1' && fired++ === 0) throw new Error('crash after warmup'); } });
    await w.create();
    await w.runCoordinator(w.makeCoordinator());
    expect(fired).toBe(1);
    await w.clock.sleep(120_000);
    await w.runCoordinator(w.makeCoordinator(() => undefined));
    const r = await finish(w);
    expect(r.report!.status).toBe('complete');
    expect(w.server.runs.size).toBe(3);
    const st = r.st!.pairs[0]!;
    expect(st.warmup!.hash).toBe(st.initialStateHash);
    expect(st.arms.A.initialHash).toBe(st.arms.B.initialHash);
    const checkpoints = [...w.server.artifacts.values()].filter((a) => a.ref.kind === 'checkpoint' && a.scope.runId === st.warmup!.run.runId);
    expect(checkpoints).toHaveLength(1);
    for (const run of w.server.runs.values()) {
      if (run.runId === st.warmup!.run.runId) { expect(run.step).toBe(2); continue; }
      expect(run.startStep).toBe(2);
      expect(appliedAdvanceSteps(w.server).get(run.runId)).toBe(TOTAL_STEPS - 2);
    }
  });

  it('a superseded coordinator (work lease taken over) cannot advance, record progress or overwrite state', async () => {
    let release!: () => void;
    let reached!: () => void;
    const hung = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let fired = 0;
    const w = experimentWorld({ seeds: ['s1'] });
    const workId = await w.create();
    const c1 = w.makeCoordinator(async (p) => { if (p === 'advance:pair-s1:A:7' && fired++ === 0) { reached(); await gate; } });
    const n = await c1.worker.runOnce();
    expect(n).toBe(1);
    const c1Done = c1.worker.drain();
    await hung;
    w.server.expireLease(workId);
    const c2 = w.makeCoordinator(() => undefined);
    await w.runCoordinator(c2);
    const after = await finish(w);
    expect(after.st?.phase).toBe('done');
    const reportsBefore = after.exp.reports.length;
    const stateBefore = w.coordinatorStore.data.get(`experiments/${w.spec.experimentId}/state`);
    release();
    await c1Done;
    expect(w.server.experiments.get(w.spec.experimentId)!.reports.length).toBe(reportsBefore);
    expect(w.coordinatorStore.data.get(`experiments/${w.spec.experimentId}/state`)).toEqual(stateBefore);
    expect(w.server.runs.size).toBe(2);
    expect([...appliedAdvanceSteps(w.server).values()]).toEqual([TOTAL_STEPS, TOTAL_STEPS]);
    const runA = [...w.server.runs.values()][0]!;
    expect(runA.driverEpoch).toBeGreaterThanOrEqual(2);
    expect(after.report!.status).toBe('complete');
  });

  it('a different spec under the same experiment id is refused', async () => {
    const w = experimentWorld({ seeds: ['s1'] });
    await w.create();
    await w.runCoordinator(w.makeCoordinator());
    const st = (await readExperimentState(w.coordinatorStore, w.spec.experimentId))!;
    await w.coordinatorStore.put(`experiments/${w.spec.experimentId}/state`, canonicalBytes({ ...st, specHash: '0'.repeat(64), phase: 'pairs' }));
    w.server.enqueueWork('experiment', w.spec, { runId: null, experimentId: w.spec.experimentId });
    const c = w.makeCoordinator();
    await w.runCoordinator(c);
    expect(w.logger.entries.some((e) => e.event === 'worker.invalid_request' && String(e.fields?.message).includes('different spec'))).toBe(true);
  });
});

describe('B-19 paired design: missing arms, coverage and degraded provenance', () => {
  it('a failed arm fails its pair; all requested pairs stay in the report and denominators shrink', async () => {
    const r = await cleanRun({ failDecisions: (m) => m.experiment?.arm === 'B' && m.replicateSeed === 's2' });
    expect(r.report!.status).toBe('incomplete');
    expect(r.report!.pairs).toHaveLength(3);
    const s2 = r.report!.pairs.find((p) => p.seed === 's2')!;
    expect(s2.status).toBe('failed');
    expect(s2.reasons.join(' ')).toMatch(/B: run failed/);
    expect(r.report!.completePairs).toBe(2);
    for (const s of r.report!.summaries) if (s.metricId === 'net_revenue_cents') expect(s.pairCount).toBe(2);
    expect(factValue(r.facts!, 'pair.pair-s2.status')).toBe('failed');
    expect(factValue(r.facts!, 'exp.complete_pairs')).toBe(2);
    expect(r.report!.limitations.join(' ')).toMatch(/not complete/);
  });

  it('missing terminal ratings make satisfaction incomplete for that pair while revenue still counts', async () => {
    const r = await cleanRun({
      breakRating: (m) => m.experiment?.arm === 'B' && m.replicateSeed === 's1',
      spec: (s) => ({ ...s, operationBudgetMs: 300_000 }),
    });
    const s1 = r.report!.pairs.find((p) => p.seed === 's1')!;
    expect(s1.status).toBe('complete');
    expect(s1.b!.measures.satisfaction_0_100.complete).toBe(false);
    expect(s1.b!.measures.satisfaction_0_100.coverage).toBeCloseTo(2 / 3, 10);
    expect(s1.reasons.join(' ')).toMatch(/satisfaction_0_100/);
    const sum = (id: string) => r.report!.summaries.find((s) => s.metricId === id)!;
    expect(sum('satisfaction_0_100').pairCount).toBe(2);
    expect(sum('net_revenue_cents').pairCount).toBe(3);
    expect(sum('abandonment_rate')).toMatchObject({ pairCount: 0, mean: null, min: null, max: null, sampleSd: null, interval: null });
  });

  it('mock provenance in a real-provider experiment degrades every pair and nothing is aggregated', async () => {
    const r = await cleanRun({ config: { mode: 'experiment' } });
    expect(r.report!.pairs.map((p) => p.status)).toEqual(['degraded', 'degraded', 'degraded']);
    expect(r.report!.pairs[1]!.reasons.join(' ')).toMatch(/mock\/fallback-origin responses/);
    expect(r.report!.completePairs).toBe(0);
    expect(r.report!.summaries.every((s) => s.pairCount === 0 && s.mean === null)).toBe(true);
    expect(factValue(r.facts!, 'delta.net_revenue_cents.mean')).toBe('unavailable');
    expect(r.report!.limitations.join(' ')).toMatch(/Mock provenance/);
  });

  it('preflight failure (bundled change mislabeled) fails all pairs without creating runs', async () => {
    const w = experimentWorld({
      spec: (s) => ({ ...s, variant: { ...s.variant, events: [...s.variant.events, { id: 'n1', atMs: 20_000, order: 0, change: { kind: 'notice', placeId: null, text: 'Hello' } as never }] } }),
    });
    await w.create();
    await w.runCoordinator(w.makeCoordinator());
    expect(w.server.runs.size).toBe(0);
    const exp = w.server.experiments.get(w.spec.experimentId)!;
    expect(exp.reports.at(-1)!.pairs.every((p) => p.status === 'failed')).toBe(true);
    expect(exp.reports.at(-1)!.limitations.join(' ')).toMatch(/Preflight/);
  });
});

describe('B-24 report artifacts, facts and response tape', () => {
  it('artifacts are hash-addressed and consistent; every number is a fact with unit, denominator and scope', async () => {
    const r = await cleanRun();
    const st = r.st!;
    for (const ref of [st.artifacts.report, st.artifacts.facts, st.artifacts.tape, st.artifacts.narrative]) {
      const a = r.w.server.artifacts.get(ref!.artifactId)!;
      expect(sha256Hex(a.bytes)).toBe(ref!.sha256);
      expect(a.scope.experimentId).toBe(r.w.spec.experimentId);
    }
    expect(validateReportShape(r.report!)).toEqual([]);
    expect(r.report!.facts?.sha256).toBe(st.artifacts.facts!.sha256);
    expect(r.report!.responseTape?.sha256).toBe(st.artifacts.tape!.sha256);
    expect(validateFactBundle(r.facts!)).toEqual([]);
    expect(factValue(r.facts!, 'provenance.response_tape_sha256')).toBe(st.artifacts.tape!.sha256);
    expect(factValue(r.facts!, 'delta.net_revenue_cents.mean')).toBe(-1000);
    expect(factValue(r.facts!, 'exp.changed_lever')).toBe('pass_price');
    expect(String(factValue(r.facts!, 'exp.diff'))).toMatch(/1500.*2500/);
    for (const f of r.facts!.facts) {
      expect(f.unit.length).toBeGreaterThan(0);
      expect(f.denominator.length).toBeGreaterThan(0);
      if (f.id.startsWith('pair.') && /\.(a|b)\./.test(f.id)) expect(f.scope.runId).toMatch(/^run/);
    }
    const tapeRequests = new Set(r.tape!.entries.flatMap((e) => e.consumers));
    const decisionIds = [...r.w.server.runs.values()].flatMap((run) => run.appliedDecisions.map((d) => d.requestId));
    for (const id of decisionIds) expect(tapeRequests.has(id)).toBe(true);
    expect(validateReportNarrative(r.narrative!, r.facts!)).toEqual([]);
    expect(r.narrative!.label).toBe('modeled-results report');
    expect(r.narrative!.sections.map((s) => s.heading)).toEqual(['Design', 'Observed in simulation', 'Modeled experience and ratings', 'Pairs', 'Provenance', 'Limitations', 'Proposed next experiment']);
    const observed = r.narrative!.sections[1]!.segments;
    expect(observed.some((s) => s.kind === 'fact' && s.factId === 'delta.net_revenue_cents.mean')).toBe(true);
    expect(observed.some((s) => s.kind === 'fact' && s.factId.startsWith('delta.satisfaction'))).toBe(false);
    for (const s of r.narrative!.sections) for (const g of s.segments) if (g.kind === 'text') expect(g.text).not.toMatch(/\d/);
    const pairFacts = r.facts!.facts.filter((f) => f.id.startsWith('pair.pair-s1.a.'));
    expect(pairFacts).toHaveLength(11);
  });

  it('re-running finalize after a crash reproduces byte-identical facts, narrative and tape', async () => {
    const clean = await cleanRun({ seeds: ['s1'] });
    let fired = 0;
    const w = experimentWorld({ seeds: ['s1'], faultAt: (p) => { if (p === 'aggregate' && fired++ === 0) throw new Error('crash'); } });
    await w.create();
    await w.runCoordinator(w.makeCoordinator());
    await w.clock.sleep(120_000);
    await w.runCoordinator(w.makeCoordinator(() => undefined));
    const r = await finish(w);
    expect(r.st!.artifacts.facts!.sha256).toBe(clean.st!.artifacts.facts!.sha256);
    expect(r.st!.artifacts.tape!.sha256).toBe(clean.st!.artifacts.tape!.sha256);
    expect(r.st!.artifacts.narrative!.sha256).toBe(clean.st!.artifacts.narrative!.sha256);
  });
});

describe('B-11 experiment executor vs behavior work', () => {
  it('the coordinator never claims behavior work; a separate worker answers every decision', async () => {
    const r = await cleanRun({ seeds: ['s1'] });
    const work = [...(r.w.server as unknown as { work: Map<string, { kind: string; lease: { ownerIdentity: string } | null }> }).work.values()];
    for (const x of work) {
      if (x.kind === 'experiment') expect(x.lease?.ownerIdentity).toBe('coordinator');
      else expect(x.lease?.ownerIdentity ?? 'worker').toBe('worker');
    }
    const s = r.c.worker.status();
    expect(s.capacity).toMatchObject({ behavior: 0, measurement: 0, text: 0, experiment: 1 });
    expect(s.inflight).toMatchObject({ behavior: 0, measurement: 0, text: 0, experiment: 0 });
    expect(s.inference.providerCalls).toBe(0);
    expect(r.w.worker.worker.status().outcomes['completed:decision']).toBeGreaterThan(0);
  });
});
