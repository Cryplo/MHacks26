/** C-17/C-18/C-19 helpers: labels, heatmap placement, fact resolution, CSV safety. */
import { describe, expect, it } from 'vitest';
import type { ExperimentReport, FactBundle, Heatmap, Narrative, ParkBundle } from '../../contract/behavior-v1';
import bundle from '../../fixtures/parks/harbor-lights-stage1.bundle.json';
import { canonicalHash } from '../../src/domain/canonical';
import { describeDelta } from '../../src/domain/metrics';
import { changedLever, evidenceLabels, intervalText } from '../../src/features/results/experiment';
import { csvCell, parseCsv, toCsv } from '../../src/features/results/exportCsv';
import { formatFactValue, resolveNarrative } from '../../src/features/results/facts';
import { cellCenter, topCells } from '../../src/features/results/heat';
import { revenueRateSeries } from '../../src/data/derived';
import { metrics } from '../helpers';

const park = bundle as unknown as ParkBundle;
const report = (completePairs: number, mode: 'mock' | 'experiment' = 'mock', status: ExperimentReport['status'] = 'complete') =>
  ({ completePairs, status, spec: { config: { mode, versions: { requestedModel: mode === 'mock' ? 'mock-policy-v1' : 'jev-1.13.0' } } } } as unknown as ExperimentReport);

describe('experiment labels (C-17)', () => {
  it('one pair is illustrative, several exploratory, mock and fixture always labeled', () => {
    expect(evidenceLabels(report(1), 'live')).toEqual(['Mock', 'Illustrative']);
    expect(evidenceLabels(report(3, 'experiment'), 'live')).toEqual(['Live Jev', 'Exploratory']);
    expect(evidenceLabels(report(2, 'mock', 'incomplete'), 'fixture')).toEqual(['Fixture', 'Mock', 'Exploratory', 'Incomplete']);
  });
  it('no interval text unless supplied with method and level; min/max are never an interval', () => {
    const base = { metricId: 'net_revenue_cents' as const, pairCount: 3, differences: [1, 2, 3], mean: 2, min: 1, max: 3, sampleSd: 1 };
    expect(intervalText({ ...base, interval: null })).toBeNull();
    expect(intervalText({ ...base, interval: { kind: 'paired_t_mean', lower: -1, upper: 5, level: 0.95 } })).toBe('95% paired t mean interval');
  });
  it('reads negative, zero and positive deltas without treating more money or waiting as better', () => {
    expect(describeDelta('queue_minutes_per_guest', 2)).toMatch(/worse/);
    expect(describeDelta('net_revenue_cents', 500)).toMatch(/not proof of a better visit/);
    expect(describeDelta('satisfaction_0_100', -3)).toMatch(/worse/);
    expect(describeDelta('satisfaction_0_100', 1e-15)).toBe('no change');
    expect(describeDelta('rides_per_guest', null)).toBe('not available');
  });
  it('identifies a price-only lever vs a bundled change', () => {
    const base = { id: 'a', revision: '1', label: 'A', events: [] };
    const price = { id: 'b', revision: '1', label: 'B', events: [{ id: 'p', atMs: 0, order: 0, change: { kind: 'pass_price' as const, unitPriceCents: 2500 } }] };
    expect(changedLever(base, price)).toMatchObject({ lever: 'pass_price', bundled: false });
    const both = { ...price, events: [...price.events, { id: 'c', atMs: 5000, order: 0, change: { kind: 'closure' as const, placeId: 'x', closed: true } }] };
    expect(changedLever(base, both).bundled).toBe(true);
    expect(changedLever(base, base).lever).toBe('none');
  });
});

describe('heatmap placement (C-18)', () => {
  const h: Heatmap = { runId: 'r', layer: 'spending_cents', fromMs: 0, toMs: 1, cellM: 1, width: 200, height: 150, values: new Array(30000).fill(0), total: 0, unit: 'cents', denominator: 'none', complete: true };
  it('maps row-major indices to metre cell centres with no flip', () => {
    expect(cellCenter(h, 0)).toEqual({ xM: 0.5, yM: 0.5 });
    expect(cellCenter(h, 201)).toEqual({ xM: 1.5, yM: 1.5 });
    expect(cellCenter(h, 149 * 200 + 199)).toEqual({ xM: 199.5, yM: 149.5 });
  });
  it('top cells sort by value and consume totals unchanged; zero layer gives none', () => {
    expect(topCells(h, park)).toEqual([]);
    const v = [...h.values]; v[90 * 200 + 100] = 500; v[10] = 900;
    const tops = topCells({ ...h, values: v, total: 1400 }, park);
    expect(tops.map((t) => t.value)).toEqual([900, 500]);
    expect(tops[1]!.center).toEqual({ xM: 100.5, yM: 90.5 });
  });
});

describe('fact references (C-19)', () => {
  const facts: FactBundle = {
    contractVersion: 'behavior.v1', id: 'fb1', asOfMs: 0, sourceHash: 'b'.repeat(64), quality: null, scope: { runId: 'r', experimentId: null },
    facts: [{ id: 'f.rev', label: 'Net revenue', value: 123456, unit: 'cents', denominator: 'none', scope: { runId: 'r', experimentId: null }, sourceEventIds: [], metricId: 'net_revenue_cents', limitations: [] }],
  };
  const narrative = async (factIds: string[], hash?: string): Promise<Narrative> => ({
    id: 'n', evidenceHash: hash ?? (await canonicalHash(facts)), origin: 'llm', label: 'modeled-results report', limitations: [],
    sections: [{ heading: 'h', segments: [{ kind: 'text', text: '<script>alert(1)</script> Revenue ' }, ...factIds.map((factId) => ({ kind: 'fact' as const, factId }))] }],
  });
  it('resolves known facts with units from a hash-matching bundle', async () => {
    const r = await resolveNarrative(await narrative(['f.rev']), facts);
    expect(r.errors).toEqual([]);
    expect(r.sections[0]!.segments[1]).toMatchObject({ kind: 'fact', text: '$1,234.56' });
  });
  it('unknown fact IDs and mismatched evidence are visible errors, not guesses', async () => {
    expect((await resolveNarrative(await narrative(['f.missing']), facts)).errors[0]).toMatch(/Unknown fact/);
    const mismatch = await resolveNarrative(await narrative(['f.rev'], 'c'.repeat(64)), facts);
    expect(mismatch.hashMatches).toBe(false);
    expect(mismatch.sections[0]!.segments[1]!.kind).toBe('error');
  });
  it('formats fact units', () => {
    expect(formatFactValue({ ...facts.facts[0]!, id: 'x:delta:y', value: -500 })).toBe('−$5.00');
    expect(formatFactValue({ ...facts.facts[0]!, unit: 'ratio', metricId: 'abandonment_rate', value: 0.25 })).toBe('25.0%');
  });
});

describe('CSV export (C-19)', () => {
  it('neutralizes formulas and round-trips quoting', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    const rows = [['label', 'value'], ['Shop, "Gifts"\nline2', 2500], ['-danger', -1.5]];
    const parsed = parseCsv(toCsv(rows));
    expect(parsed).toEqual([['label', 'value'], ['Shop, "Gifts"\nline2', '2500'], ["'-danger", '-1.5']]);
  });
});

describe('revenue rate chart', () => {
  it('uses actual interval durations and preserves negatives', () => {
    const m = (simMs: number, rev: number) => { const x = metrics('r1', simMs, simMs); x.measures = { ...x.measures, net_revenue_cents: { ...x.measures.net_revenue_cents, value: rev } }; return x; };
    const series = revenueRateSeries([m(0, 0), m(600_000, 1000), m(900_000, 800)], 600_000);
    expect(series[0]).toEqual({ fromMs: 0, toMs: 600_000, centsPerHour: 6000 });
    expect(series[1]!.centsPerHour).toBeCloseTo(-2400); // 200 cents lost over 5 min = -2400 cents per hour
  });
});
