import type { Archetype, CrowdSpec, GroupManifest, Id, Needs, Persona, Place } from '../../contract/behavior-v1.ts';
import type { FieldError } from '../core/errors.ts';
import { SemanticRandom } from '../core/random.ts';
import { SIM_STEP_MS } from '../core/validate.ts';
import { allocateGuests, isFeasibleQuota, validateShares } from './allocation.ts';
import {
  AGE_RANGE, APP_PROBABILITY_AGE_13_PLUS, ARCHETYPES, BUDGET_PER_GUEST_CENTS, GROUP_SHAPES, LANGUAGES, MIN_STAY_MS,
  MIN_UNSUPERVISED_AGE, MOBILITY_RESTRICTED_PROBABILITY, MUST_DO_PROBABILITY, OCCASIONS, PHONE_BATTERY_LIMIT_PROBABILITY,
  STROLLER_MAX_AGE, THRILL_MEAN,
} from './assumptions.ts';
import type { ParkContext } from './park.ts';

export const GENERATOR_VERSIONS = {
  'population-v1': { aspirations: false },
  'population-v1+aspirations': { aspirations: true },
} as const;
export type GeneratorVersion = keyof typeof GENERATOR_VERSIONS;

/** Structured hook facts carried alongside each persona until prose is frozen. */
export type HookFacts = {
  mustDo: { placeId: Id; name: string }[];
  /** Deliberately infeasible aspirations (only in the +aspirations generator); admission still applies. */
  infeasibleAspirations: { placeId: Id; name: string; reason: string }[];
};

export type SampledPersona = Omit<Persona, 'backstory'> & { hooks: HookFacts };
export type SampledGroup = GroupManifest & { archetype: Archetype; language: string; occasion: string };

export type SampledPopulation = {
  crowd: CrowdSpec; generatorVersion: GeneratorVersion;
  personas: SampledPersona[]; groups: SampledGroup[];
  requestedShares: Record<Archetype, number>;
  targetGuests: Record<Archetype, number>; realizedGuests: Record<Archetype, number>;
  warnings: string[];
};

export type SampleResult = { ok: true; value: SampledPopulation } | { ok: false; errors: FieldError[] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const floorStep = (ms: number) => Math.floor(ms / SIM_STEP_MS) * SIM_STEP_MS;
const pad = (n: number, w: number) => String(n).padStart(w, '0');

function partition(a: Archetype, q: number, rng: SemanticRandom): number[] {
  const shape = GROUP_SHAPES[a];
  const sizes: number[] = [];
  let rem = q;
  while (rem > 0) {
    const allowed = shape.sizeWeights.filter(([s]) => {
      const n = Number(s);
      return n <= rem && (rem - n === 0 || isFeasibleQuota(a, rem - n));
    });
    const size = allowed.length ? Number(rng.weighted(allowed, a, sizes.length, 'size')) : rem;
    sizes.push(size);
    rem -= size;
  }
  return sizes;
}

function heightForAge(age: number, rng: SemanticRandom, ...keys: (string | number)[]): number {
  if (age <= 12) return Math.round(clamp(76 + 6.2 * age + rng.normal(0, 5, ...keys, 'height'), 80, 165));
  if (age <= 17) return Math.round(clamp(150 + 3.5 * (age - 13) + rng.normal(0, 7, ...keys, 'height'), 135, 195));
  return Math.round(clamp(rng.normal(170, 9.5, ...keys, 'height'), 145, 205));
}

type MemberDraft = { role: Persona['role']; ageYears: number };

function memberDrafts(a: Archetype, size: number, rng: SemanticRandom, gk: string): MemberDraft[] {
  const age = (r: readonly [number, number], k: string | number) => rng.int(r[0], r[1], gk, k, 'age');
  switch (a) {
    case 'young_family': {
      const parents = size === 2 ? 1 : size === 3 ? (rng.bernoulli(0.5, gk, 'parents') ? 2 : 1) : (rng.bernoulli(0.75, gk, 'parents') ? 2 : 1);
      return Array.from({ length: size }, (_, i): MemberDraft => i < parents
        ? { role: 'parent', ageYears: age(AGE_RANGE.parent, i) }
        : { role: 'child', ageYears: age(AGE_RANGE.child, i) });
    }
    case 'teens': return Array.from({ length: size }, (_, i) => ({ role: 'teen' as const, ageYears: age(AGE_RANGE.teen, i) }));
    case 'couple': {
      const first = age(AGE_RANGE.couple, 0);
      return [{ role: first >= 62 ? 'senior' : 'adult', ageYears: first },
        { role: 'adult', ageYears: clamp(first + rng.int(-6, 6, gk, 1, 'agegap'), 20, 75) }]
        .map((m) => ({ ...m, role: m.ageYears >= 62 ? 'senior' as const : 'adult' as const }));
    }
    case 'thrill_seekers': return Array.from({ length: size }, (_, i) => ({ role: 'adult' as const, ageYears: age(AGE_RANGE.thrill, i) }));
    case 'seniors': return Array.from({ length: size }, (_, i) => ({ role: 'senior' as const, ageYears: age(AGE_RANGE.senior, i) }));
    case 'solo': {
      const y = age(AGE_RANGE.solo, 0);
      return [{ role: y >= 62 ? 'senior' : 'adult', ageYears: y }];
    }
  }
}

function needs(rng: SemanticRandom, k: string): Needs {
  return {
    hunger: Math.round(rng.range(10, 50, k, 'hunger0')),
    fatigue: Math.round(rng.range(0, 25, k, 'fatigue0')),
    patience: Math.round(rng.range(50, 95, k, 'patience0')),
    fun: Math.round(rng.range(30, 70, k, 'fun0')),
  };
}

function rideFeasibleFor(place: Place, heightCm: number): boolean {
  return place.minHeightCm === null || heightCm >= place.minHeightCm;
}

export type SampleInput = {
  crowd: CrowdSpec; park: ParkContext; closeAfterMs: number; maxGuests?: number;
};

/** Samples every behavioral trait, group, goal and hook in code. No prose model is involved. */
export function samplePopulation(input: SampleInput): SampleResult {
  const { crowd, park } = input;
  const errors: FieldError[] = [];
  const maxGuests = input.maxGuests ?? 400;
  if (!Number.isSafeInteger(crowd.guestCount) || crowd.guestCount < 1 || crowd.guestCount > maxGuests) {
    errors.push({ path: 'guestCount', message: `guestCount must be an integer in 1..${maxGuests}` });
  }
  if (typeof crowd.seed !== 'string' || crowd.seed.length === 0 || crowd.seed.length > 160) errors.push({ path: 'seed', message: 'seed must be a nonempty string' });
  if (!(crowd.generatorVersion in GENERATOR_VERSIONS)) errors.push({ path: 'generatorVersion', message: `unsupported generator ${crowd.generatorVersion}; supported: ${Object.keys(GENERATOR_VERSIONS).join(', ')}` });
  if (!Number.isSafeInteger(input.closeAfterMs) || input.closeAfterMs % SIM_STEP_MS !== 0 || input.closeAfterMs < MIN_STAY_MS + SIM_STEP_MS) {
    errors.push({ path: 'closeAfterMs', message: 'park hours must be a 5000 ms multiple of at least one hour' });
  }
  const shares = validateShares(crowd.shares as Record<string, unknown>);
  if (!shares.ok) errors.push(...shares.errors);
  if (errors.length || !shares.ok) return { ok: false, errors };
  const alloc = allocateGuests(crowd.guestCount, shares.normalized);
  if (!alloc.ok) return { ok: false, errors: alloc.errors };

  const version = crowd.generatorVersion as GeneratorVersion;
  const rng = new SemanticRandom(crowd.seed, 'personas');
  const arrivals = new SemanticRandom(crowd.seed, 'arrivals');
  const personas: SampledPersona[] = [];
  const groups: SampledGroup[] = [];
  const latestArrival = floorStep(Math.max(0, input.closeAfterMs - 2 * MIN_STAY_MS));

  for (const a of ARCHETYPES) {
    const sizes = partition(a, alloc.realized[a], rng);
    sizes.forEach((size, gi) => {
      const groupId = `g${pad(groups.length + 1, 3)}`;
      const gk = `${a}:${gi}`;
      const drafts = memberDrafts(a, size, rng, gk);
      const language = rng.weighted(LANGUAGES, gk, 'language');
      const occasion = rng.pick(OCCASIONS[a], gk, 'occasion');
      const members: SampledPersona[] = drafts.map((d, mi) => {
        const agentId = `a${pad(personas.length + mi + 1, 4)}`;
        const mk = `${gk}:${mi}`;
        const heightCm = heightForAge(d.ageYears, rng, mk);
        const mobilityRestricted = d.ageYears >= 18 && rng.bernoulli(MOBILITY_RESTRICTED_PROBABILITY, mk, 'mobility');
        const stroller = d.role === 'child' && d.ageYears <= STROLLER_MAX_AGE;
        const baseSpeed = d.ageYears <= 12 ? 0.8 + 0.03 * d.ageYears : 1.32 - (d.ageYears > 60 ? 0.008 * (d.ageYears - 60) : 0);
        const walkSpeedMps = round2(clamp(rng.normal(baseSpeed, 0.1, mk, 'speed') - (mobilityRestricted ? 0.35 : 0), 0.5, 1.8));
        const hasApp = d.ageYears >= MIN_UNSUPERVISED_AGE && rng.bernoulli(APP_PROBABILITY_AGE_13_PLUS, mk, 'app');
        const phoneActiveUntilMs = hasApp && rng.bernoulli(PHONE_BATTERY_LIMIT_PROBABILITY, mk, 'battery')
          ? floorStep(rng.range(2 * MIN_STAY_MS, input.closeAfterMs, mk, 'battery_at')) : null;
        return {
          agentId, groupId, archetype: a, role: d.role, ageYears: d.ageYears, heightCm, walkSpeedMps,
          thrillPreference: round2(clamp(rng.normal(THRILL_MEAN[a], 0.22, mk, 'thrill'), 0, 1)),
          initialNeeds: needs(rng, mk),
          hungerPerHour: round1(rng.range(6, 14, mk, 'hungerRate')),
          fatiguePerKm: round1(rng.range(5, 12, mk, 'fatigueRate') + (mobilityRestricted ? 3 : 0) + (d.ageYears <= 8 ? 2 : 0)),
          patiencePerMinute: round2(rng.range(0.5, 2, mk, 'patienceRate')),
          familiarity: round2(rng.uniform(gk, 'familiarity')),
          hasApp, language, phoneActiveUntilMs, stroller, mobilityRestricted, occasion,
          mustDoPlaceIds: [], hooks: { mustDo: [], infeasibleAspirations: [] },
        };
      });

      const minHeight = Math.min(...members.map((m) => m.heightCm));
      const meanThrill = members.reduce((s, m) => s + m.thrillPreference, 0) / members.length;
      const feasible = park.rides.filter((p) => rideFeasibleFor(p, minHeight));
      const mustDo: Place[] = [];
      if (feasible.length && rng.bernoulli(MUST_DO_PROBABILITY, gk, 'mustdo')) {
        const weighted = feasible.map((p) => [p.id, 1.1 - Math.abs(p.thrill - meanThrill)] as const);
        mustDo.push(park.places.get(rng.weighted(weighted, gk, 'mustdo_pick'))!);
      }
      const aspirations: HookFacts['infeasibleAspirations'] = [];
      if (GENERATOR_VERSIONS[version].aspirations && a === 'young_family') {
        const blocked = park.rides.filter((p) => !rideFeasibleFor(p, minHeight));
        if (blocked.length && rng.bernoulli(0.3, gk, 'aspiration')) {
          const p = rng.pick(blocked, gk, 'aspiration_pick');
          aspirations.push({ placeId: p.id, name: p.name, reason: `a group member is below the ${p.minHeightCm} cm minimum height` });
        }
      }
      for (const m of members) {
        m.mustDoPlaceIds = [...mustDo.map((p) => p.id), ...aspirations.map((x) => x.placeId)];
        m.hooks = { mustDo: mustDo.map((p) => ({ placeId: p.id, name: p.name })), infeasibleAspirations: aspirations };
      }

      const range = BUDGET_PER_GUEST_CENTS[a];
      const perGuest = Math.round(rng.range(range[0], range[1], gk, 'budget') / 500) * 500;
      const arrivalBand = arrivals.weighted([['early', 6], ['mid', 3], ['late', 1]], groupId, 'band');
      const bandMs = { early: [0, 2 * MIN_STAY_MS], mid: [2 * MIN_STAY_MS, 4 * MIN_STAY_MS], late: [4 * MIN_STAY_MS, 6 * MIN_STAY_MS] }[arrivalBand];
      const arrivalMs = Math.min(latestArrival, floorStep(arrivals.range(bandMs[0]!, bandMs[1]!, groupId, 'arrival')));
      const stayMs = arrivals.range(3 * MIN_STAY_MS, 8 * MIN_STAY_MS, groupId, 'stay');
      const plannedDepartureMs = Math.max(
        Math.min(input.closeAfterMs, arrivalMs + MIN_STAY_MS),
        Math.min(input.closeAfterMs, floorStep(arrivalMs + stayMs)),
      );
      const guardianIds = a === 'young_family' ? members.filter((m) => m.role === 'parent').map((m) => m.agentId) : [];
      const leader = a === 'young_family' ? members.find((m) => m.role === 'parent')! : [...members].sort((p, q) => q.ageYears - p.ageYears || (p.agentId < q.agentId ? -1 : 1))[0]!;
      groups.push({
        groupId, memberIds: members.map((m) => m.agentId), leaderId: leader.agentId, guardianIds,
        rallyPlaceId: park.entranceId, walletId: `w${groupId.slice(1)}`, startingBalanceCents: perGuest * size,
        arrivalMs, plannedDepartureMs, archetype: a, language, occasion,
      });
      personas.push(...members);
    });
  }
  return {
    ok: true,
    value: {
      crowd, generatorVersion: version, personas, groups,
      requestedShares: shares.normalized, targetGuests: alloc.targets, realizedGuests: alloc.realized,
      warnings: [...shares.warnings, ...alloc.warnings],
    },
  };
}
