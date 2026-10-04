/**
 * FIXTURE fact bundles, narratives, heatmaps and experiment reports. Values come from the
 * scripted scene and are labeled Fixture; they are not experimental outcomes.
 */
import type {
  AppliedDecision, ExperimentReport, ExperimentSpec, Fact, FactBundle, HeatLayer, Heatmap, Id, MetricId, MetricSnapshot,
  Narrative, PairResult, PairedSummary, Quality,
} from '../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../contract/behavior-v1';
import { canonicalJson } from '../domain/canonical';
import { METRICS, METRIC_ORDER } from '../domain/metrics';
import { metricsAt, poseAt, type Scene } from './scene';
import { sha256Sync } from './sha256';

export const fixtureHash = (v: unknown) => sha256Sync(canonicalJson(v));

const LIMITS = [
  'Fixture data: a scripted choreography with a mock policy, not Engine simulation and not Jev.',
  'Synthetic park and synthetic guests; not calibrated to real visitors.',
];

export function runFactBundle(scene: Scene, runId: Id, m: MetricSnapshot, quality: Quality): FactBundle {
  const facts: Fact[] = METRIC_ORDER.map((id) => {
    const v = m.measures[id];
    return {
      id: `fact:${runId}:${id}`, label: METRICS[id].label, value: v.value === null ? 'not available' : v.value,
      unit: v.unit, denominator: METRICS[id].denominator, scope: { runId, experimentId: null }, sourceEventIds: [],
      metricId: id, limitations: [...(v.coverage < 1 ? [`coverage ${(v.coverage * 100).toFixed(0)}%`] : []), ...(v.complete ? [] : ['run not complete'])],
    };
  });
  const passes = scene.events.filter((e) => e.kind === 'purchase' && e.atMs <= m.simMs && (e.details as { productId?: string }).productId === 'harbor_pass');
  facts.push({
    id: `fact:${runId}:pass_purchases`, label: 'Harbor Pass purchases', value: passes.reduce((s, e) => s + (((e.details as { quantity?: number }).quantity) ?? 0), 0),
    unit: 'passes', denominator: 'Count (no denominator).', scope: { runId, experimentId: null },
    sourceEventIds: passes.slice(0, 20).map((e) => e.eventId), metricId: null, limitations: [],
  });
  facts.push({
    id: `fact:${runId}:admitted`, label: 'Admitted guests', value: m.admittedGuests, unit: 'guests', denominator: 'Count.',
    scope: { runId, experimentId: null }, sourceEventIds: [], metricId: null, limitations: [],
  });
  return {
    contractVersion: CONTRACT_VERSION, id: `facts:${runId}:${m.simMs}`, asOfMs: m.simMs, sourceHash: fixtureHash(m),
    facts, quality, scope: { runId, experimentId: null },
  };
}

export function reportNarrative(bundle: FactBundle, runOrExperiment: Id): Narrative {
  const seg = (text: string) => ({ kind: 'text' as const, text });
  const fact = (suffix: string) => {
    const id = bundle.facts.find((x) => x.id.endsWith(suffix))?.id;
    return id ? [{ kind: 'fact' as const, factId: id }] : [];
  };
  const exp = bundle.scope.experimentId !== null;
  return {
    id: `narrative:${runOrExperiment}:${bundle.asOfMs}`, evidenceHash: fixtureHash(bundle), origin: 'template', label: 'modeled-results report',
    sections: exp
      ? [{ heading: 'What was compared', segments: [seg('Paired runs changed only the Harbor Pass price. Mean B minus A net revenue: '), ...fact(':delta:net_revenue_cents'), seg('. Mean satisfaction difference: '), ...fact(':delta:satisfaction_0_100'), seg('.')] },
        { heading: 'How to read this', segments: [seg('Values are descriptive spreads across the listed seed pairs, not confidence intervals. Incomplete pairs are excluded from summaries and listed separately.')] }]
      : [{ heading: 'Run summary', segments: [seg('Admitted guests: '), ...fact(':admitted'), seg('. Net ancillary revenue: '), ...fact(':net_revenue_cents'), seg(', or '), ...fact(':revenue_per_guest_cents'), seg(' per admitted guest. Harbor Pass purchases: '), ...fact(':pass_purchases'), seg('.')] },
        { heading: 'Guest experience', segments: [seg('Queue minutes per guest: '), ...fact(':queue_minutes_per_guest'), seg('. Synthetic satisfaction (available cases): '), ...fact(':satisfaction_0_100'), seg('.')] }],
    limitations: [...LIMITS, 'Template narrative (fixture); numbers are resolved from the fact bundle by code.'],
  };
}

export function thoughtNarrative(e: AppliedDecision, agentId: Id): Narrative {
  const chosen = e.request.options.find((o) => o.id === e.chosenOptionId);
  const p = e.appliedProbabilities.find((x) => x.optionId === e.chosenOptionId)?.probability ?? 0;
  const lead = e.request.agentIds[0] === agentId ? 'This guest\'s group' : 'This guest\'s group (decided together)';
  return {
    id: `thought:${e.evidenceId}:${agentId}`, evidenceHash: fixtureHash(e), origin: 'template', label: 'narrated from state',
    sections: [{ heading: 'From the recorded state', segments: [{ kind: 'text', text:
      `${lead} faced a "${e.request.moment.replace('_', ' ')}" moment with ${e.request.options.length} options. The recorded draw selected "${chosen?.label ?? e.chosenOptionId}" (assigned probability ${(p * 100).toFixed(1)}%). Outcome: ${e.outcome === 'committed' ? 'committed' : `failed (${e.failureReason ?? 'precondition'})`}.` }] }],
    limitations: ['Narrated from stored state by a template; not recovered private reasoning.', 'Fixture: probabilities come from a scripted mock policy.'],
  };
}

export function heatmapFor(scene: Scene, runId: Id, layer: HeatLayer, fromMs: number, toMs: number, bumpEnabled: boolean): Heatmap {
  const { width, height, cellM } = scene.park.grid;
  const values = new Array<number>(width * height).fill(0);
  const add = (xM: number, yM: number, v: number) => {
    const col = Math.floor(xM / cellM); const row = Math.floor(yM / cellM);
    if (col >= 0 && row >= 0 && col < width && row < height) values[row * width + col]! += v;
  };
  let unit: string; let denominator: string;
  if (layer === 'waiting_person_minutes') {
    unit = 'person-minutes'; denominator = 'Sum over the window (no denominator); sampled every 30 s of queueing';
    for (let t = Math.ceil(fromMs / 30_000) * 30_000; t < toMs; t += 30_000) {
      for (const p of scene.population.personas) {
        const pose = poseAt(scene, p.agentId, t);
        if (pose.present && pose.state === 'queueing') add(pose.position.xM, pose.position.yM, 0.5);
      }
    }
  } else if (layer === 'spending_cents') {
    unit = 'cents'; denominator = 'Sum of purchase amounts at the point of sale (no denominator)';
    for (const e of scene.events) if (e.kind === 'purchase' && e.atMs >= fromMs && e.atMs < toMs && e.position) add(e.position.xM, e.position.yM, e.amountCents ?? 0);
  } else if (layer === 'negative_experience') {
    unit = 'modeled experience points'; denominator = 'Sum of negative modeled-experience contributions assigned by the model (no denominator)';
    for (const e of scene.events) if (e.atMs >= fromMs && e.atMs < toMs && e.position && (e.experienceDelta ?? 0) < 0) add(e.position.xM, e.position.yM, -(e.experienceDelta ?? 0) * e.agentIds.length);
  } else if (layer === 'early_departures') {
    unit = 'guests'; denominator = 'Count of early-departing guests at their exit point';
    for (const d of scene.departures) if (d.early && d.t >= fromMs && d.t < toMs) { const ex = scene.geo.places.get('main_exit')!.entrance; add(ex.xM, ex.yM, d.n); }
  } else {
    unit = 'episodes'; denominator = bumpEnabled ? 'Count' : 'Bump reactions are not enabled in this run';
  }
  return { runId, layer, fromMs, toMs, cellM, width, height, values, total: values.reduce((a, b) => a + b, 0), unit, denominator, complete: true };
}

/** Fixture experiment report built from scripted A/B scenes (values are NOT outcomes). */
export function experimentReport(spec: ExperimentSpec, pairs: { seed: string; a: Scene | null; b: Scene | null; status: PairResult['status']; reasons: string[] }[],
  revision: number, runIds: (seed: string, arm: 'A' | 'B') => Id): ExperimentReport {
  const results: PairResult[] = pairs.map((p, i) => {
    const a = p.a ? metricsAt(p.a, runIds(p.seed, 'A'), Math.min(spec.config.horizonMs, p.a.horizonMs), 1) : null;
    const b = p.b ? metricsAt(p.b, runIds(p.seed, 'B'), Math.min(spec.config.horizonMs, p.b.horizonMs), 1) : null;
    const deltas: Partial<Record<MetricId, number>> = {};
    if (a && b && p.status === 'complete') {
      for (const id of METRIC_ORDER) {
        const av = a.measures[id].value; const bv = b.measures[id].value;
        if (av !== null && bv !== null) deltas[id] = bv - av;
      }
    }
    return {
      pairId: `pair-${i + 1}`, seed: p.seed, populationHash: fixtureHash({ seed: p.seed, crowd: spec.crowd }), initialStateHash: null,
      aRunId: p.a ? runIds(p.seed, 'A') : null, bRunId: p.b ? runIds(p.seed, 'B') : null,
      status: p.status, reasons: p.reasons, a, b, deltas,
    };
  });
  const complete = results.filter((r) => r.status === 'complete');
  const summaries: PairedSummary[] = METRIC_ORDER.map((id) => {
    const diffs = complete.map((r) => r.deltas[id]).filter((d): d is number => d !== undefined);
    const n = diffs.length;
    const mean = n ? diffs.reduce((s, d) => s + d, 0) / n : null;
    const sd = n > 1 && mean !== null ? Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1)) : null;
    return { metricId: id, pairCount: n, differences: diffs, mean, min: n ? Math.min(...diffs) : null, max: n ? Math.max(...diffs) : null, sampleSd: sd, interval: null };
  });
  const done = results.every((r) => r.status !== 'pending' && r.status !== 'running');
  return {
    spec, revision, status: !done ? 'running' : complete.length === results.length ? 'complete' : 'incomplete', pairs: results, summaries,
    requestedPairs: spec.seeds.length, completePairs: complete.length, exploratory: true,
    limitations: [...LIMITS, 'Descriptive paired differences (B minus A); min/max are spread, not confidence bounds.', 'Mock policy outcomes are labeled Mock and are not a real-Jev comparison.'],
    facts: null, responseTape: null,
  };
}

export function experimentFactBundle(report: ExperimentReport, experimentId: Id): FactBundle {
  const facts: Fact[] = report.summaries.filter((s) => s.mean !== null).map((s) => ({
    id: `fact:${experimentId}:delta:${s.metricId}`, label: `Mean B-A ${METRICS[s.metricId].label}`, value: s.mean!,
    unit: report.pairs.find((p) => p.a)?.a?.measures[s.metricId].unit ?? '', denominator: `${s.pairCount} complete pair(s)`,
    scope: { runId: null, experimentId }, sourceEventIds: [], metricId: s.metricId,
    limitations: ['Descriptive mean of paired differences; not a confidence interval.'],
  }));
  return { contractVersion: CONTRACT_VERSION, id: `facts:${experimentId}:${report.revision}`, asOfMs: report.spec.config.horizonMs,
    sourceHash: fixtureHash(report), facts, quality: null, scope: { runId: null, experimentId } };
}
