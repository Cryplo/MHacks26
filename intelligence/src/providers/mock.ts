/**
 * MOCK provider (source "mock"): a deterministic, versioned probability policy for infrastructure
 * demonstrations and mechanical tests. It is NOT a model of human behavior and never selects an
 * action; it only returns a probability vector over the exact offered options.
 */
import type { ActionOption, DecisionRequest, GuestObservation, RatingRequest } from '../../contract/behavior-v1.ts';
import { canonicalBytes, canonicalJson } from '../core/canonical.ts';
import { semanticUniform } from '../core/random.ts';
import type { BehaviorProvider, ProviderDecision, ProviderRating } from './types.ts';
import { estimateTokens } from './types.ts';

export const MOCK_MODEL = 'mock-policy-v1';

function groupNeeds(o: GuestObservation) {
  const n = o.members.length || 1;
  const avg = (k: 'hunger' | 'fatigue' | 'patience' | 'fun') => o.members.reduce((s, m) => s + m.needs[k], 0) / n / 100;
  return { hunger: avg('hunger'), fatigue: avg('fatigue'), patience: avg('patience'), fun: avg('fun') };
}

function mustDo(o: GuestObservation): Set<string> {
  return new Set(o.members.flatMap((m) => m.persona.mustDoPlaceIds));
}

function observedWaitUpperMin(o: GuestObservation, placeId: string): number | null {
  const f = o.facts.filter((x) => x.placeId === placeId && x.waitUpperMs !== null).sort((a, b) => b.observedAtMs - a.observedAtMs)[0];
  return f ? f.waitUpperMs! / 60000 : null;
}

/** Unnormalized weight for one option; interpretable mechanical tendencies only. */
export function mockWeight(o: GuestObservation, opt: ActionOption): number {
  const n = groupNeeds(o);
  const md = mustDo(o);
  const balance = o.wallet.balanceCents;
  const thrill = o.members.reduce((s, m) => s + m.persona.thrillPreference, 0) / (o.members.length || 1);
  const remainingMin = Math.max(0, (o.plannedDepartureMs - o.atMs) / 60000);
  const a = opt.action;
  switch (a.kind) {
    case 'browse': return 0.6 + 0.4 * n.fatigue;
    case 'continue': return 0.8;
    case 'rest': return 0.3 + 2.5 * n.fatigue ** 2;
    // Leaving before the planned departure is rare unless the group is exhausted or out of
    // patience; it becomes likely in the last half hour and dominant once the plan is overdue.
    case 'leave_park': return 0.01 + 3 * Math.max(0, n.fatigue - 0.5) ** 2 + (remainingMin < 30 ? 2 : 0) + (remainingMin <= 0 ? 4 : 0) + 0.5 * Math.max(0, 0.25 - n.patience);
    case 'travel': case 'join_queue': case 'notice_enter': {
      const wait = observedWaitUpperMin(o, a.placeId);
      const tolerance = 15 + 60 * n.patience;
      const waitPenalty = wait === null ? 1 : Math.exp(-Math.max(0, wait - tolerance) / 20);
      const isFood = /food|eat|snack|taco|cone|lunch/i.test(`${opt.label} ${opt.description}`);
      return (0.6 + (md.has(a.placeId) ? 1.5 : 0) + (isFood ? 2.5 * n.hunger ** 2 : 0.5 * thrill)) * waitPenalty;
    }
    case 'buy_pass_and_join': {
      if (a.quote.totalCents > balance) return 1e-6;
      const share = balance > 0 ? a.quote.totalCents / balance : 1;
      const wait = observedWaitUpperMin(o, a.placeId) ?? 0;
      return (0.2 + (md.has(a.placeId) ? 0.8 : 0) + wait / 60) * Math.max(0.02, 1 - share);
    }
    case 'order': {
      const total = a.cart.reduce((s, q) => s + q.totalCents, 0);
      if (total > balance) return 1e-6;
      return (0.2 + 3 * n.hunger ** 2) * Math.max(0.05, 1 - total / Math.max(1, balance));
    }
    case 'leave_queue': return 0.1 + 1.5 * (1 - n.patience) ** 2;
    case 'notice_stop': return 0.3 + 1.2 * n.hunger;
    case 'route': return 1;
    case 'bump_response': return a.response === 'continue' ? 1 : 0.6;
    case 'regroup': return 1.2;
  }
}

export function mockDistribution(req: DecisionRequest): { optionId: string; probability: number }[] {
  const weights = req.options.map((opt) => {
    const jitter = 0.9 + 0.2 * semanticUniform(MOCK_MODEL, 'mock', req.observationHash, opt.id);
    return Math.max(1e-9, mockWeight(req.observation, opt) * jitter);
  });
  const total = weights.reduce((s, w) => s + w, 0);
  return req.options.map((opt, i) => ({ optionId: opt.id, probability: weights[i]! / total }));
}

export function mockRatingDistribution(req: RatingRequest): number[] {
  const k = req.levels.length;
  const me = req.observation.members.find((m) => m.persona.agentId === req.agentId);
  if (!me) throw new Error(`rated member ${req.agentId} is not in the observation`);
  const needs = me.needs;
  const center = Math.max(0, Math.min(1, (needs.fun * 0.5 + needs.patience * 0.3 + (100 - needs.hunger) * 0.1 + (100 - needs.fatigue) * 0.1) / 100)) * (k - 1);
  const w = Array.from({ length: k }, (_, i) => Math.exp(-((i - center) ** 2) / 1.2));
  const t = w.reduce((s, v) => s + v, 0);
  return w.map((v) => v / t);
}

export class MockProvider implements BehaviorProvider {
  readonly source = 'mock' as const;
  readonly model = MOCK_MODEL;
  readonly instructionsVersion = 'mock-instructions-v1';

  estimateInputTokens(req: DecisionRequest | RatingRequest): number {
    return estimateTokens(canonicalJson(req.observation));
  }

  async decide(req: DecisionRequest): Promise<ProviderDecision> {
    const probabilities = mockDistribution(req);
    const raw = canonicalBytes({ mock: true, model: MOCK_MODEL, note: 'Deterministic mock policy, not a vendor response.', probabilities });
    return { raw, modelReturned: MOCK_MODEL, probabilities, confidence: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, httpMs: 0 };
  }

  async rate(req: RatingRequest): Promise<ProviderRating> {
    const probabilities = mockRatingDistribution(req);
    const score = probabilities.reduce((best, p, i) => (p > probabilities[best]! ? i : best), 0);
    const raw = canonicalBytes({ mock: true, model: MOCK_MODEL, note: 'Deterministic mock rating, not a vendor response.', score, probabilities });
    return { raw, modelReturned: MOCK_MODEL, probabilities, score, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, httpMs: 0 };
  }
}
