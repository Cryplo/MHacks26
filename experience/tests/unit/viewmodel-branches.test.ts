import { describe, expect, it } from 'vitest';
import type { AppliedDecision, FactBundle, Narrative, ParkBundle } from '../../contract/behavior-v1';
import bundle from '../../fixtures/parks/harbor-lights-stage1.bundle.json';
import conformance from '../../fixtures/conformance-fixtures.json';
import { describeChange, eventTime } from '../../src/features/scenarios/describe';
import { buildCrowd, defaultMix, fitMix, mixFromShares, summarizePopulation } from '../../src/features/setup/crowd';
import { heatColor, topCells } from '../../src/features/results/heat';
import { formatFactValue, resolveNarrative } from '../../src/features/results/facts';
import { csvCell, parseCsv } from '../../src/features/results/exportCsv';
import { governance, optionRows, sourceLabel } from '../../src/features/inspector/evidence';
import { pickAgent } from '../../src/renderer/picking';
import { displayPose, isContinuous, pushSample } from '../../src/renderer/interpolation';
import { buildFixturePopulation } from '../../src/fixture/population';

const park = bundle as unknown as ParkBundle;

describe('describeChange covers every event kind', () => {
  it.each([
    [{ kind: 'pass_share', placeId: 'coaster_tempest', shareBps: 2500 }, /25\.0% target/],
    [{ kind: 'board', placeId: 'coaster_tempest', display: { kind: 'fixed', lowerMin: 20, upperMin: 30, text: '20-30 min' } }, /fixed text "20-30 min" \(20-30 min\)/],
    [{ kind: 'board', placeId: 'coaster_tempest', display: { kind: 'rounded_estimate', roundToMin: 5, template: 'x' } }, /rounded to 5 min/],
    [{ kind: 'board', placeId: 'coaster_tempest', display: { kind: 'range_estimate', roundToMin: 5, spreadMin: 10, template: 'x' } }, /10-min spread/],
    [{ kind: 'notice', placeId: 'churro_cart', notice: { text: 'Hi', channel: 'aroma', radiusM: 12, cooldownMs: 0 } }, /"Hi" \(aroma, 12 m\)/],
    [{ kind: 'closure', placeId: 'coaster_tempest', closed: false }, /resume admissions/],
    [{ kind: 'show_schedule', placeId: 'lantern_theatre', startsAtMs: [3600000] }, /10:00 AM/],
    [{ kind: 'app_message', messageId: 'm', text: 'Hello', expiresAtMs: 3600000, suggestedPlaceId: null, discount: { productIds: ['churro'], discountBps: 2000, maxUsesPerGroup: 1 } }, /discount 20%/],
    [{ kind: 'closure', placeId: 'nope', closed: true }, /Close/],
  ])('%o', (change, re) => {
    const d = describeChange(change as never, park, false);
    expect(`${d.operation} ${d.place} ${d.value}`).toMatch(re);
  });
  it('unknown place is flagged; discount unsupported note; event time', () => {
    expect(describeChange({ kind: 'closure', placeId: 'nope', closed: true }, park, false).place).toMatch(/unknown place/);
    expect(describeChange({ kind: 'app_message', messageId: 'm', text: 'x', expiresAtMs: 0, suggestedPlaceId: null, discount: { productIds: [], discountBps: 100, maxUsesPerGroup: 1 } }, park, false).notes.join()).toMatch(/not supported/);
    expect(eventTime({ id: 'e', atMs: 18000000, order: 0, change: { kind: 'pass_price', unitPriceCents: 1 } }, park)).toBe('2:00 PM park time (+05:00:00 after opening)');
  });
});

describe('crowd helpers', () => {
  it('fit/mix/shares/summaries', () => {
    expect(fitMix({ young_family: 0, teens: 0, couple: 0, thrill_seekers: 0, seniors: 0, solo: 0 }, 50)).toEqual(defaultMix(50));
    const m = mixFromShares({ young_family: 0.5, teens: 0.5, couple: 0, thrill_seekers: 0, seniors: 0, solo: 0 }, 101);
    expect(m.young_family + m.teens).toBe(101);
    const crowd = buildCrowd(120, defaultMix(120), 's', '');
    const pop = buildFixturePopulation(crowd, park, 'a'.repeat(64)).manifest;
    const s = summarizePopulation(pop);
    expect(s.guests).toBe(120);
    expect(s.budgets.min).toBeLessThanOrEqual(s.budgets.max);
    expect(Object.values(s.realized).reduce((a, b) => a + b, 0)).toBe(120);
  });
});

describe('heat/facts/csv/evidence/picking/interpolation extras', () => {
  it('heat colour ramps and handles zero; nearest place null when far', () => {
    expect(heatColor(0, 10)[3]).toBe(0);
    expect(heatColor(5, 0)[3]).toBe(0);
    expect(heatColor(10, 10)).toEqual([68, 1, 84, 255]);
    const values = new Array(30000).fill(0); values[149 * 200 + 1] = 1;
    expect(topCells({ runId: 'r', layer: 'spending_cents', fromMs: 0, toMs: 1, cellM: 1, width: 200, height: 150, values, total: 1, unit: 'cents', denominator: '', complete: true }, park)[0]!.nearestPlace).toBeNull();
  });
  it('fact formatting for every unit and string values; no bundle -> error', async () => {
    const base = { id: 'f', label: 'l', denominator: '', scope: { runId: null, experimentId: null }, sourceEventIds: [], metricId: null, limitations: [] };
    expect(formatFactValue({ ...base, value: 'n/a', unit: 'cents' })).toBe('n/a');
    expect(formatFactValue({ ...base, value: 3.25, unit: 'minutes' })).toBe('3.3 min');
    expect(formatFactValue({ ...base, value: 80, unit: 'score' })).toBe('80.0 / 100');
    expect(formatFactValue({ ...base, value: 1.5, unit: 'ratio', metricId: 'rides_per_guest' })).toBe('1.50');
    expect(formatFactValue({ ...base, value: 12, unit: 'guests' })).toBe('12 guests');
    expect(formatFactValue({ ...base, value: 2, unit: 'widgets' })).toBe('2.00 widgets');
    const n: Narrative = { id: 'n', evidenceHash: 'a'.repeat(64), origin: 'template', label: 'narrated from state', limitations: [], sections: [{ heading: 'h', segments: [{ kind: 'fact', factId: 'x' }] }] };
    expect((await resolveNarrative(n, null)).errors[0]).toMatch(/no fact bundle/);
    const fb: FactBundle = { contractVersion: 'behavior.v1', id: 'b', asOfMs: 0, sourceHash: 'a'.repeat(64), facts: [], quality: null, scope: { runId: null, experimentId: null } };
    expect((await resolveNarrative(n, fb)).hashMatches).toBe(true); // sourceHash binding accepted
  });
  it('csv booleans/non-finite and unterminated last row', () => {
    expect(csvCell(true)).toBe('true');
    expect(csvCell(Infinity)).toBe('');
    expect(parseCsv('a,b\nc')).toEqual([['a', 'b'], ['c']]);
  });
  it('evidence: missing evidence, single-guest decisions, jev source', () => {
    expect(governance({ agent: { agentId: 'a' }, evidence: null } as never).text).toMatch(/No decision/);
    const e = { evidenceId: 'e', request: { ...conformance.decisionRequest, agentIds: ['a001'], promptOptionOrder: [] }, response: conformance.decisionResult, appliedProbabilities: conformance.decisionResult.probabilities, draw: 0.9, chosenOptionId: 'travel_splash' } as unknown as AppliedDecision;
    expect(governance({ agent: { agentId: 'a001' }, evidence: e } as never).text).toBe('Decision for this guest alone.');
    expect(optionRows(e).map((r) => r.id)).toEqual(['browse', 'leave', 'travel_splash']);
    expect(sourceLabel('jev', 'jev', 'jev-1').tone).toBe('ok');
    expect(sourceLabel('cache', 'mock', 'x').tone).toBe('warn');
  });
  it('picking tie-break by id; interpolation same-time replace and before-prev', () => {
    const d = new Map([['b', { xM: 1, yM: 0 }], ['a', { xM: -1, yM: 0 }]]);
    expect(pickAgent(d, { xM: 0, yM: 0 }, 2)).toBe('a');
    const walk = () => true;
    let t = pushSample(undefined, { simMs: 0, pos: { xM: 0, yM: 0 }, state: 'walking' }, walk);
    t = pushSample(t, { simMs: 5000, pos: { xM: 1, yM: 0 }, state: 'walking' }, walk);
    t = pushSample(t, { simMs: 5000, pos: { xM: 2, yM: 0 }, state: 'walking' }, walk);
    expect(displayPose(t, 5000).pos.xM).toBe(2);
    expect(isContinuous({ simMs: 5, pos: { xM: 0, yM: 0 }, state: 'walking' }, { simMs: 5, pos: { xM: 0, yM: 0 }, state: 'walking' }, walk)).toBe(false);
    const first = pushSample(undefined, { simMs: 0, pos: { xM: 0, yM: 0 }, state: 'walking' }, walk);
    expect(pushSample(first, { simMs: 0, pos: { xM: 3, yM: 0 }, state: 'walking' }, walk).continuous).toBe(false);
  });
});

describe('evidence extras', () => {
  it('failed outcome narration, missing truth, unknown option ids', async () => {
    const { knowledgeVsTruth, narrateFromState } = await import('../../src/features/inspector/evidence');
    const e = { evidenceId: 'e', request: { ...conformance.decisionRequest, agentIds: ['a001'] }, response: { ...conformance.decisionResult, probabilities: [] }, appliedProbabilities: [], draw: 0.1, chosenOptionId: 'ghost', outcome: 'failed_precondition', failureReason: null } as unknown as AppliedDecision;
    expect(narrateFromState(e, 'a001')).toMatch(/Guest a001.*"ghost".*failed \(precondition\)/);
    const rows = optionRows(e);
    expect(rows.every((r) => r.raw === null && r.applied === null && !r.highest)).toBe(true);
    expect(knowledgeVsTruth([{ id: 'f', kind: 'crowd', placeId: null, source: 'self', observedAtMs: 0, contentVersion: 'v', text: 't', waitLowerMs: null, waitUpperMs: null, priceCents: null }, { id: 'g', kind: 'board', placeId: 'x', source: 'sight', observedAtMs: 0, contentVersion: 'v', text: 't', waitLowerMs: null, waitUpperMs: null, priceCents: null }], new Map())).toEqual([{ placeId: 'x', guestFacts: [expect.objectContaining({ id: 'g' })], truth: null }]);
  });
});
