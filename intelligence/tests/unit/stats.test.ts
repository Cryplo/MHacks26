import { describe, expect, it } from 'vitest';
import type { MetricSnapshot, MetricValue, PairResult } from '../../contract/behavior-v1.ts';
import { METRIC_IDS } from '../../src/core/validate.ts';
import { metricEligible, pairDeltas, summarize } from '../../src/experiments/report.ts';
import { pairedSummary, regularizedBeta, studentTCdf, studentTQuantile } from '../../src/experiments/stats.ts';
import { golden } from '../helpers/fixtures.ts';

/** Reference two-sided 95% critical values t_{0.975, df} (R qt / scipy.stats.t.ppf). */
const T975: [number, number][] = [
  [1, 12.706204736174698], [2, 4.302652729749464], [3, 3.182446305284263], [4, 2.7764451051977934],
  [9, 2.2621571628540993], [29, 2.045229642132703], [1000, 1.9623390808264078],
];

describe('B-20 Student t critical values', () => {
  it.each(T975)('t_{0.975, %i} = %f (not a z approximation)', (df, ref) => {
    expect(studentTQuantile(0.975, df)).toBeCloseTo(ref, 9);
  });
  it('is symmetric, monotone and consistent with its CDF', () => {
    expect(studentTQuantile(0.5, 5)).toBe(0);
    expect(studentTQuantile(0.025, 4)).toBeCloseTo(-2.7764451051977934, 9);
    expect(studentTCdf(0, 7)).toBeCloseTo(0.5, 12);
    expect(studentTCdf(studentTQuantile(0.9, 3), 3)).toBeCloseTo(0.9, 10);
    expect(studentTQuantile(0.975, 2)).toBeGreaterThan(studentTQuantile(0.975, 3));
    expect(regularizedBeta(0, 2, 3)).toBe(0);
    expect(regularizedBeta(1, 2, 3)).toBe(1);
    expect(regularizedBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12);
  });
  it('rejects invalid input', () => {
    expect(() => studentTQuantile(1, 3)).toThrow();
    expect(() => studentTQuantile(0.975, 0)).toThrow();
  });
});

describe('B-20 paired summaries', () => {
  it('matches the golden paired-analysis vector (descriptive default, no interval)', () => {
    const g = golden().pairedAnalysis;
    const deltas = (g.b as number[]).map((b, i) => b - g.a[i]);
    expect(deltas).toEqual(g.deltas);
    const s = pairedSummary('net_revenue_cents', deltas, 'paired_descriptive');
    expect(s).toEqual({ metricId: 'net_revenue_cents', pairCount: g.n, differences: g.deltas, mean: g.mean, min: g.min, max: g.max, sampleSd: g.sampleSd, interval: g.defaultInterval });
  });
  it('paired_t interval uses t with n-1 df', () => {
    const s = pairedSummary('net_revenue_cents', [10, 20, 30], 'paired_t');
    const half = 4.302652729749464 * 10 / Math.sqrt(3);
    expect(s.interval!.kind).toBe('paired_t_mean');
    expect(s.interval!.level).toBe(0.95);
    expect(s.interval!.lower).toBeCloseTo(20 - half, 9);
    expect(s.interval!.upper).toBeCloseTo(20 + half, 9);
  });
  it('n=0 gives nulls; n=1 gives no SD and no interval even for paired_t', () => {
    expect(pairedSummary('satisfaction_0_100', [], 'paired_t')).toEqual({ metricId: 'satisfaction_0_100', pairCount: 0, differences: [], mean: null, min: null, max: null, sampleSd: null, interval: null });
    expect(pairedSummary('satisfaction_0_100', [-3], 'paired_t')).toMatchObject({ pairCount: 1, mean: -3, min: -3, max: -3, sampleSd: null, interval: null });
  });
  it('zero and negative differences are real values', () => {
    expect(pairedSummary('queue_minutes_per_guest', [0, 0, 0], 'paired_t')).toMatchObject({ pairCount: 3, mean: 0, sampleSd: 0, interval: { lower: 0, upper: 0 } });
    expect(pairedSummary('net_revenue_cents', [-1000, -500, -1500], 'paired_descriptive')).toMatchObject({ mean: -1000, min: -1500, max: -500, sampleSd: 500 });
  });
  it('refuses non-finite differences and other alphas', () => {
    expect(() => pairedSummary('net_revenue_cents', [Number.NaN], 'paired_t')).toThrow();
    expect(() => pairedSummary('net_revenue_cents', [1, 2], 'paired_t', 0.1)).toThrow();
  });
});

const mv = (id: MetricValue['id'], value: number | null, complete = value !== null): MetricValue =>
  ({ id, value, unit: 'ratio', numerator: 0, denominator: value === null ? null : 1, n: 1, coverage: complete ? 1 : 0.5, complete, missingReason: complete ? null : 'missing' });
const snap = (over: Partial<Record<MetricValue['id'], MetricValue>> = {}): MetricSnapshot => ({
  runId: 'r', simMs: 0, revision: 1, definitionVersion: 'metrics-v1', admittedGuests: 1, guestsInPark: 0,
  measures: Object.fromEntries(METRIC_IDS.map((id) => [id, over[id] ?? mv(id, 1)])) as MetricSnapshot['measures'],
});
const pair = (seed: string, a: MetricSnapshot | null, b: MetricSnapshot | null, status: PairResult['status'] = 'complete'): PairResult => ({
  pairId: `pair-${seed}`, seed, populationHash: 'x', initialStateHash: null, aRunId: 'ra', bRunId: 'rb', status, reasons: [], a, b, deltas: pairDeltas(a, b),
});

describe('B-20 eligibility and unavailable denominators', () => {
  it('null denominators stay unavailable; incomplete measures and non-complete pairs are excluded per metric', () => {
    const p1 = pair('s1', snap({ abandonment_rate: mv('abandonment_rate', null) }), snap({ satisfaction_0_100: mv('satisfaction_0_100', 2, false) }));
    const p2 = pair('s2', snap(), snap({ net_revenue_cents: mv('net_revenue_cents', 4) }));
    const p3 = pair('s3', snap(), snap(), 'degraded');
    const p4 = pair('s4', null, null, 'failed');
    expect(p1.deltas.abandonment_rate).toBeUndefined();
    expect(metricEligible(p1, 'satisfaction_0_100')).toBe(false);
    expect(metricEligible(p3, 'net_revenue_cents')).toBe(false);
    expect(p4.deltas).toEqual({});
    const spec = { analysis: 'paired_descriptive', alpha: 0.05 } as Parameters<typeof summarize>[0];
    const by = Object.fromEntries(summarize(spec, [p1, p2, p3, p4]).map((s) => [s.metricId, s]));
    expect(by.net_revenue_cents).toMatchObject({ pairCount: 2, differences: [0, 3], mean: 1.5 });
    expect(by.satisfaction_0_100).toMatchObject({ pairCount: 1, differences: [0] });
    expect(by.abandonment_rate).toMatchObject({ pairCount: 1, differences: [0] });
  });
});
