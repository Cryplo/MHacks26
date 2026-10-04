/**
 * FIXTURE stand-in for Intelligence's population job. Template personas, labeled as such.
 * Product UI never imports this; it only reaches the browser through the fixture adapter's
 * `population` work result (an immutable artifact), exactly like the real service.
 */
import type { Archetype, CrowdSpec, GroupManifest, Hash, Needs, ParkBundle, Persona, PopulationManifest } from '../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../contract/behavior-v1';
import { canonicalJson } from '../domain/canonical';
import { sha256Sync } from './sha256';

export const ARCHETYPES: Archetype[] = ['young_family', 'teens', 'couple', 'thrill_seekers', 'seniors', 'solo'];
export const GROUP_SIZE: Record<Archetype, [number, number]> = {
  young_family: [3, 5], teens: [2, 4], couple: [2, 2], thrill_seekers: [2, 4], seniors: [2, 2], solo: [1, 1],
};

/** Deterministic uniform in [0,1) from the semantic key scheme, persona stream. */
export function fixtureUniform(seed: string, stream: string, ...keys: (string | number)[]): number {
  const hex = sha256Sync(canonicalJson(['behavior-rng-v1', seed, stream, ...keys]));
  return parseInt(hex.slice(0, 13), 16) / 2 ** 52;
}

/** Largest-remainder allocation of guests by share; shares are fractions summing to 1. */
export function allocateGuests(guestCount: number, shares: Record<Archetype, number>): Record<Archetype, number> {
  const total = ARCHETYPES.reduce((s, a) => s + (shares[a] ?? 0), 0);
  const raw = ARCHETYPES.map((a) => ({ a, v: total > 0 ? ((shares[a] ?? 0) / total) * guestCount : 0 }));
  const out = Object.fromEntries(raw.map(({ a, v }) => [a, Math.floor(v)])) as Record<Archetype, number>;
  let rest = guestCount - ARCHETYPES.reduce((s, a) => s + out[a], 0);
  for (const { a } of [...raw].sort((x, y) => (y.v % 1) - (x.v % 1) || ARCHETYPES.indexOf(x.a) - ARCHETYPES.indexOf(y.a))) {
    if (rest <= 0) break;
    out[a]++;
    rest--;
  }
  return out;
}

const BACKSTORY: Record<Archetype, string[]> = {
  young_family: [
    'Template fixture persona: a parent visiting with young children for a birthday treat.',
    'Template fixture persona: a family on a first visit, keen to find rides the youngest can board.',
  ],
  teens: ['Template fixture persona: a group of friends on a school-holiday day out, chasing thrill rides.'],
  couple: ['Template fixture persona: a couple on a relaxed day trip who like shows and good food.'],
  thrill_seekers: ['Template fixture persona: coaster fans who planned the visit around the Tempest Coaster.'],
  seniors: ['Template fixture persona: retired friends who enjoy gentle rides, shade and the harbor view.'],
  solo: ['Template fixture persona: a solo visitor with a flexible plan and a few hours to spare.'],
};
const OCCASION: Record<Archetype, string[]> = {
  young_family: ['birthday', 'school holiday'], teens: ['day out with friends'], couple: ['anniversary', 'day trip'],
  thrill_seekers: ['coaster trip'], seniors: ['day trip'], solo: ['spare afternoon'],
};

/**
 * Mirrors Intelligence's population-v1 arrival bands: a gate-opening surge (~13% at rope drop,
 * about half within 75 minutes), then steady daytime arrivals and an evening cohort, so the park
 * stays busy into the night. Within a band, arrivals are front-loaded (u^skew). Times land on
 * 5-second steps.
 */
export const ARRIVAL_BANDS = [
  { weight: 1.5, fromMs: 0, toMs: 3 * 60_000, skew: 1 },
  { weight: 3, fromMs: 3 * 60_000, toMs: 25 * 60_000, skew: 1.3 },
  { weight: 2.5, fromMs: 25 * 60_000, toMs: 75 * 60_000, skew: 1.2 },
  { weight: 2, fromMs: 75 * 60_000, toMs: 4 * 3_600_000, skew: 1.2 },
  { weight: 1.5, fromMs: 4 * 3_600_000, toMs: 7 * 3_600_000, skew: 1 },
  { weight: 1, fromMs: 7 * 3_600_000, toMs: 8.5 * 3_600_000, skew: 1 },
] as const;
function arrivalMsFor(u: (...k: (string | number)[]) => number, groupId: string): number {
  const total = ARRIVAL_BANDS.reduce((n, b) => n + b.weight, 0);
  let x = u(groupId, 'arrival_band') * total;
  const band = ARRIVAL_BANDS.find((b) => (x -= b.weight) < 0) ?? ARRIVAL_BANDS[ARRIVAL_BANDS.length - 1]!;
  const t = band.fromMs + (band.toMs - band.fromMs) * u(groupId, 'arrival') ** band.skew;
  return Math.floor(t / 5000) * 5000;
}

export type RealizedMix = { requested: Record<Archetype, number>; realized: Record<Archetype, number>; notes: string[] };

export function buildFixturePopulation(crowd: CrowdSpec, park: ParkBundle, parkHash: Hash): { manifest: PopulationManifest; mix: RealizedMix } {
  const requested = allocateGuests(crowd.guestCount, crowd.shares);
  const u = (...k: (string | number)[]) => fixtureUniform(crowd.seed, 'personas', ...k);
  const rides = park.places.filter((p) => p.kind === 'ride' || p.kind === 'show');
  const personas: Persona[] = [];
  const groups: GroupManifest[] = [];
  const realized = Object.fromEntries(ARCHETYPES.map((a) => [a, 0])) as Record<Archetype, number>;
  const notes: string[] = [];
  let g = 0;
  let a = 0;
  let remainingTotal = crowd.guestCount;

  for (const arch of ARCHETYPES) {
    let target = Math.min(requested[arch], remainingTotal);
    const [minSize, maxSize] = GROUP_SIZE[arch];
    while (target >= minSize) {
      g++;
      const groupId = `g${String(g).padStart(3, '0')}`;
      let size = minSize + Math.floor(u(groupId, 'size') * (maxSize - minSize + 1));
      if (size > target) size = target;
      // Avoid leaving a remainder too small to form a feasible group (deterministic rounding).
      if (target - size > 0 && target - size < minSize) {
        if (target <= maxSize) size = target;
        else if (target - minSize >= minSize) size = target - minSize;
      }
      const memberIds: string[] = [];
      const guardians: string[] = [];
      for (let i = 0; i < size; i++) {
        a++;
        const agentId = `a${String(a).padStart(3, '0')}`;
        memberIds.push(agentId);
        const p = makePersona(arch, i, agentId, groupId, crowd, u, rides.map((r) => r.id));
        if (p.role === 'parent') guardians.push(agentId);
        personas.push(p);
      }
      const arrival = arrivalMsFor(u, groupId);
      const stay = (240 + Math.floor(u(groupId, 'stay') * 300)) * 60_000;
      groups.push({
        groupId, memberIds, leaderId: memberIds[0]!, guardianIds: guardians,
        rallyPlaceId: 'main_gate', walletId: `w${groupId.slice(1)}`,
        startingBalanceCents: Math.floor((size * 2500 + Math.floor(u(groupId, 'budget') * 6000)) * (arch === 'teens' ? 0.6 : 1)),
        arrivalMs: arrival, plannedDepartureMs: Math.min(park.closeAfterMs, arrival + stay),
      });
      target -= size;
      remainingTotal -= size;
      realized[arch] += size;
    }
    if (target > 0) notes.push(`${target} ${arch.replace('_', ' ')} guest(s) could not form a feasible group (min size ${minSize}); reassigned to solo visitors.`);
  }
  // Any guests left over because a group could not be formed become solo visitors.
  while (remainingTotal > 0) {
    g++; a++;
    const groupId = `g${String(g).padStart(3, '0')}`;
    const agentId = `a${String(a).padStart(3, '0')}`;
    personas.push(makePersona('solo', 0, agentId, groupId, crowd, u, rides.map((r) => r.id)));
    const arrival = arrivalMsFor(u, groupId);
    groups.push({ groupId, memberIds: [agentId], leaderId: agentId, guardianIds: [], rallyPlaceId: 'main_gate',
      walletId: `w${groupId.slice(1)}`, startingBalanceCents: 4000, arrivalMs: arrival,
      plannedDepartureMs: Math.min(park.closeAfterMs, arrival + 180 * 60_000) });
    realized.solo++;
    remainingTotal--;
  }
  const diversity = [
    { key: 'archetype', counts: { ...realized } as Record<string, number> },
    { key: 'groupSize', counts: groups.reduce<Record<string, number>>((m, gr) => { m[String(gr.memberIds.length)] = (m[String(gr.memberIds.length)] ?? 0) + 1; return m; }, {}) },
    { key: 'hasApp', counts: { yes: personas.filter((p) => p.hasApp).length, no: personas.filter((p) => !p.hasApp).length } },
  ];
  const manifest: PopulationManifest = {
    contractVersion: CONTRACT_VERSION,
    populationId: `pop-${sha256Sync(canonicalJson({ crowd, parkHash })).slice(0, 16)}`,
    crowd, parkHash, personas, groups, proseVersion: 'fixture-template-prose-v1', randomVersion: 'behavior-rng-v1', diversity,
  };
  return { manifest, mix: { requested, realized, notes } };
}

function makePersona(arch: Archetype, index: number, agentId: string, groupId: string, crowd: CrowdSpec,
  u: (...k: (string | number)[]) => number, rideIds: string[]): Persona {
  const r = (k: string) => u(agentId, k);
  let role: Persona['role'] = 'adult';
  let age = 25 + Math.floor(r('age') * 30);
  if (arch === 'young_family') {
    if (index < 2 && !(index === 1 && r('single') < 0.3)) { role = 'parent'; age = 29 + Math.floor(r('age') * 16); }
    else { role = 'child'; age = 3 + Math.floor(r('age') * 9); }
  } else if (arch === 'teens') { role = 'teen'; age = 13 + Math.floor(r('age') * 5); }
  else if (arch === 'seniors') { role = 'senior'; age = 65 + Math.floor(r('age') * 16); }
  else if (arch === 'thrill_seekers') age = 18 + Math.floor(r('age') * 17);
  const height = role === 'child' ? 95 + (age - 3) * 6 + Math.floor(r('height') * 8) : role === 'teen' ? 150 + Math.floor(r('height') * 30) : 155 + Math.floor(r('height') * 35);
  const thrillBase: Record<Archetype, number> = { young_family: 0.35, teens: 0.8, couple: 0.45, thrill_seekers: 0.92, seniors: 0.15, solo: 0.5 };
  const needs: Needs = {
    hunger: 15 + Math.floor(r('hunger') * 30), fatigue: 5 + Math.floor(r('fatigue') * 20),
    patience: 55 + Math.floor(r('patience') * 40), fun: 40 + Math.floor(r('fun') * 20),
  };
  const mustDo = rideIds.length ? [rideIds[Math.floor(r('mustdo') * rideIds.length)]!] : [];
  return {
    agentId, groupId, archetype: arch, role, ageYears: age, heightCm: height,
    walkSpeedMps: role === 'child' ? 0.9 + r('speed') * 0.2 : role === 'senior' ? 0.85 + r('speed') * 0.2 : 1.15 + r('speed') * 0.25,
    thrillPreference: Math.max(0, Math.min(1, thrillBase[arch] + (r('thrill') - 0.5) * 0.3)),
    initialNeeds: needs, hungerPerHour: 8 + Math.floor(r('hr') * 6), fatiguePerKm: 6 + Math.floor(r('fk') * 6),
    patiencePerMinute: 0.6 + r('pm') * 0.8, familiarity: Math.round(r('fam') * 100) / 100,
    hasApp: role !== 'child' && r('app') < 0.6, language: 'en', phoneActiveUntilMs: null,
    stroller: arch === 'young_family' && role === 'parent' && index === 0 && r('stroller') < 0.25,
    mobilityRestricted: role === 'senior' && r('mob') < 0.2,
    occasion: OCCASION[arch][Math.floor(r('occ') * OCCASION[arch].length)]!,
    mustDoPlaceIds: mustDo,
    backstory: BACKSTORY[arch][Math.floor(r('story') * BACKSTORY[arch].length)]! + (crowd.contextNotes ? ` Context noted (not modeled): ${crowd.contextNotes.slice(0, 120)}` : ''),
  };
}
