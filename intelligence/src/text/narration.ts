import type { AppliedDecision, Id, Narrative } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';
import { observationHash, optionsHash, validateDistribution } from '../core/validate.ts';

export const NARRATION_VERSION = 'narration-v1';

export const NARRATION_LIMITATIONS = [
  'Describes the observed context and the action the Engine sampled; it is not the model\'s internal reasoning.',
  'Probabilities are model outputs over the offered options; they do not establish why the guest acted or any causal effect.',
  'Synthetic guest in a modeled park; not a real visitor.',
];

/** Checks that the evidence is internally consistent and names the member. Empty means valid. */
export function validateEvidence(e: AppliedDecision, agentId: Id): string[] {
  const errors: string[] = [];
  const req = e.request;
  if (!req || !e.response) return ['evidence lacks request/response'];
  if (!req.agentIds.includes(agentId)) errors.push(`agent ${agentId} is not part of decision ${req.requestId}`);
  if (e.response.requestId !== req.requestId) errors.push('response does not answer this request');
  if (e.response.observationHash !== req.observationHash || observationHash(req) !== req.observationHash) errors.push('observation hash mismatch');
  if (e.response.optionsHash !== req.optionsHash || optionsHash(req) !== req.optionsHash) errors.push('options hash mismatch');
  const ids = req.options.map((o) => o.id);
  if (!ids.includes(e.chosenOptionId)) errors.push('chosen option is not one of the offered options');
  const d = validateDistribution(ids, e.appliedProbabilities);
  if (!d.ok) errors.push(`applied probabilities invalid: ${d.errors.map((x) => x.message).join('; ')}`);
  if (e.outcome !== 'committed' && e.outcome !== 'failed_precondition') errors.push('unknown outcome');
  if ((e.outcome === 'failed_precondition') !== (e.failureReason !== null)) errors.push('failure reason inconsistent with outcome');
  return errors;
}

export function narrationId(e: AppliedDecision, agentId: Id, version = NARRATION_VERSION): Id {
  return `narr-${hashCanonical({ evidenceId: e.evidenceId, agentId, version }).slice(0, 32)}`;
}

const pct = (p: number) => `${(Math.round(p * 1000) / 10).toFixed(1)}%`;
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
function elapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m after opening`;
}

/** Deterministic, offline narration built only from the frozen evidence. */
export function templateSentences(e: AppliedDecision, agentId: Id): string[] {
  const req = e.request;
  const obs = req.observation;
  const member = obs.members.find((m) => m.persona.agentId === agentId);
  const who = member ? `${member.persona.role}, ${member.persona.ageYears}` : 'group member';
  const out: string[] = [];
  out.push(`Synthetic guest ${agentId} (${who}) in a group of ${obs.members.length} faced a "${req.moment}" decision ${elapsed(req.createdAtMs)}.`);
  const seen = obs.facts.slice(0, 3).map((f) => `"${f.text}" (${f.kind}, ${f.source})`);
  if (seen.length) out.push(`They had observed ${seen.join('; ')}; group wallet ${dollars(obs.wallet.balanceCents)}.`);
  else out.push(`No posted information was in view; group wallet ${dollars(obs.wallet.balanceCents)}.`);
  const byId = new Map(e.appliedProbabilities.map((p) => [p.optionId, p.probability]));
  const ranked = [...req.options].sort((a, b) => (byId.get(b.id)! - byId.get(a.id)!) || (a.id < b.id ? -1 : 1));
  out.push(`The model gave ${ranked.map((o) => `${o.label} ${pct(byId.get(o.id)!)}`).join(', ')} across ${req.options.length} offered options.`);
  const chosen = req.options.find((o) => o.id === e.chosenOptionId)!;
  out.push(e.outcome === 'committed'
    ? `The Engine sampled "${chosen.label}" and committed it.`
    : `The Engine sampled "${chosen.label}", but it failed a precondition (${e.failureReason}).`);
  return out;
}

/** Every number and quoted string that narration is allowed to state. */
export function groundedTokens(e: AppliedDecision, agentId: Id): { numbers: Set<string>; text: string } {
  const sentences = templateSentences(e, agentId);
  const numbers = new Set<string>();
  const add = (s: string) => { for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) { numbers.add(m[0]); numbers.add(String(Number(m[0]))); } };
  for (const s of sentences) add(s);
  for (const p of e.appliedProbabilities) { add(String(Math.round(p.probability * 100))); add(pct(p.probability)); }
  const obs = e.request.observation;
  for (const f of obs.facts) { add(f.text); for (const v of [f.waitLowerMs, f.waitUpperMs]) if (v !== null) add(String(v / 60_000)); if (f.priceCents !== null) add(dollars(f.priceCents)); }
  for (const o of e.request.options) { add(o.label); add(o.description); }
  for (const m of obs.members) { add(String(m.persona.ageYears)); for (const v of Object.values(m.needs)) add(String(v)); }
  add(String(obs.wallet.balanceCents / 100));
  return { numbers, text: sentences.join(' ') };
}

const FORBIDDEN_PROSE: [RegExp, string][] = [
  [/\b(internal(ly)?|chain of thought|thought process|reasoned|deliberat|weighed|the model (thought|felt|wanted|believed|decided because))\b/i, 'claims access to internal model reasoning'],
  [/\b(caused|because of the probabilit|proves?|guarantee)/i, 'claims causality from probabilities'],
  [/\b(ignore (all|previous)|system prompt|api key|jv_[a-z0-9]|bearer\s)/i, 'contains instruction or secret-like text'],
  [/\b(schedule|cancel|close|set price|issue|grant)\b.*\b(command|run|event|refund)\b/i, 'reads like an operational command'],
];

/** Rejects ungrounded numbers, invented quotations and causal/internal-reasoning claims. */
export function checkNarrationProse(text: string, e: AppliedDecision, agentId: Id): string[] {
  const reasons: string[] = [];
  if (typeof text !== 'string' || !text.trim()) return ['empty narration'];
  if (text.length > 700) reasons.push('narration longer than 700 characters');
  if ((text.match(/[.!?](\s|$)/g)?.length ?? 0) > 5) reasons.push('more than five sentences');
  const g = groundedTokens(e, agentId);
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) if (!g.numbers.has(m[0]) && !g.numbers.has(String(Number(m[0])))) reasons.push(`ungrounded number ${m[0]}`);
  for (const m of text.matchAll(/["“]([^"”]+)["”]/g)) {
    const q = m[1]!.toLowerCase();
    const known = e.request.observation.facts.some((f) => f.text.toLowerCase().includes(q)) || e.request.options.some((o) => o.label.toLowerCase() === q);
    if (!known) reasons.push(`quotes text that was not observed: "${m[1]}"`);
  }
  for (const [re, why] of FORBIDDEN_PROSE) if (re.test(text)) reasons.push(why);
  return reasons;
}

export interface NarrationProvider {
  readonly model: string;
  readonly promptVersion: string;
  narrate(input: { sentences: string[]; agentId: Id }, signal?: AbortSignal): Promise<string>;
}

export type NarrationOutcome = { narrative: Narrative; fallbackReason: string | null };

/** Narration for one member of one immutable decision. Labeled "narrated from state". */
export async function narrateDecision(e: AppliedDecision, agentId: Id, provider: NarrationProvider | null = null, signal?: AbortSignal): Promise<NarrationOutcome> {
  const errs = validateEvidence(e, agentId);
  if (errs.length) throw new Error(`invalid evidence: ${errs.join('; ')}`);
  const sentences = templateSentences(e, agentId);
  const evidenceHash = hashCanonical(e);
  const build = (origin: Narrative['origin'], text: string, version: string): Narrative => ({
    id: narrationId(e, agentId, version), evidenceHash, origin, label: 'narrated from state',
    sections: [{ heading: `Decision ${e.evidenceId}`, segments: [{ kind: 'text', text }] }],
    limitations: [...NARRATION_LIMITATIONS, ...(origin === 'template' ? [`Deterministic template ${NARRATION_VERSION}.`] : [`Prose by ${provider!.model} (${provider!.promptVersion}), validated against the evidence.`])],
  });
  const template = build('template', sentences.join(' '), NARRATION_VERSION);
  if (!provider) return { narrative: template, fallbackReason: null };
  let text: string;
  try { text = await provider.narrate({ sentences, agentId }, signal); } catch (err) {
    return { narrative: template, fallbackReason: `provider error: ${(err as Error).message}` };
  }
  const reasons = checkNarrationProse(text, e, agentId);
  if (reasons.length) return { narrative: template, fallbackReason: reasons.join('; ') };
  return { narrative: build('llm', text.trim(), `${NARRATION_VERSION}+${provider.promptVersion}`), fallbackReason: null };
}
