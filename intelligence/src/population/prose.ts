import type { Persona } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';
import type { SampledGroup, SampledPersona } from './sampler.ts';

export const TEMPLATE_PROSE_VERSION = 'template-prose-v1';
export const PROSE_PROMPT_VERSION = 'prose-prompt-v1';

/** The only facts a backstory may express. Prose never feeds back into structured traits. */
export type ProseFacts = {
  parkLabel: string;
  role: Persona['role']; ageYears: number; groupSize: number;
  companions: Persona['role'][]; occasion: string;
  mustDoNames: string[]; aspirationNames: string[];
  hasApp: boolean; stroller: boolean;
  /** Every place name in the park; used to reject prose naming an unlisted destination. */
  forbiddenPlaceNames: string[];
};

export function proseFacts(p: SampledPersona, g: SampledGroup, all: Map<string, SampledPersona>, parkLabel: string, placeNames: string[]): ProseFacts {
  const mustDoNames = p.hooks.mustDo.map((h) => h.name);
  const aspirationNames = p.hooks.infeasibleAspirations.map((h) => h.name);
  return {
    parkLabel: parkLabel.replace(/\s*\(.*\)$/, ''),
    role: p.role, ageYears: p.ageYears, groupSize: g.memberIds.length,
    companions: g.memberIds.filter((id) => id !== p.agentId).map((id) => all.get(id)!.role),
    occasion: p.occasion, mustDoNames, aspirationNames, hasApp: p.hasApp, stroller: p.stroller,
    forbiddenPlaceNames: placeNames.filter((n) => !mustDoNames.includes(n) && !aspirationNames.includes(n)),
  };
}

const ROLE_NOUN: Record<Persona['role'], string> = { parent: 'parent', child: 'child', teen: 'teenager', adult: 'adult', senior: 'older adult' };
const OCCASION_PHRASE: Record<string, string> = {
  birthday: 'a birthday outing', school_break: 'a school-break trip', vacation: 'a vacation day', local_day_out: 'a local day out',
  anniversary: 'an anniversary', date_day: 'a day out together', season_opener: 'the start of the season', reunion: 'a reunion',
  grandchild_free_day: 'a day out with friends',
};

function companionsPhrase(companions: Persona['role'][]): string {
  if (companions.length === 0) return 'alone';
  const counts = new Map<string, number>();
  for (const c of companions) counts.set(c, (counts.get(c) ?? 0) + 1);
  const words = [...counts.entries()].map(([role, n]) => {
    const noun = ROLE_NOUN[role as Persona['role']];
    const plural = role === 'child' ? 'children' : `${noun}s`;
    return n === 1 ? `one ${noun}` : `${['', '', 'two', 'three', 'four'][n] ?? String(n)} ${plural}`;
  });
  return `with ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}`;
}

/** Deterministic baseline prose: rephrases fixed facts only. */
export function templateBackstory(f: ProseFacts): string {
  const parts = [`Synthetic persona: a ${f.ageYears}-year-old ${ROLE_NOUN[f.role]} visiting ${f.parkLabel} ${companionsPhrase(f.companions)} for ${OCCASION_PHRASE[f.occasion] ?? 'a day out'}.`];
  if (f.mustDoNames.length) parts.push(`Hopes to visit ${f.mustDoNames.join(' and ')}.`);
  if (f.aspirationNames.length) parts.push(`Would love to try ${f.aspirationNames.join(' and ')}, an aspiration that the posted height rule rules out for the group today.`);
  if (f.stroller) parts.push('Travels in a stroller.');
  return parts.join(' ');
}

const FORBIDDEN_TERMS = [
  /\$|\bdollars?\b|\bcents?\b|\bbudget\b|\bspend\b|\bafford/i,
  /\ballerg|\bdiabet|\basthma|\bmedic|\bwheelchair|\bdisab|\binjur|\bpregnan|\bautis|\billness|\bsick\b|\bcondition\b/i,
  /\bvip\b|\bfast ?pass\b|\bfree\b|\bcoupon\b|\bdiscount\b|\bupgrade\b|\bentitle|\bmember(ship)?\b|\bvoucher\b/i,
  /\bmust leave\b|\bdeadline\b|\bby \d|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\bo'clock\b|\bcurfew\b/i,
  /\bmust\b|\bhas to\b|\bneeds to\b|\bwithout fail\b/i,
  /\bignore (all|previous)\b|\bsystem prompt\b|\binstruction/i,
];

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * Validates candidate prose against its facts. Rejects new money, medical, entitlement, deadline,
 * restriction or must-do claims, unlisted place names, and numbers that are not fixed facts.
 */
export function validateBackstory(text: string, f: ProseFacts): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (typeof text !== 'string' || text.trim().length < 20 || text.length > 600) reasons.push('length out of bounds');
  for (const re of FORBIDDEN_TERMS) if (re.test(text)) reasons.push(`forbidden claim pattern ${re.source}`);
  const allowed = new Set([f.ageYears, f.groupSize, f.groupSize - 1, f.companions.length]);
  for (const role of new Set(f.companions)) allowed.add(f.companions.filter((c) => c === role).length);
  for (const m of text.matchAll(/\d+(\.\d+)?/g)) if (!allowed.has(Number(m[0]))) reasons.push(`ungrounded number ${m[0]}`);
  for (const m of text.toLowerCase().matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g)) {
    if (!allowed.has(NUMBER_WORDS[m[1]!]!)) reasons.push(`ungrounded number word ${m[1]}`);
  }
  for (const name of f.forbiddenPlaceNames) if (text.toLowerCase().includes(name.toLowerCase())) reasons.push(`mentions unlisted place ${name}`);
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

export interface ProseProvider {
  readonly model: string;
  readonly promptVersion: string;
  generate(facts: ProseFacts, signal?: AbortSignal): Promise<string>;
}

export type ProseOutcome = { backstory: string; origin: 'template' | 'llm'; fallbackReason: string | null; cacheKey: string };

/** Cache key over the COMPLETE structured input plus prompt/model versions. */
export function proseCacheKey(f: ProseFacts, model: string, promptVersion: string): string {
  return hashCanonical({ kind: 'persona_prose', facts: f, model, promptVersion });
}

export async function composeBackstory(f: ProseFacts, provider: ProseProvider | null, cache?: Map<string, string>, signal?: AbortSignal): Promise<ProseOutcome> {
  const template = templateBackstory(f);
  if (!provider) return { backstory: template, origin: 'template', fallbackReason: null, cacheKey: proseCacheKey(f, 'template', TEMPLATE_PROSE_VERSION) };
  const key = proseCacheKey(f, provider.model, provider.promptVersion);
  let text = cache?.get(key);
  try {
    if (text === undefined) {
      text = await provider.generate(f, signal);
    }
  } catch (e) {
    return { backstory: template, origin: 'template', fallbackReason: `provider error: ${(e as Error).message}`, cacheKey: key };
  }
  const check = validateBackstory(text, f);
  if (!check.ok) return { backstory: template, origin: 'template', fallbackReason: check.reasons.join('; '), cacheKey: key };
  cache?.set(key, text);
  return { backstory: `Synthetic persona: ${text.replace(/^Synthetic persona:\s*/i, '')}`, origin: 'llm', fallbackReason: null, cacheKey: key };
}
