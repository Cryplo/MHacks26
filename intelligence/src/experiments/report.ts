import type {
  ExperimentReport, ExperimentSpec, Fact, FactBundle, MetricId, MetricSnapshot, MetricValue, PairResult, PairedSummary, Quality, Scope, Source,
} from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';
import { METRIC_IDS } from '../core/validate.ts';
import type { UsageTotals } from '../worker/usage.ts';
import { scenarioDiff } from './preflight.ts';
import { ANALYSIS_VERSION, PAIRED_T_ASSUMPTIONS, pairedSummary } from './stats.ts';

export const REPORT_FACTS_VERSION = 'experiment-facts-v1';

/** B - A for every metric where both arms report a value. A true zero difference is kept. */
export function pairDeltas(a: MetricSnapshot | null, b: MetricSnapshot | null): PairResult['deltas'] {
  const out: PairResult['deltas'] = {};
  if (!a || !b) return out;
  for (const id of METRIC_IDS) {
    const va = a.measures[id]?.value ?? null;
    const vb = b.measures[id]?.value ?? null;
    if (va !== null && vb !== null) out[id] = vb - va;
  }
  return out;
}

/** A pair contributes to a metric only when the pair is complete and both arms' measures are complete. */
export function metricEligible(p: PairResult, id: MetricId): boolean {
  if (p.status !== 'complete' || !p.a || !p.b) return false;
  const ma = p.a.measures[id];
  const mb = p.b.measures[id];
  return !!ma && !!mb && ma.complete && mb.complete && ma.value !== null && mb.value !== null && p.deltas[id] !== undefined;
}

export function summarize(spec: ExperimentSpec, pairs: PairResult[]): PairedSummary[] {
  return METRIC_IDS.map((id) => pairedSummary(id, pairs.filter((p) => metricEligible(p, id)).map((p) => p.deltas[id]!), spec.analysis, spec.alpha));
}

export type ReportContext = {
  runtime: 'engine' | 'fixture-orchestration-only';
  sources: Record<Source, number>;
  usage: UsageTotals | null;
};

export function experimentLimitations(spec: ExperimentSpec, pairs: PairResult[], ctx: ReportContext): string[] {
  const l: string[] = [];
  if (ctx.runtime === 'fixture-orchestration-only') l.push('ORCHESTRATION-ONLY: runs used the scripted fake runtime; metrics are scripted fixtures, not simulated outcomes.');
  if (spec.config.mode === 'mock') l.push('MOCK experiment: deterministic mock policy; an infrastructure demonstration, not a behavioral or real-provider result.');
  const complete = pairs.filter((p) => p.status === 'complete').length;
  if (spec.analysis === 'paired_descriptive') l.push('Exploratory descriptive results: individual differences with mean, min, max and sample SD; min/max is not a confidence interval.');
  else l.push(...PAIRED_T_ASSUMPTIONS);
  if (complete <= 1) l.push('At most one complete pair: an illustration, not a comparison.');
  if (complete < pairs.length) l.push('Some requested pairs are not complete; they are listed with reasons and excluded from aggregate denominators.');
  l.push('Paired whole-park differences (B - A); guests and ride episodes are not independent replicates.');
  l.push('Satisfaction is a synthetic rubric rating, available-case, never imputed.');
  if (ctx.sources.fallback > 0) l.push('Fallback decisions were applied in at least one arm.');
  if (spec.config.mode === 'experiment' && ctx.sources.mock > 0) l.push('Mock provenance appeared in a real-provider experiment.');
  return l;
}

export function buildReport(spec: ExperimentSpec, pairs: PairResult[], revision: number, ctx: ReportContext, refs: { facts: ExperimentReport['facts']; responseTape: ExperimentReport['responseTape'] }, final: boolean): ExperimentReport {
  const completePairs = pairs.filter((p) => p.status === 'complete').length;
  const summaries = summarize(spec, pairs);
  const allDone = pairs.every((p) => p.status !== 'pending' && p.status !== 'running');
  return {
    spec, revision, status: !final || !allDone ? 'running' : completePairs === spec.seeds.length ? 'complete' : 'incomplete',
    pairs, summaries, requestedPairs: spec.seeds.length, completePairs,
    exploratory: spec.analysis === 'paired_descriptive' || completePairs < 2,
    limitations: experimentLimitations(spec, pairs, ctx), facts: refs.facts, responseTape: refs.responseTape,
  };
}

const UNIT_LABEL: Record<MetricValue['unit'], string> = { cents: 'cents', score: 'score points', minutes: 'minutes', ratio: 'ratio points', guests: 'guests' };

function metricUnit(pairs: PairResult[], id: MetricId): MetricValue['unit'] {
  for (const p of pairs) { const m = p.a?.measures[id] ?? p.b?.measures[id]; if (m) return m.unit; }
  return id.endsWith('_cents') ? 'cents' : id.includes('satisfaction') ? 'score' : id.includes('minutes') ? 'minutes' : id === 'early_departures' ? 'guests' : 'ratio';
}

/**
 * Experiment fact bundle. Every number is a code-computed fact with unit, denominator and scope;
 * per-pair arm values trace to the accepted MetricSnapshot (run id + revision).
 */
export function buildExperimentFacts(report: ExperimentReport, ctx: ReportContext & { responseTapeSha256: string | null; diffSummary?: string }): FactBundle {
  const spec = report.spec;
  const expScope: Scope = { runId: null, experimentId: spec.experimentId };
  const facts: Fact[] = [];
  const f = (id: string, label: string, value: number | string, unit: string, denominator: string, scope: Scope = expScope, metricId: MetricId | null = null, limitations: string[] = []) =>
    facts.push({ id, label, value, unit, denominator, scope, sourceEventIds: [], metricId, limitations });
  const tag = ctx.runtime === 'fixture-orchestration-only' ? ['orchestration-only fixture metric'] : [];
  f('exp.requested_pairs', 'Requested pairs (declared seeds)', report.requestedPairs, 'pairs', 'declared seeds');
  f('exp.complete_pairs', 'Complete pairs', report.completePairs, 'pairs', `${report.requestedPairs} requested pairs`);
  for (const status of ['complete', 'incomplete', 'degraded', 'failed', 'pending', 'running'] as const) {
    const n = report.pairs.filter((p) => p.status === status).length;
    if (n) f(`exp.pairs.${status}`, `Pairs with status ${status}`, n, 'pairs', `${report.requestedPairs} requested pairs`);
  }
  f('exp.analysis', 'Predeclared analysis', `${spec.analysis} (${ANALYSIS_VERSION})`, 'label', 'none');
  f('exp.intervention', 'Declared intervention', spec.interventionLabel, 'label', 'none');
  f('exp.changed_lever', 'Changed lever', spec.changedLever, 'label', 'none');
  const diff = scenarioDiff(spec.baseline, spec.variant);
  f('exp.diff', 'Exact scenario diff (variant vs baseline)', ctx.diffSummary ?? diffText(diff), 'label', 'none');
  for (const s of report.summaries) {
    const unit = UNIT_LABEL[metricUnit(report.pairs, s.metricId)];
    const denom = `${s.pairCount} complete eligible pairs of ${report.requestedPairs} requested`;
    const base = `delta.${s.metricId}`;
    f(`${base}.n`, `Eligible pairs for ${s.metricId}`, s.pairCount, 'pairs', `${report.requestedPairs} requested pairs`, expScope, s.metricId);
    if (s.mean === null) { f(`${base}.mean`, `Mean B - A ${s.metricId}`, 'unavailable', unit, denom, expScope, s.metricId, ['no complete eligible pair']); continue; }
    f(`${base}.mean`, `Mean B - A ${s.metricId}`, s.mean, unit, denom, expScope, s.metricId, tag);
    f(`${base}.min`, `Minimum B - A ${s.metricId}`, s.min!, unit, denom, expScope, s.metricId, tag);
    f(`${base}.max`, `Maximum B - A ${s.metricId}`, s.max!, unit, denom, expScope, s.metricId, tag);
    f(`${base}.sample_sd`, `Sample SD of B - A ${s.metricId}`, s.sampleSd ?? 'unavailable (n < 2)', unit, denom, expScope, s.metricId, tag);
    if (s.interval) {
      f(`${base}.t95_lower`, `Paired-t 95% lower bound ${s.metricId}`, s.interval.lower, unit, denom, expScope, s.metricId, [...tag, ...PAIRED_T_ASSUMPTIONS]);
      f(`${base}.t95_upper`, `Paired-t 95% upper bound ${s.metricId}`, s.interval.upper, unit, denom, expScope, s.metricId, [...tag, ...PAIRED_T_ASSUMPTIONS]);
    }
  }
  for (const p of report.pairs) {
    const pid = p.pairId;
    f(`pair.${pid}.status`, `Pair ${p.seed} status`, p.status, 'label', 'none', expScope, null, p.reasons);
    f(`pair.${pid}.population_hash`, `Pair ${p.seed} population manifest hash`, p.populationHash, 'sha256', 'none');
    if (p.initialStateHash) f(`pair.${pid}.initial_state_hash`, `Pair ${p.seed} shared initial state hash`, p.initialStateHash, 'sha256', 'none');
    for (const [arm, snap, runId] of [['a', p.a, p.aRunId], ['b', p.b, p.bRunId]] as const) {
      if (!snap || !runId) continue;
      for (const id of METRIC_IDS) {
        const m = snap.measures[id];
        if (!m) continue;
        const lim = [...tag, ...(m.complete ? [] : [`incomplete: ${m.missingReason ?? 'reason not given'}`])];
        f(`pair.${pid}.${arm}.${id}`, `Arm ${arm.toUpperCase()} ${id} (run ${runId}, snapshot rev ${snap.revision})`, m.value ?? 'unavailable', UNIT_LABEL[m.unit],
          `n=${m.n}; denominator=${m.denominator ?? 'none'}; coverage=${m.coverage}`, { runId, experimentId: spec.experimentId }, id, lim);
      }
    }
    for (const id of METRIC_IDS) {
      const d = p.deltas[id];
      if (d !== undefined) f(`pair.${pid}.delta.${id}`, `Pair ${p.seed} B - A ${id}`, d, UNIT_LABEL[metricUnit(report.pairs, id)], 'one pair', expScope, id, metricEligible(p, id) ? tag : [...tag, 'not eligible for aggregate']);
    }
  }
  const totalDecisions = Object.values(ctx.sources).reduce((s, v) => s + v, 0);
  for (const src of ['jev', 'cache', 'mock', 'fallback'] as const) {
    f(`sources.${src}`, `Applied decisions with source ${src}`, ctx.sources[src], 'decisions', `${totalDecisions} applied decisions across all arms`);
  }
  if (totalDecisions) f('sources.fallback_share', 'Share of applied decisions from fallback', ctx.sources.fallback / totalDecisions, 'ratio', `${totalDecisions} applied decisions`);
  if (ctx.usage) {
    f('usage.provider_calls', 'Provider calls (including retries)', ctx.usage.calls, 'calls', 'all attempts, each call ID once');
    f('usage.unknown_calls', 'Calls with unknown usage (started only)', ctx.usage.unknownCalls, 'calls', `${ctx.usage.calls} calls`);
    f('usage.input_tokens', 'Reported input tokens', ctx.usage.inputTokens, 'tokens', `${ctx.usage.finishedCalls} finished calls; coverage ${ctx.usage.tokenCoverage}`);
    f('usage.reported_cost_usd', 'Provider-reported cost', ctx.usage.reportedCostUsd, 'USD', 'calls with provider-reported cost');
    f('usage.estimated_cost_usd', 'Estimated cost (labeled estimate)', ctx.usage.estimatedCostUsd, 'USD', 'calls without reported cost but with tokens', expScope, null, ['estimate from documented price config, unverified']);
    f('usage.unknown_cost_calls', 'Calls with unknown cost', ctx.usage.unknownCostCalls, 'calls', `${ctx.usage.calls} calls`);
  } else {
    f('usage.unavailable', 'Provider usage', 'not available to the coordinator process', 'label', 'none');
  }
  if (ctx.responseTapeSha256) f('provenance.response_tape_sha256', 'Response tape SHA-256', ctx.responseTapeSha256, 'sha256', 'none');
  f('provenance.spec_hash', 'Experiment spec hash', hashCanonical(spec), 'sha256', 'none');
  const sourceHash = hashCanonical({ v: REPORT_FACTS_VERSION, spec, pairs: report.pairs, summaries: report.summaries });
  const quality: Quality = {
    comparisonEligible: report.completePairs > 0 && report.status === 'complete' && ctx.sources.fallback === 0,
    reasons: report.pairs.filter((p) => p.status !== 'complete').map((p) => `pair ${p.seed} ${p.status}: ${p.reasons.join('; ') || 'no reason recorded'}`),
    behaviorCounts: { ...ctx.sources }, invalidAttempts: 0, staleAttempts: 0, pendingRatings: 0,
    terminalRatingsExpected: 0, terminalRatingsComplete: 0,
  };
  return { contractVersion: CONTRACT_VERSION, id: `facts-${spec.experimentId}`, asOfMs: spec.config.horizonMs, sourceHash, facts, quality, scope: expScope };
}

function diffText(d: ReturnType<typeof scenarioDiff>): string {
  const ev = (e: { id: string; atMs: number; change: { kind: string } }) => `${e.id}@${e.atMs}:${JSON.stringify(e.change)}`;
  return [
    ...d.changed.map((c) => `changed ${ev(c.before)} -> ${ev(c.after)}`),
    ...d.added.map((e) => `added ${ev(e)}`),
    ...d.removed.map((e) => `removed ${ev(e)}`),
  ].join('; ') || 'none (A/A)';
}

const REPORT_KEYS = ['spec', 'revision', 'status', 'pairs', 'summaries', 'requestedPairs', 'completePairs', 'exploratory', 'limitations', 'facts', 'responseTape'].sort();
const PAIR_KEYS = ['pairId', 'seed', 'populationHash', 'initialStateHash', 'aRunId', 'bRunId', 'status', 'reasons', 'a', 'b', 'deltas'].sort();
const SUMMARY_KEYS = ['metricId', 'pairCount', 'differences', 'mean', 'min', 'max', 'sampleSd', 'interval'].sort();

/** Exact-shape check: a report readable by Experience without custom/private fields. */
export function validateReportShape(r: ExperimentReport): string[] {
  const errs: string[] = [];
  const same = (o: object, keys: string[], where: string) => {
    const k = Object.keys(o).sort();
    if (k.join() !== keys.join()) errs.push(`${where} keys ${k.join(',')} != ${keys.join(',')}`);
  };
  same(r, REPORT_KEYS, 'report');
  r.pairs.forEach((p, i) => same(p, PAIR_KEYS, `pairs[${i}]`));
  r.summaries.forEach((s, i) => same(s, SUMMARY_KEYS, `summaries[${i}]`));
  if (r.pairs.length !== r.requestedPairs) errs.push('every requested pair must be present');
  return errs;
}
