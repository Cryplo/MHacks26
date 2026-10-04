import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '../../contract/behavior-v1.ts';
import { LAB_CASES, PLAUSIBILITY_LABEL, buildLabRequest, runPlausibilityLab } from '../../src/plausibility/lab.ts';
import { MockProvider } from '../../src/providers/mock.ts';
import type { BehaviorProvider, ProviderDecision } from '../../src/providers/types.ts';
import { conformance } from '../helpers/fixtures.ts';
import { ScriptedJev } from '../helpers/providers.ts';

const template = (): DecisionRequest => conformance().decisionRequest;

describe('B-23 plausibility lab', () => {
  it('records states, model/version and seeded sample counts; mock evidence is labeled mechanical', async () => {
    const e = await runPlausibilityLab({ provider: new MockProvider(), template: template(), samplesPerState: 120 });
    expect(e.label).toBe(PLAUSIBILITY_LABEL);
    expect(e.evidenceKind).toBe('mock-mechanical-check');
    expect(e.provider).toEqual({ source: 'mock', modelRequested: 'mock-policy-v1', modelsReturned: ['mock-policy-v1'], instructionsVersion: 'mock-instructions-v1' });
    expect(e.cases.map((c) => c.factor)).toEqual([
      'purchase eligibility', 'hunger', 'fatigue', 'promise overrun', 'app exposure', 'changed notice wording', 'group member needs', 'goal sensitivity', 'memory sensitivity',
    ]);
    for (const c of e.cases) {
      for (const s of [c.a, c.b]) {
        expect(s.error).toBeNull();
        expect(s.observationHash).toMatch(/^[0-9a-f]{64}$/);
        expect(Object.values(s.sampleCounts!).reduce((x, y) => x + y, 0)).toBe(120);
      }
      expect(c.a.observationHash).not.toBe(c.b.observationHash);
    }
    expect(e.noiseFloor.placebos).toHaveLength(3);
    expect(e.limitations.join(' ')).toMatch(/Mock-mechanical check/);
    expect(e.summary.distinctTopOptions).toBeGreaterThan(1);
    expect(e.summary.meanNormalizedEntropy).toBeGreaterThan(0.3);
  });

  it('mock moves only on its designed mechanisms; wording, promise overrun and memory stay flat (not passed off as evidence)', async () => {
    const e = await runPlausibilityLab({ provider: new MockProvider(), template: template() });
    const v = Object.fromEntries(e.cases.map((c) => [c.id, c.verdict]));
    expect(v).toEqual({
      affordability: 'as_expected', hunger: 'as_expected', fatigue: 'as_expected', app_exposure: 'as_expected', member_needs: 'as_expected', goal: 'as_expected',
      promise_overrun: 'flat', notice_wording: 'flat', memory: 'flat',
    });
    expect(e.summary).toMatchObject({ cases: 9, asExpected: 6, flat: 3, opposite: 0, errors: 0 });
    for (const c of e.cases) expect(Math.abs(c.shift!) > c.shiftThreshold! || c.verdict === 'flat' || c.expect === 'changes').toBe(true);
  });

  it('is deterministic for the same provider, states and sample seed', async () => {
    const a = await runPlausibilityLab({ provider: new MockProvider(), template: template(), samplesPerState: 50 });
    const b = await runPlausibilityLab({ provider: new MockProvider(), template: template(), samplesPerState: 50 });
    expect(a).toEqual(b);
  });

  it('real-provider runs are labeled observations and never asserted as exact vectors', async () => {
    const e = await runPlausibilityLab({ provider: new ScriptedJev(), template: template(), samplesPerState: 10 });
    expect(e.evidenceKind).toBe('real-provider-observation');
    expect(e.limitations.join(' ')).toMatch(/Real-provider observation/);
    expect(e.limitations.join(' ')).not.toMatch(/Mock-mechanical/);
  });

  it('invalid or failing provider output is recorded as an error case, not dropped or retried', async () => {
    let calls = 0;
    const bad: BehaviorProvider = {
      source: 'jev', model: 'jev-test', instructionsVersion: 'x', estimateInputTokens: () => 1,
      decide: async (req): Promise<ProviderDecision> => {
        calls += 1;
        if (req.requestId.startsWith('plausibility:hunger:')) throw new Error('provider timeout');
        const probabilities = req.options.map((o) => ({ optionId: o.id, probability: req.requestId.startsWith('plausibility:fatigue:B') ? 0.5 : 1 / req.options.length }));
        return { raw: new Uint8Array(), modelReturned: 'jev-test', probabilities, confidence: null, usage: { inputTokens: null, outputTokens: null, costUsd: null }, httpMs: 1 };
      },
      rate: async () => { throw new Error('unused'); },
    };
    const e = await runPlausibilityLab({ provider: bad, template: template(), samplesPerState: 5 });
    expect(calls).toBe(4 + 2 * LAB_CASES.length);
    const by = Object.fromEntries(e.cases.map((c) => [c.id, c]));
    expect(by.hunger!.verdict).toBe('error');
    expect(by.hunger!.a.error).toMatch(/timeout/);
    expect(by.fatigue!.verdict).toBe('error');
    expect(by.fatigue!.b.error).toMatch(/invalid distribution/);
    expect(by.goal!.verdict).toBe('flat');
    expect(e.summary.errors).toBe(2);
  });

  it('lab requests are valid frozen DecisionRequests with the full option permutation', () => {
    for (const c of LAB_CASES) {
      const r = buildLabRequest(template(), c.id, 'B', c.b);
      expect(r.promptOptionOrder).toEqual(r.options.map((o) => o.id));
      for (const t of c.target) expect(r.options.some((o) => o.id === t)).toBe(true);
    }
  });
});
