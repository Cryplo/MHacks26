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
    case 'laya': return { text: `Local Laya distribution (${model}) — on-device inference`, tone: 'ok' };
    case 'jev': return { text: `Jev distribution (${model})`, tone: 'ok' };
    case 'cache': return { text: `Cached distribution, originally from ${original === 'jev' ? 'Jev' : original === 'laya' ? 'Local Laya' : original}. The action was sampled from it; nothing was copied from another guest.`, tone: (original === 'jev' || original === 'laya') ? 'info' : 'warn' };
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

/** Plain-language name for a decision moment (what prompted the guest to decide). */
export const MOMENT_LABEL: Record<string, string> = {
  forced_replan: 'Plans were interrupted', what_next: 'Choosing what to do next', noticed: 'Noticed something',
  join_line: 'Deciding whether to join a line', stay_line: 'Deciding whether to stay in line', hungry_tired: 'Feeling hungry or tired',
  message_seen: 'Read an app message', closing_soon: 'Park closing soon', route_choice: 'Choosing a route', bumped: 'Got bumped into',
  separated: 'Separated from the group',
};
export const momentLabel = (m: string) => MOMENT_LABEL[m] ?? m.replace(/_/g, ' ');

/** Engine's recorded explanation (additive `rationale`), read defensively; null when absent. */
export function recordedRationale(e: AppliedDecision): { summary: string; drivers: string[]; modelReasoning: string | null } | null {
  const r = (e as { rationale?: unknown }).rationale;
  const modelText = typeof e.response.reasoning === 'string' && e.response.reasoning.trim() ? e.response.reasoning.trim() : null;
  if (typeof r === 'string' && r.trim()) return { summary: r.trim(), drivers: [], modelReasoning: modelText };
  if (r && typeof r === 'object' && typeof (r as { summary?: unknown }).summary === 'string' && (r as { summary: string }).summary.trim()) {
    const o = r as { summary: string; drivers?: unknown; modelReasoning?: unknown };
    const drivers = Array.isArray(o.drivers) ? o.drivers.filter((d): d is string => typeof d === 'string' && d.trim() !== '') : [];
    const mr = typeof o.modelReasoning === 'string' && o.modelReasoning.trim() ? o.modelReasoning.trim() : modelText;
    return { summary: o.summary.trim(), drivers, modelReasoning: mr };
  }
  return null;
}

export function salientNeeds(n: { hunger: number; fatigue: number; patience: number; fun: number }): string[] {
  const out: string[] = [];
  if (n.hunger >= 60) out.push(`hungry (${Math.round(n.hunger)}/100)`);
  if (n.fatigue >= 60) out.push(`tired (${Math.round(n.fatigue)}/100)`);
  if (n.patience <= 35) out.push(`low on patience (${Math.round(n.patience)}/100)`);
  if (n.fun <= 30) out.push(`looking for some fun (${Math.round(n.fun)}/100)`);
  return out;
}

const pct = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;

export function deriveRationale(e: AppliedDecision, agentId: Id): string {
  const obs = e.request.observation;
  const self = obs.members.find((m) => m.persona.agentId === agentId) ?? obs.members.find((m) => m.persona.agentId === obs.leaderId) ?? obs.members[0];
  const group = e.request.agentIds.length > 1;
  const subject = group ? 'The group' : 'They';
  const parts: string[] = [];
  const needs = self ? salientNeeds(self.needs) : [];
  if (needs.length) parts.push(`${group ? (self?.persona.agentId === agentId ? 'This guest was' : 'The group leader was') : 'They were'} ${needs.join(' and ')}.`);
  const facts = obs.facts.slice(-2).map((f) => `“${f.text}”`);
  if (facts.length) parts.push(`${group ? 'The group' : 'They'} had just seen ${facts.join(' and ')}.`);
  const rows = optionRows(e);
  const chosen = rows.find((r) => r.sampled);
  const best = rows.find((r) => r.highest);
  if (chosen) {
    const p = chosen.applied ?? 0;
    let s = `${facts.length || needs.length ? 'So they' : subject} chose “${chosen.label}” (${pct(p)})`;
    if (chosen.highest) s += rows.length > 1 ? `, the most likely of ${rows.length} options.` : '.';
    else if (best) s += `, even though “${best.label}” was more likely (${pct(best.applied ?? 0)}); the recorded draw landed on a less likely option.`;
    else s += '.';
    parts.push(s);
  }
  if (e.outcome !== 'committed') parts.push(`It could not be carried out (${e.failureReason ?? 'precondition failed'}).`);
  return parts.join(' ');
}
