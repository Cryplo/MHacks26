import { describe, expect, it } from 'vitest';
import type { ExperimentSpec, ScenarioEvent } from '../../contract/behavior-v1.ts';
import { passPriceExperiment, preflightExperiment, scenarioDiff } from '../../src/experiments/preflight.ts';
import { TINY_CROWD } from '../../src/fixtures/crowds.ts';
import { experimentConfig } from '../helpers/experiment.ts';
import { capabilities, scenarioSetup } from '../helpers/scenario.ts';

const { seed: _s, ...crowd } = TINY_CROWD;
function base(over: Partial<Parameters<typeof passPriceExperiment>[0]> = {}): ExperimentSpec {
  const { art } = scenarioSetup();
  return passPriceExperiment({ experimentId: 'exp-1', park: art.ref, crowd, seeds: ['s1', 's2', 's3'], config: experimentConfig(), atMs: 10_000, ...over });
}
const run = (spec: ExperimentSpec, caps = capabilities()) => preflightExperiment(spec, caps, scenarioSetup().bundle);
const notice: ScenarioEvent = { id: 'n1', atMs: 20_000, order: 0, change: { kind: 'notice', placeId: null, text: 'Hello' } as never };

describe('B-19 preflight: the first A/B changes only the pass price', () => {
  it('pass price 1500 -> 2500 is exactly one changed pass_price event', () => {
    const spec = base();
    const d = scenarioDiff(spec.baseline, spec.variant);
    expect(d).toMatchObject({ added: [], removed: [], kinds: ['pass_price'] });
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.before.change).toEqual({ kind: 'pass_price', unitPriceCents: 1500 });
    expect(d.changed[0]!.after.change).toEqual({ kind: 'pass_price', unitPriceCents: 2500 });
    expect(spec.changedLever).toBe('pass_price');
    expect(spec.analysis).toBe('paired_descriptive');
    const pf = run(spec);
    expect(pf.errors).toEqual([]);
    expect(pf.ok).toBe(true);
    expect(pf.label).toBe('mock');
    expect(pf.warnings.join(' ')).toMatch(/Mock experiment/);
  });

  it('an extra change under a single declared lever is rejected; "bundled" is allowed with a warning', () => {
    const spec = base();
    const extra = { ...spec, variant: { ...spec.variant, events: [...spec.variant.events, notice] } };
    expect(run(extra).errors.join(' ')).toMatch(/declared lever pass_price but the scenario diff changes notice, pass_price/);
    const bundled = run({ ...extra, changedLever: 'bundled' });
    expect(bundled.ok).toBe(true);
    expect(bundled.warnings.join(' ')).toMatch(/bundled intervention/);
  });

  it('identical arms need changedLever "none" (A/A)', () => {
    const spec = base();
    const aa = { ...spec, variant: structuredClone(spec.baseline) };
    expect(run(aa).ok).toBe(false);
    const ok = run({ ...aa, changedLever: 'none' });
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toContain('A/A experiment: identical arms');
  });

  it('seed and design checks', () => {
    expect(run(base({ seeds: ['s1', 's1'] })).errors).toContain('seeds must be unique');
    expect(run(base({ seeds: [] })).errors).toContain('at least one seed is required');
    expect(run(base({ seeds: ['s1'] })).warnings).toContain('one pair is an illustration, not a comparison');
    expect(run(base({ seeds: ['s1', 's2'] })).warnings).toContain('fewer than three pairs: exploratory illustration only');
    expect(run(base({ config: experimentConfig({ mode: 'live' }) })).ok).toBe(false);
    expect(run(base({ config: experimentConfig({ mode: 'experiment', fallback: 'allowed' as never }) })).errors).toContain('real-provider experiments must forbid fallback decisions');
    expect(run(base({ config: experimentConfig({ horizonMs: 12_345 }) })).errors).toContain('horizonMs must be a positive multiple of 5000');
    expect(run({ ...base(), alpha: 0.1 as 0.05 }).errors).toContain('alpha must be 0.05');
    expect(run({ ...base(), analysis: 'bayes' as never }).ok).toBe(false);
    expect(run(base({ atMs: 120_000 })).errors.join(' ')).toMatch(/after the horizon/);
    expect(run(base(), capabilities({ eventKinds: ['notice'] })).errors.join(' ')).toMatch(/pass_price not supported/);
  });

  it('warmup: the intervention may not precede the common warmup point', () => {
    const spec = base();
    const warm = (toMs: number): ExperimentSpec => ({ ...spec, start: { kind: 'warmup', toMs, warmupScenario: { ...spec.baseline, id: 'w', events: [] } } });
    expect(run(warm(10_000)).ok).toBe(true);
    expect(run(warm(15_000)).errors.join(' ')).toMatch(/precedes the common warmup point/);
    expect(run(warm(60_000)).errors).toContain('warmup toMs must be a positive multiple of 5000 before the horizon');
  });
});
