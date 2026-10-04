/**
 * Pure view-model helpers for the evidence inspector (unit tested). They only reorganize
 * Engine's recorded data; nothing here re-samples or re-derives a decision.
 */
import type { AgentDetail, AppliedDecision, Id, ObservationFact, PlaceView, Source } from '../../../contract/behavior-v1';
import { compareCodeUnits } from '../../domain/canonical';

export type OptionRow = {
  id: Id; label: string; description: string; raw: number | null; applied: number | null;
  normalizationDiffers: boolean; highest: boolean; sampled: boolean; promptPosition: number; cdfFrom: number; cdfTo: number;
};

export function optionRows(e: AppliedDecision): OptionRow[] {
  const raw = new Map(e.response.probabilities.map((p) => [p.optionId, p.probability]));
  const applied = new Map(e.appliedProbabilities.map((p) => [p.optionId, p.probability]));
  const max = Math.max(...e.appliedProbabilities.map((p) => p.probability));
  // Inverse-CDF intervals in ascending option-ID order (how the draw maps to an option).
  const intervals = new Map<Id, [number, number]>();
  let acc = 0;
  for (const p of [...e.appliedProbabilities].sort((a, b) => compareCodeUnits(a.optionId, b.optionId))) {
    intervals.set(p.optionId, [acc, acc + p.probability]);
    acc += p.probability;
  }
  const order = e.request.promptOptionOrder.length ? e.request.promptOptionOrder : e.request.options.map((o) => o.id);
  return order.map((id, i) => {
    const o = e.request.options.find((x) => x.id === id);
    const r = raw.get(id) ?? null; const a = applied.get(id) ?? null;
    const [from, to] = intervals.get(id) ?? [0, 0];
    return {
      id, label: o?.label ?? id, description: o?.description ?? '', raw: r, applied: a,
      normalizationDiffers: r !== null && a !== null && Math.abs(r - a) > 1e-12,
      highest: a !== null && a === max, sampled: id === e.chosenOptionId, promptPosition: i + 1, cdfFrom: from, cdfTo: to,
    };
  });
}

export function sourceLabel(source: Source, original: Exclude<Source, 'cache'>, model: string): { text: string; tone: 'ok' | 'warn' | 'info' } {
  switch (source) {
    case 'jev': return { text: `Jev distribution (${model})`, tone: 'ok' };
    case 'cache': return { text: `Cached distribution, originally from ${original === 'jev' ? 'Jev' : original}. The action was sampled from it; nothing was copied from another guest.`, tone: original === 'jev' ? 'info' : 'warn' };
    case 'mock': return { text: `Mock provider (${model}) — not Jev`, tone: 'warn' };
    case 'fallback': return { text: 'Live-timeout fallback — a safety bridge, not evidence of Jev behavior', tone: 'warn' };
  }
}

/** How a group decision relates to the selected guest. */
export function governance(detail: AgentDetail): { governed: boolean; text: string } {
  const e = detail.evidence;
  if (!e) return { governed: false, text: 'No decision recorded yet for this guest\'s group.' };
  const governed = e.request.agentIds.includes(detail.agent.agentId);
  const n = e.request.agentIds.length;
  if (!governed) return { governed, text: 'This decision did not govern the selected guest.' };
  if (n === 1) return { governed, text: 'Decision for this guest alone.' };
  const lead = e.request.observation.leaderId;
  return {
    governed,
    text: detail.agent.agentId === lead
      ? `Group decision governing ${n} members; this guest is the group leader.`
      : `Group decision governing ${n} members (leader ${lead}). This guest did not have an independently sampled action.`,
  };
}

export type KnowledgeRow = { placeId: Id; guestFacts: ObservationFact[]; truth: PlaceView | null };

/** Operator-only comparison. Guest side uses ONLY the guest's observed facts. */
export function knowledgeVsTruth(facts: ObservationFact[], places: ReadonlyMap<Id, PlaceView>): KnowledgeRow[] {
  const ids = [...new Set(facts.map((f) => f.placeId).filter((p): p is Id => p !== null))];
  return ids.map((placeId) => ({ placeId, guestFacts: facts.filter((f) => f.placeId === placeId), truth: places.get(placeId) ?? null }));
}

/** Deterministic, local, state-based narration used when the narration job is unavailable. */
export function narrateFromState(e: AppliedDecision, agentId: Id): string {
  const chosen = e.request.options.find((o) => o.id === e.chosenOptionId);
  const p = e.appliedProbabilities.find((x) => x.optionId === e.chosenOptionId)?.probability;
  const who = e.request.agentIds.length > 1 ? `The group of ${e.request.agentIds.length} (including ${agentId})` : `Guest ${agentId}`;
  return `${who} had ${e.request.options.length} recorded options at a "${e.request.moment.replace(/_/g, ' ')}" moment. `
    + `The recorded draw selected "${chosen?.label ?? e.chosenOptionId}"${p !== undefined ? `, which had an assigned probability of ${(p * 100).toFixed(1)}%` : ''}. `
    + `Outcome: ${e.outcome === 'committed' ? 'committed' : `failed (${e.failureReason ?? 'precondition'})`}.`;
}
