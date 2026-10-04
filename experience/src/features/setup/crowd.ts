/**
 * Crowd controls model. Sliders are in GUESTS (not groups). Shares sent to the population
 * job are guests / guestCount. The browser never samples personas: it only validates
 * inputs and summarizes the immutable population artifact it receives.
 */
import type { Archetype, CrowdSpec, PopulationManifest } from '../../../contract/behavior-v1';

export const ARCHETYPE_ORDER: Archetype[] = ['young_family', 'teens', 'couple', 'thrill_seekers', 'seniors', 'solo'];
export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  young_family: 'Young families', teens: 'Teen groups', couple: 'Couples', thrill_seekers: 'Thrill seekers', seniors: 'Seniors', solo: 'Solo visitors',
};
export const DEFAULT_GUESTS = 300;
export const GENERATOR_VERSION = 'population-generator-v1';
export type GuestMix = Record<Archetype, number>;

export function defaultMix(total = DEFAULT_GUESTS): GuestMix {
  const pct: GuestMix = { young_family: 0.35, teens: 0.15, couple: 0.2, thrill_seekers: 0.1, seniors: 0.1, solo: 0.1 };
  const out = Object.fromEntries(ARCHETYPE_ORDER.map((a) => [a, Math.floor(pct[a] * total)])) as GuestMix;
  out.young_family += total - sumMix(out);
  return out;
}
export const sumMix = (m: GuestMix) => ARCHETYPE_ORDER.reduce((s, a) => s + (m[a] ?? 0), 0);

export function validateCrowd(guestCount: number, mix: GuestMix, maxGuests: number): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Number.isInteger(guestCount) || guestCount < 1) errors.push('Guest count must be a whole number of at least 1.');
  else if (guestCount > maxGuests) errors.push(`This server supports at most ${maxGuests} guests.`);
  else if (guestCount < 200 || guestCount > 400) warnings.push('Outside the default 200-400 range; results may not be comparable to other runs.');
  for (const a of ARCHETYPE_ORDER) {
    if (!Number.isInteger(mix[a]) || mix[a] < 0) errors.push(`${ARCHETYPE_LABEL[a]} must be a whole number of guests (0 or more).`);
  }
  const total = sumMix(mix);
  if (total === 0) errors.push('Assign guests to at least one archetype.');
  else if (total !== guestCount) errors.push(`Archetype sliders assign ${total} guests but the crowd size is ${guestCount}. Adjust sliders or use "Fit to crowd size".`);
  if (mix.young_family > 0 && mix.young_family < 3) errors.push('Young families need at least 3 guests to form one feasible group.');
  return { errors, warnings };
}

/** Exact fractions guests/total; these are what the population job receives. */
export function sharesFor(mix: GuestMix, guestCount: number): Record<Archetype, number> {
  return Object.fromEntries(ARCHETYPE_ORDER.map((a) => [a, guestCount > 0 ? mix[a] / guestCount : 0])) as Record<Archetype, number>;
}

/** Largest-remainder rescale of a mix to a new total (used by "Fit to crowd size"). */
export function fitMix(mix: GuestMix, total: number): GuestMix {
  const sum = sumMix(mix);
  if (sum === 0) return defaultMix(total);
  const raw = ARCHETYPE_ORDER.map((a) => ({ a, v: (mix[a] / sum) * total }));
  const out = Object.fromEntries(raw.map(({ a, v }) => [a, Math.floor(v)])) as GuestMix;
  let rest = total - sumMix(out);
  for (const { a } of [...raw].sort((x, y) => (y.v % 1) - (x.v % 1))) { if (rest-- <= 0) break; out[a]++; }
  return out;
}

export function mixFromShares(shares: Record<Archetype, number>, total: number): GuestMix {
  return fitMix(Object.fromEntries(ARCHETYPE_ORDER.map((a) => [a, Math.round((shares[a] ?? 0) * 10_000)])) as GuestMix, total);
}

export function buildCrowd(guestCount: number, mix: GuestMix, seed: string, contextNotes: string): CrowdSpec {
  return { guestCount, seed, shares: sharesFor(mix, guestCount), contextNotes, generatorVersion: GENERATOR_VERSION };
}

export type PopulationSummary = {
  guests: number; groups: number; realized: GuestMix; groupSizes: Record<string, number>;
  budgets: { min: number; median: number; max: number }; withApp: number; children: number;
};

export function summarizePopulation(m: PopulationManifest): PopulationSummary {
  const realized = Object.fromEntries(ARCHETYPE_ORDER.map((a) => [a, 0])) as GuestMix;
  for (const p of m.personas) realized[p.archetype]++;
  const groupSizes: Record<string, number> = {};
  for (const g of m.groups) groupSizes[String(g.memberIds.length)] = (groupSizes[String(g.memberIds.length)] ?? 0) + 1;
  const budgets = m.groups.map((g) => g.startingBalanceCents).sort((a, b) => a - b);
  return {
    guests: m.personas.length, groups: m.groups.length, realized, groupSizes,
    budgets: { min: budgets[0] ?? 0, median: budgets[Math.floor(budgets.length / 2)] ?? 0, max: budgets[budgets.length - 1] ?? 0 },
    withApp: m.personas.filter((p) => p.hasApp).length, children: m.personas.filter((p) => p.role === 'child').length,
  };
}
