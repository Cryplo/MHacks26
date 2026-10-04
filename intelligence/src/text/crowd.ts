import type { Archetype, CrowdSpec } from '../../contract/behavior-v1.ts';
import { validateShares } from '../population/allocation.ts';
import { ARCHETYPES } from '../population/assumptions.ts';

export const CROWD_PARSER_VERSION = 'crowd-parser-v1';

export type CrowdParse = { proposal: CrowdSpec; assumptions: string[]; unsupported: string[] };

const ARCHETYPE_TERMS: [RegExp, Archetype][] = [
  [/\b(young )?famil(y|ies)\b|\bkids\b|\bchildren\b|\bparents\b|\btoddlers?\b/, 'young_family'],
  [/\bteen(s|agers?)?\b|\badolescents?\b/, 'teens'],
  [/\bcouples?\b/, 'couple'],
  [/\bthrill[- ]?seekers?\b|\bthrill\b|\badrenaline\b/, 'thrill_seekers'],
  [/\bseniors?\b|\bretirees?\b|\belderly\b|\bolder (adults|visitors|guests|people)\b|\bgrandparents\b/, 'seniors'],
  [/\bsolo\b|\bsingles?\b|\bsingle (visitors|guests)\b|\bpeople on their own\b/, 'solo'],
];

/** Dimensions that the contract's archetype mix cannot express. They stay descriptive notes. */
const UNSUPPORTED_DIMENSIONS: [RegExp, string][] = [
  [/\binternational\b|\btourists?\b|\bforeign\b|\bfrom abroad\b|\bout[- ]of[- ]town\b/, 'visitor origin'],
  [/\blocals?\b|\bresidents?\b/, 'local residency'],
  [/\bwealthy\b|\brich\b|\baffluent\b|\bbig spenders?\b|\bbudget\b|\bcheap\b|\bspend(ing|ers)?\b/, 'spending power'],
  [/\brain(y)?\b|\bweather\b|\bhot day\b|\bcold day\b|\bsunny\b/, 'weather'],
  [/\bwheelchair|\bdisab|\bmobility\b|\baccessib/, 'accessibility mix'],
  [/\blanguages?\b|\bspanish\b|\bfrench\b|\bchinese\b|\bjapanese\b|\bgerman\b|\bkorean\b/, 'language mix'],
  [/\bstudents?\b|\bschool (groups?|trips?)\b|\btour groups?\b|\bcorporate\b|\bbusiness\b|\bbachelor/, 'group type outside the contract archetypes'],
];

type Direction = { kind: 'factor'; factor: number; word: string } | { kind: 'target'; share: number; word: string };

function directionOf(clause: string): Direction | 'conflict' | null {
  const found: Direction[] = [];
  const pct = clause.match(/(\d{1,3}(?:\.\d+)?)\s*(%|percent\b)/);
  if (pct) {
    const v = Number(pct[1]) / 100;
    found.push({ kind: 'target', share: v, word: `${pct[1]}%` });
  }
  if (/\b(no|without|zero|exclude|excluding)\b/.test(clause)) found.push({ kind: 'target', share: 0, word: 'none' });
  if (/\b(mostly|mainly|majority|predominantly)\b/.test(clause)) found.push({ kind: 'target', share: 0.6, word: 'mostly' });
  if (/\b(double|twice as many)\b/.test(clause)) found.push({ kind: 'factor', factor: 2, word: 'double' });
  else if (/\b(much|lots|far|way|a lot) more\b|\bmany more\b/.test(clause)) found.push({ kind: 'factor', factor: 2, word: 'much more' });
  else if (/\b(slightly|a few|a bit|a little|somewhat) more\b/.test(clause)) found.push({ kind: 'factor', factor: 1.25, word: 'slightly more' });
  else if (/\b(more|extra|increase|plenty of|lots of|additional)\b/.test(clause)) found.push({ kind: 'factor', factor: 1.5, word: 'more' });
  if (/\b(half|halve)\b/.test(clause)) found.push({ kind: 'factor', factor: 0.5, word: 'half' });
  else if (/\b(much|far|way|a lot) (fewer|less)\b|\bhardly any\b|\bvery few\b/.test(clause)) found.push({ kind: 'factor', factor: 0.25, word: 'much fewer' });
  else if (/\b(slightly|a few|a bit|a little|somewhat) (fewer|less)\b/.test(clause)) found.push({ kind: 'factor', factor: 0.8, word: 'slightly fewer' });
  else if (/\b(fewer|less|reduce|decrease|not many|lower)\b/.test(clause)) found.push({ kind: 'factor', factor: 0.5, word: 'fewer' });
  if (found.length === 0) return null;
  const up = found.some((d) => (d.kind === 'factor' ? d.factor > 1 : d.share > 0));
  const down = found.some((d) => (d.kind === 'factor' ? d.factor < 1 : d.share === 0));
  if (up && down) return 'conflict';
  const target = found.find((d) => d.kind === 'target');
  return target ?? found[0]!;
}

function splitClauses(text: string): string[] {
  return text
    .split(/[,;\n]|\.(?=\s|$)|\bbut\b|\band also\b|\bplus\b|\band\b(?=\s+(?:more|fewer|less|no|mostly|mainly|double|half|extra|lots|plenty|a few|slightly|much|\d))/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Deterministic crowd-description parser. Proposes supported archetype shares with visible
 * assumptions; unsupported dimensions are listed and kept only as labeled descriptive notes.
 * It never invents traits, and an unrecognized request returns the current crowd unchanged.
 */
export function parseCrowdText(text: string, current: CrowdSpec, opts: { maxGuests?: number } = {}): CrowdParse {
  const maxGuests = opts.maxGuests ?? 1000;
  const assumptions: string[] = [];
  const unsupported: string[] = [];
  const notes: string[] = [];
  const base = validateShares(current.shares);
  if (!base.ok) {
    return { proposal: current, assumptions: [], unsupported: [`current crowd shares are invalid: ${base.errors.map((e) => e.message).join('; ')}`] };
  }
  const shares: Record<Archetype, number> = { ...base.normalized };
  const factors = new Map<Archetype, Direction & { kind: 'factor' }>();
  const targets = new Map<Archetype, Direction & { kind: 'target' }>();
  const touched = new Map<Archetype, string>();
  let guestCount = current.guestCount;
  let recognized = false;

  const clean = text.trim();
  if (!clean) return { proposal: current, assumptions: [], unsupported: ['empty crowd description; no change proposed'] };
  if (clean.length > 2000) return { proposal: current, assumptions: [], unsupported: ['crowd description longer than 2000 characters; no change proposed'] };

  for (const raw of splitClauses(clean)) {
    const clause = raw.toLowerCase();
    let handled = false;
    const count = clause.match(/\b(\d{1,6})\s*(guests|people|visitors|persons|attendees)\b/);
    if (count) {
      const n = Number(count[1]);
      if (Number.isSafeInteger(n) && n >= 1 && n <= maxGuests) {
        guestCount = n;
        recognized = true;
        handled = true;
      } else {
        unsupported.push(`"${raw}": guest count ${count[1]} is outside 1..${maxGuests}`);
        handled = true;
      }
    }
    const archetypes = ARCHETYPE_TERMS.filter(([re]) => re.test(clause)).map(([, a]) => a);
    const dims = UNSUPPORTED_DIMENSIONS.filter(([re]) => re.test(clause)).map(([, d]) => d);
    for (const d of dims) {
      unsupported.push(`"${raw}": ${d} is not a supported crowd dimension; kept as a descriptive note with no mechanical effect`);
      notes.push(raw);
      handled = true;
    }
    const uniq = [...new Set(archetypes)];
    if (uniq.length) {
      const dir = directionOf(clause.replace(/\b\d{1,6}\s*(guests|people|visitors|persons|attendees)\b/, ''));
      if (dir === null) {
        unsupported.push(`"${raw}": names ${uniq.join(', ')} but no direction (more/fewer/percentage); no change made`);
      } else if (dir === 'conflict') {
        unsupported.push(`"${raw}": contradictory directions; no change made`);
      } else {
        for (const a of uniq) {
          if (touched.has(a)) {
            unsupported.push(`"${raw}": ${a} was already adjusted by "${touched.get(a)}"; conflicting instruction ignored`);
            factors.delete(a); targets.delete(a);
            continue;
          }
          touched.set(a, raw);
          if (dir.kind === 'factor') factors.set(a, dir); else targets.set(a, dir);
          recognized = true;
        }
      }
      handled = true;
    }
    if (!handled) unsupported.push(`"${raw}": not understood; no change made`);
  }

  const targetSum = [...targets.values()].reduce((s, t) => s + t.share, 0);
  if (targetSum > 1 + 1e-9) {
    unsupported.push(`requested fixed shares sum to ${Math.round(targetSum * 100)}%, more than 100%; share changes not applied`);
    targets.clear(); factors.clear();
  }
  for (const [a, f] of factors) {
    shares[a] = shares[a] * f.factor;
    assumptions.push(`"${f.word}" ${a} multiplies its current share by ${f.factor} before renormalizing`);
  }
  const free = ARCHETYPES.filter((a) => !targets.has(a));
  const freeMass = free.reduce((s, a) => s + shares[a], 0);
  const remaining = 1 - targetSum;
  if (targets.size && remaining > 1e-9 && freeMass <= 0) {
    unsupported.push('fixed shares leave room for other archetypes, but every other archetype is zero; share changes not applied');
    return finish(current, guestCount, { ...base.normalized }, assumptions, unsupported, notes, recognized && guestCount !== current.guestCount);
  }
  for (const [a, t] of targets) {
    shares[a] = t.share;
    assumptions.push(`"${t.word}" sets ${a} to ${Math.round(t.share * 1000) / 10}% of guests; other archetypes keep their relative proportions`);
  }
  if (targets.size) for (const a of free) shares[a] = freeMass > 0 ? (shares[a] / freeMass) * remaining : 0;

  const changedShares = factors.size > 0 || targets.size > 0;
  return finish(current, guestCount, shares, assumptions, unsupported, notes, recognized || changedShares, changedShares);
}

function finish(
  current: CrowdSpec, guestCount: number, shares: Record<Archetype, number>, assumptions: string[], unsupported: string[],
  notes: string[], recognized: boolean, changedShares = false,
): CrowdParse {
  const v = validateShares(shares);
  if (!v.ok) {
    unsupported.push(`proposed mix is invalid (${v.errors.map((e) => e.message).join('; ')}); no change made`);
    return { proposal: current, assumptions: [], unsupported };
  }
  const rounded = Object.fromEntries(ARCHETYPES.map((a) => [a, round4(v.normalized[a])])) as Record<Archetype, number>;
  const residual = round4(1 - ARCHETYPES.reduce((s, a) => s + rounded[a], 0));
  if (residual !== 0) {
    const largest = ARCHETYPES.reduce<Archetype>((m, a) => (rounded[a] > rounded[m] ? a : m), 'young_family');
    rounded[largest] = round4(rounded[largest] + residual);
  }
  if (changedShares) assumptions.push('Shares are guest shares (not group shares), renormalized to sum to 1 and rounded to 4 decimals');
  if (guestCount !== current.guestCount) assumptions.push(`Guest count set to ${guestCount}`);
  const contextNotes = notes.length
    ? [current.contextNotes, ...notes.map((n) => `[descriptive only, no mechanical effect] ${n}`)].filter((s) => s.trim()).join('\n')
    : current.contextNotes;
  if (!recognized && notes.length === 0) {
    return { proposal: current, assumptions: [], unsupported: unsupported.length ? unsupported : ['no supported crowd change recognized'] };
  }
  assumptions.push(`Seed ${current.seed} and generator ${current.generatorVersion} unchanged; proposal requires operator review (${CROWD_PARSER_VERSION})`);
  return {
    proposal: { ...current, guestCount, shares: changedShares ? rounded : current.shares, contextNotes },
    assumptions, unsupported,
  };
}
