/**
 * Plausibility lab: controlled pairs of SYNTHETIC observations that differ in one factor. For each
 * state the provider returns one probability vector; the lab records the tendency on target options,
 * the diversity of the vectors and seeded sample counts drawn from them (the lab draws; the worker
 * never does). These are synthetic plausibility checks, NOT calibration and not validation.
 *
 * Mock-policy runs are "mock-mechanical" checks: the mock was designed with some of these mechanisms,
 * so passing proves only that the plumbing carries the signal. Real-provider runs are observations of
 * the provider's tendencies on these states; they are reported separately and never asserted exactly.
 */
import type { ActionOption, DecisionRequest, Distribution, GuestObservation, Quote } from '../../contract/behavior-v1.ts';
import { referenceInverseCdf, semanticUniform } from '../core/random.ts';
import { observationHash, optionsHash, validateDecisionRequest, validateDistribution } from '../core/validate.ts';
import type { BehaviorProvider } from '../providers/types.ts';

export const PLAUSIBILITY_LAB_VERSION = 'plausibility-lab-v1';
export const PLAUSIBILITY_LABEL = 'SYNTHETIC PLAUSIBILITY CHECK - not calibration, not validation of human behavior';
const MIN_SHIFT = 0.01;

export type Expectation = 'increase' | 'decrease' | 'changes';
export type Verdict = 'as_expected' | 'opposite' | 'flat' | 'sensitive' | 'error';

export type LabCase = {
  id: string; factor: string; description: string;
  /** Option IDs whose total probability is compared between state A and state B. */
  target: string[]; expect: Expectation;
  a: (o: GuestObservation) => void; b: (o: GuestObservation) => void;
  options?: (opts: ActionOption[]) => ActionOption[];
};

const quote = (id: string, unit: number, beneficiaryIds: string[]): Quote => ({
  quoteId: id, revision: '1', productId: 'pass-splash', unitPriceCents: unit, quantity: beneficiaryIds.length,
  totalCents: unit * beneficiaryIds.length, beneficiaryIds, validUntilMs: 3_900_000, discountMessageId: null,
});

/** Representative option set shared by every case (labels are the only text the provider sees). */
export function labOptions(memberIds: string[]): ActionOption[] {
  return [
    { id: 'browse', label: 'Browse nearby', description: 'Wander without choosing an attraction.', action: { kind: 'browse', durationMs: 120_000 } },
    { id: 'rest', label: 'Sit and rest', description: 'Rest on a shaded bench for ten minutes.', action: { kind: 'rest', placeId: 'plaza', durationMs: 600_000 } },
    { id: 'leave', label: 'Head to the exit', description: 'Walk to the exit earlier than planned.', action: { kind: 'leave_park' } },
    { id: 'travel_splash', label: 'Walk to Splash Falls', description: 'About two minutes away. This does not join the queue.', action: { kind: 'travel', placeId: 'splash', routeProfileId: null } },
    { id: 'travel_tacos', label: 'Walk to Taco Cart for food', description: 'Snacks and lunch, about three minutes away.', action: { kind: 'travel', placeId: 'tacos', routeProfileId: null } },
    { id: 'buy_pass', label: 'Buy fast passes and join Splash Falls', description: 'Pass price 1500 cents per rider for the whole group.', action: { kind: 'buy_pass_and_join', placeId: 'splash', riderIds: memberIds, quote: quote('q-pass', 1500, memberIds) } },
  ];
}

const setNeeds = (o: GuestObservation, k: 'hunger' | 'fatigue' | 'patience' | 'fun', v: number) => { for (const m of o.members) m.needs = { ...m.needs, [k]: v }; };
const board = (o: GuestObservation, minutes: number, text = `Splash Falls - ${minutes} minutes`, at = o.atMs - 5000) =>
  o.facts.push({ id: `board-${minutes}-${at}`, kind: 'board', placeId: 'splash', source: 'sight', observedAtMs: at, contentVersion: 'board:lab', text, waitLowerMs: minutes * 60_000, waitUpperMs: minutes * 60_000, priceCents: null });
const notice = (o: GuestObservation, text: string) =>
  o.facts.push({ id: 'notice-lab', kind: 'notice', placeId: 'splash', source: 'sight', observedAtMs: o.atMs - 5000, contentVersion: 'notice:lab', text, waitLowerMs: null, waitUpperMs: null, priceCents: null });
const memory = (o: GuestObservation, text: string) => o.recentEventSummaries.push({ eventId: 'mem-lab', atMs: o.atMs - 600_000, text });

export const LAB_CASES: LabCase[] = [
  { id: 'affordability', factor: 'purchase eligibility', description: 'Wallet covers the group pass total (A) vs does not (B). Engine may exclude unaffordable options entirely; here it is offered to observe the provider.',
    target: ['buy_pass'], expect: 'decrease', a: (o) => { o.wallet.balanceCents = 20_000; }, b: (o) => { o.wallet.balanceCents = 3_000; } },
  { id: 'hunger', factor: 'hunger', description: 'Group hunger 15 (A) vs 90 (B).', target: ['travel_tacos'], expect: 'increase', a: (o) => setNeeds(o, 'hunger', 15), b: (o) => setNeeds(o, 'hunger', 90) },
  { id: 'fatigue', factor: 'fatigue', description: 'Group fatigue 10 (A) vs 90 (B).', target: ['rest', 'leave'], expect: 'increase', a: (o) => setNeeds(o, 'fatigue', 10), b: (o) => setNeeds(o, 'fatigue', 90) },
  { id: 'promise_overrun', factor: 'promise overrun', description: 'Earlier posted wait was honored (A) vs overran a 20-minute promise by 35 minutes (B).', target: ['travel_splash', 'buy_pass'], expect: 'decrease',
    a: (o) => memory(o, 'Waited 20 minutes at Splash Falls, as the board promised.'), b: (o) => memory(o, 'Waited 55 minutes at Splash Falls after the board promised 20 minutes.') },
  { id: 'app_exposure', factor: 'app exposure', description: 'Only a stale 70-minute board (A) vs the same board plus a newer app message reporting 10 minutes (B).', target: ['travel_splash'], expect: 'increase',
    a: (o) => board(o, 70, undefined, o.atMs - 600_000),
    b: (o) => { board(o, 70, undefined, o.atMs - 600_000); o.facts.push({ id: 'app-lab', kind: 'message', placeId: 'splash', source: 'app', observedAtMs: o.atMs - 5000, contentVersion: 'msg:lab', text: 'Park app: Splash Falls wait is now about 10 minutes.', waitLowerMs: 600_000, waitUpperMs: 600_000, priceCents: null }); } },
  { id: 'notice_wording', factor: 'changed notice wording', description: 'Notice "Splash Falls: short wait right now" (A) vs "Splash Falls: long delays expected" (B), no numeric wait in either.', target: ['travel_splash'], expect: 'decrease',
    a: (o) => notice(o, 'Splash Falls: short wait right now'), b: (o) => notice(o, 'Splash Falls: long delays expected') },
  { id: 'member_needs', factor: 'group member needs', description: 'All members hunger 15 (A) vs one child at hunger 95 while the others stay at 15 (B).', target: ['travel_tacos'], expect: 'increase',
    a: (o) => setNeeds(o, 'hunger', 15), b: (o) => { setNeeds(o, 'hunger', 15); const kid = o.members.find((m) => m.persona.role === 'child') ?? o.members[0]!; kid.needs = { ...kid.needs, hunger: 95 }; } },
  { id: 'goal', factor: 'goal sensitivity', description: 'No must-do attraction (A) vs Splash Falls is a must-do for every member (B).', target: ['travel_splash', 'buy_pass'], expect: 'increase',
    a: (o) => { for (const m of o.members) m.persona = { ...m.persona, mustDoPlaceIds: [] }; }, b: (o) => { for (const m of o.members) m.persona = { ...m.persona, mustDoPlaceIds: ['splash'] }; } },
  { id: 'memory', factor: 'memory sensitivity', description: 'No memory of Splash Falls (A) vs "Already rode Splash Falls twice today" (B). Direction is not presumed.', target: ['travel_splash', 'buy_pass'], expect: 'changes',
    a: () => undefined, b: (o) => memory(o, 'Already rode Splash Falls twice today.') },
];

/** Irrelevant edits of the neutral state; their effect is the noise floor every case must clear. */
export const PLACEBOS: { id: string; edit: (o: GuestObservation) => void }[] = [
  { id: 'placebo-performer', edit: (o) => memory(o, 'Noticed a street performer near the plaza.') },
  { id: 'placebo-weather', edit: (o) => memory(o, 'Clouds drifted over the lake for a moment.') },
  { id: 'placebo-activity', edit: (o) => { o.currentActivity = 'looking around after rest'; } },
];

export function buildLabRequest(template: DecisionRequest, caseId: string, arm: 'A' | 'B', mutate: (o: GuestObservation) => void, options?: LabCase['options']): DecisionRequest {
  const r = structuredClone(template);
  r.requestId = `plausibility:${caseId}:${arm}`;
  r.runId = 'plausibility-lab';
  r.policyVersion = PLAUSIBILITY_LAB_VERSION;
  r.observation.facts = r.observation.facts.filter((f) => f.placeId !== 'splash');
  r.observation.knownDestinations = [
    { placeId: 'splash', name: 'Splash Falls', walkEstimateMs: 120_000, lastObservedFactIds: [], knownRestrictions: ['Minimum height 100 cm'] },
    { placeId: 'tacos', name: 'Taco Cart', walkEstimateMs: 180_000, lastObservedFactIds: [], knownRestrictions: [] },
    { placeId: 'plaza', name: 'Shady Plaza', walkEstimateMs: 60_000, lastObservedFactIds: [], knownRestrictions: [] },
  ];
  setNeeds(r.observation, 'hunger', 40);
  setNeeds(r.observation, 'fatigue', 40);
  setNeeds(r.observation, 'patience', 50);
  mutate(r.observation);
  const opts = labOptions(r.observation.members.map((m) => m.persona.agentId));
  r.options = options ? options(opts) : opts;
  r.promptOptionOrder = r.options.map((o) => o.id);
  r.candidateAudit = { considered: r.options.map((o) => o.id), excluded: [] };
  r.observationHash = observationHash(r);
  r.optionsHash = optionsHash(r);
  const v = validateDecisionRequest(r);
  if (!v.ok) throw new Error(`lab request ${caseId}/${arm} invalid: ${v.errors.map((e) => e.message).join('; ')}`);
  return r;
}

const mass = (d: Distribution, ids: string[]) => d.filter((p) => ids.includes(p.optionId)).reduce((s, p) => s + p.probability, 0);
const entropy = (d: Distribution) => {
  const h = -d.reduce((s, p) => s + (p.probability > 0 ? p.probability * Math.log(p.probability) : 0), 0);
  return d.length > 1 ? h / Math.log(d.length) : 0;
};
const l1 = (a: Distribution, b: Distribution) => a.reduce((s, p) => s + Math.abs(p.probability - (b.find((q) => q.optionId === p.optionId)?.probability ?? 0)), 0);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export type StateEvidence = {
  requestId: string; observationHash: string; modelReturned: string | null;
  probabilities: Distribution | null; targetMass: number | null; normalizedEntropy: number | null;
  sampleCounts: Record<string, number> | null; error: string | null;
};
export type CaseEvidence = {
  id: string; factor: string; description: string; target: string[]; expect: Expectation;
  a: StateEvidence; b: StateEvidence; shift: number | null; l1Distance: number | null;
  /** Thresholds from the placebo noise floor: |shift| must exceed shiftThreshold (or L1 the l1Threshold for "changes"). */
  shiftThreshold: number | null; l1Threshold: number | null; verdict: Verdict;
};
export type PlausibilityEvidence = {
  schema: 'plausibility-evidence.v1'; label: string; labVersion: string;
  evidenceKind: 'mock-mechanical-check' | 'real-provider-observation';
  provider: { source: string; modelRequested: string; modelsReturned: string[]; instructionsVersion: string };
  samplesPerState: number; samplingNote: string; sampleSeed: string;
  noiseFloor: { neutral: StateEvidence; placebos: (StateEvidence & { id: string; l1FromNeutral: number | null })[]; maxL1: number | null; note: string };
  cases: CaseEvidence[];
  summary: { cases: number; asExpected: number; opposite: number; flat: number; sensitive: number; errors: number; distinctTopOptions: number; meanNormalizedEntropy: number | null };
  limitations: string[];
};

export async function runPlausibilityLab(input: {
  provider: BehaviorProvider; template: DecisionRequest; cases?: LabCase[]; samplesPerState?: number; sampleSeed?: string; signal?: AbortSignal;
}): Promise<PlausibilityEvidence> {
  const cases = input.cases ?? LAB_CASES;
  const n = input.samplesPerState ?? 200;
  const seed = input.sampleSeed ?? 'plausibility-seed-1';
  const signal = input.signal ?? new AbortController().signal;
  const models = new Set<string>();
  const state = async (c: Pick<LabCase, 'id' | 'target' | 'options'>, arm: 'A' | 'B', edit: (o: GuestObservation) => void): Promise<StateEvidence> => {
    const req = buildLabRequest(input.template, c.id, arm, edit, c.options);
    try {
      const r = await input.provider.decide(req, { signal, callId: `${req.requestId}:call` });
      const v = validateDistribution(req.options.map((o) => o.id), r.probabilities);
      if (!v.ok) return { requestId: req.requestId, observationHash: req.observationHash, modelReturned: r.modelReturned, probabilities: null, targetMass: null, normalizedEntropy: null, sampleCounts: null, error: `invalid distribution: ${v.errors.map((e) => e.message).join('; ')}` };
      models.add(r.modelReturned);
      const d = v.value.raw;
      const counts: Record<string, number> = Object.fromEntries(d.map((p) => [p.optionId, 0]));
      for (let i = 0; i < n; i++) counts[referenceInverseCdf(d, semanticUniform(seed, 'plausibility', c.id, arm, i))]! += 1;
      return { requestId: req.requestId, observationHash: req.observationHash, modelReturned: r.modelReturned, probabilities: d.map((p) => ({ optionId: p.optionId, probability: r4(p.probability) })), targetMass: r4(mass(d, c.target)), normalizedEntropy: r4(entropy(d)), sampleCounts: counts, error: null };
    } catch (e) {
      return { requestId: req.requestId, observationHash: req.observationHash, modelReturned: null, probabilities: null, targetMass: null, normalizedEntropy: null, sampleCounts: null, error: (e as Error).message };
    }
  };
  const neutral = await state({ id: 'neutral', target: [] }, 'A', () => undefined);
  const placebos: PlausibilityEvidence['noiseFloor']['placebos'] = [];
  for (const p of PLACEBOS) {
    const s = await state({ id: p.id, target: [] }, 'B', p.edit);
    placebos.push({ ...s, id: p.id, l1FromNeutral: s.probabilities && neutral.probabilities ? r4(l1(neutral.probabilities, s.probabilities)) : null });
  }
  const floorOk = neutral.probabilities !== null && placebos.every((p) => p.probabilities);
  const maxL1 = floorOk ? Math.max(0, ...placebos.map((p) => p.l1FromNeutral!)) : null;
  const placeboShift = (target: string[]) => floorOk ? Math.max(0, ...placebos.map((p) => Math.abs(mass(p.probabilities!, target) - mass(neutral.probabilities!, target)))) : null;

  const out: CaseEvidence[] = [];
  for (const c of cases) {
    const a = await state(c, 'A', c.a);
    const b = await state(c, 'B', c.b);
    let verdict: Verdict = 'error';
    let shift: number | null = null;
    let dist: number | null = null;
    const noise = placeboShift(c.target);
    const shiftThreshold = noise === null || maxL1 === null ? null : r4(Math.max(MIN_SHIFT, 2 * noise, maxL1 / 2));
    const l1Threshold = maxL1 === null ? null : r4(Math.max(2 * MIN_SHIFT, 2 * maxL1));
    if (a.probabilities && b.probabilities && shiftThreshold !== null && l1Threshold !== null) {
      shift = r4(b.targetMass! - a.targetMass!);
      dist = r4(l1(a.probabilities, b.probabilities));
      if (c.expect === 'changes') verdict = dist > l1Threshold ? 'sensitive' : 'flat';
      else if (Math.abs(shift) <= shiftThreshold) verdict = 'flat';
      else verdict = (shift > 0) === (c.expect === 'increase') ? 'as_expected' : 'opposite';
    }
    out.push({ id: c.id, factor: c.factor, description: c.description, target: c.target, expect: c.expect, a, b, shift, l1Distance: dist, shiftThreshold, l1Threshold, verdict });
  }
  const states = out.flatMap((c) => [c.a, c.b]).filter((s) => s.probabilities);
  const top = new Set(states.map((s) => [...s.probabilities!].sort((x, y) => y.probability - x.probability)[0]!.optionId));
  const count = (v: Verdict) => out.filter((c) => c.verdict === v).length;
  const real = input.provider.source === 'jev';
  return {
    schema: 'plausibility-evidence.v1', label: PLAUSIBILITY_LABEL, labVersion: PLAUSIBILITY_LAB_VERSION,
    evidenceKind: real ? 'real-provider-observation' : 'mock-mechanical-check',
    provider: { source: input.provider.source, modelRequested: input.provider.model, modelsReturned: [...models].sort(), instructionsVersion: input.provider.instructionsVersion },
    samplesPerState: n, sampleSeed: seed,
    samplingNote: 'One provider call per state; sample counts are seeded draws from that returned vector by the lab (not by the worker), showing diversity rather than new provider evidence.',
    noiseFloor: {
      neutral, placebos, maxL1: maxL1 === null ? null : r4(maxL1),
      note: 'Placebo states change only irrelevant text. A directional case counts as moved only if |target-mass shift| exceeds max(0.01, 2 x largest placebo shift on that target, largest placebo L1 / 2); a "changes" case only if its L1 exceeds max(0.02, 2 x largest placebo L1).',
    },
    cases: out,
    summary: {
      cases: out.length, asExpected: count('as_expected'), opposite: count('opposite'), flat: count('flat'), sensitive: count('sensitive'), errors: count('error'),
      distinctTopOptions: top.size, meanNormalizedEntropy: states.length ? r4(states.reduce((s, x) => s + x.normalizedEntropy!, 0) / states.length) : null,
    },
    limitations: [
      'States are synthetic edits of one fixture observation; they are not sampled from real guests or calibrated against attendance data.',
      'Expected directions are design hypotheses, not ground truth; "opposite" or "flat" is reported, never hidden or retried.',
      real
        ? 'Real-provider observation: tendencies of this model version on these states only; one call per state, so provider sampling variability is not measured.'
        : 'Mock-mechanical check: the deterministic mock policy was built with some of these mechanisms (needs, wallet, goals, posted waits) and none for wording, promise overrun or memory; it proves plumbing, not that a real provider behaves this way.',
    ],
  };
}
