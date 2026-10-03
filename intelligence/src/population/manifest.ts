import type { Archetype, GroupManifest, Hash, Persona, PopulationManifest } from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { canonicalBytes, hashCanonical, sha256Hex } from '../core/canonical.ts';
import type { FieldError } from '../core/errors.ts';
import { RANDOM_VERSION } from '../core/random.ts';
import { SIM_STEP_MS } from '../core/validate.ts';
import { ARCHETYPES, ASSUMPTIONS_VERSION, MIN_UNSUPERVISED_AGE } from './assumptions.ts';
import type { ParkContext } from './park.ts';
import type { ProseOutcome } from './prose.ts';
import type { SampledPopulation } from './sampler.ts';

export const DIVERSITY_DISCLAIMER = 'Synthetic, illustrative population from versioned assumptions; not empirically representative of any real visitor base.';

type Stat = { min: number | null; max: number | null; mean: number | null; histogram: Record<string, number> };

export type DiversitySummary = {
  disclaimer: string; assumptionsVersion: string; reproducibilityHash: Hash;
  guestCount: number; groupCount: number;
  requestedShares: Record<Archetype, number>; realizedShares: Record<Archetype, number>;
  targetGuests: Record<Archetype, number>; realizedGuests: Record<Archetype, number>;
  groupSizes: Record<string, number>; roles: Record<string, number>;
  ageYears: Stat; heightCm: Stat; budgetPerGuestCents: Stat;
  needs: Record<'hunger' | 'fatigue' | 'patience' | 'fun', Stat>;
  thrillPreference: Stat; walkSpeedMps: Stat;
  app: { withApp: number; withoutApp: number; batteryLimited: number };
  languages: Record<string, number>; occasions: Record<string, number>;
  hooks: { groupsWithMustDo: number; mustDoByPlace: Record<string, number>; infeasibleAspirations: number };
  constraints: { mustDoHeightViolations: number; unsupervisedMinors: number; strollers: number; mobilityRestricted: number };
  correlations: { ageVsWalkSpeed: number | null; ageVsThrill: number | null; groupSizeVsBudgetPerGuest: number | null };
  prose: { template: number; llm: number; fallbacks: number };
  warnings: string[];
};

function stat(values: number[], edges: number[]): Stat {
  if (values.length === 0) return { min: null, max: null, mean: null, histogram: {} };
  const histogram: Record<string, number> = {};
  for (let i = 0; i < edges.length - 1; i++) histogram[`${edges[i]}-${edges[i + 1]}`] = 0;
  histogram[`${edges.at(-1)}+`] = 0;
  for (const v of values) {
    let i = edges.length - 2;
    while (i >= 0 && v < edges[i]!) i--;
    const key = i < 0 ? `${edges[0]}-${edges[1]}` : v >= edges.at(-1)! ? `${edges.at(-1)}+` : `${edges[i]}-${edges[i + 1]}`;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return {
    min: Math.min(...values), max: Math.max(...values),
    mean: Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 1000) / 1000, histogram,
  };
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n; const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx; const dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000;
}

const count = <T>(items: T[], key: (t: T) => string) => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};

function summarize(s: SampledPopulation, personas: Persona[], groups: GroupManifest[], prose: ProseOutcome[], park: ParkContext): Omit<DiversitySummary, 'reproducibilityHash'> {
  const n = personas.length;
  const byGroup = new Map(groups.map((g) => [g.groupId, g]));
  const sampledGroups = new Map(s.groups.map((g) => [g.groupId, g]));
  const realizedShares = Object.fromEntries(ARCHETYPES.map((a) => [a, n ? s.realizedGuests[a] / n : 0])) as Record<Archetype, number>;
  const v = validatePopulationManifest({ personas, groups } as PopulationManifest, park, s.generatorVersion, s.crowd.guestCount, { skipVersions: true });
  return {
    disclaimer: DIVERSITY_DISCLAIMER, assumptionsVersion: ASSUMPTIONS_VERSION,
    guestCount: n, groupCount: groups.length,
    requestedShares: s.requestedShares, realizedShares, targetGuests: s.targetGuests, realizedGuests: s.realizedGuests,
    groupSizes: count(groups, (g) => String(g.memberIds.length)), roles: count(personas, (p) => p.role),
    ageYears: stat(personas.map((p) => p.ageYears), [0, 6, 13, 18, 30, 45, 62, 75]),
    heightCm: stat(personas.map((p) => p.heightCm), [80, 100, 112, 122, 140, 160, 180]),
    budgetPerGuestCents: stat(groups.map((g) => g.startingBalanceCents / g.memberIds.length), [0, 2000, 4000, 6000, 8000]),
    needs: {
      hunger: stat(personas.map((p) => p.initialNeeds.hunger), [0, 20, 40, 60]),
      fatigue: stat(personas.map((p) => p.initialNeeds.fatigue), [0, 10, 20, 30]),
      patience: stat(personas.map((p) => p.initialNeeds.patience), [0, 50, 65, 80, 95]),
      fun: stat(personas.map((p) => p.initialNeeds.fun), [0, 40, 55, 70]),
    },
    thrillPreference: stat(personas.map((p) => p.thrillPreference), [0, 0.25, 0.5, 0.75]),
    walkSpeedMps: stat(personas.map((p) => p.walkSpeedMps), [0, 0.9, 1.1, 1.3, 1.5]),
    app: { withApp: personas.filter((p) => p.hasApp).length, withoutApp: personas.filter((p) => !p.hasApp).length, batteryLimited: personas.filter((p) => p.phoneActiveUntilMs !== null).length },
    languages: count(s.groups, (g) => g.language), occasions: count(s.groups, (g) => g.occasion),
    hooks: {
      groupsWithMustDo: s.groups.filter((g) => personas.find((p) => p.agentId === g.leaderId)!.mustDoPlaceIds.length > 0).length,
      mustDoByPlace: count(s.personas.flatMap((p) => p.agentId === sampledGroups.get(p.groupId)!.leaderId ? p.hooks.mustDo : []), (h) => h.placeId),
      infeasibleAspirations: s.personas.filter((p) => p.agentId === byGroup.get(p.groupId)!.leaderId && p.hooks.infeasibleAspirations.length > 0).length,
    },
    constraints: {
      mustDoHeightViolations: v.stats.heightViolations, unsupervisedMinors: v.stats.unsupervisedMinors,
      strollers: personas.filter((p) => p.stroller).length, mobilityRestricted: personas.filter((p) => p.mobilityRestricted).length,
    },
    correlations: {
      ageVsWalkSpeed: pearson(personas.map((p) => p.ageYears), personas.map((p) => p.walkSpeedMps)),
      ageVsThrill: pearson(personas.map((p) => p.ageYears), personas.map((p) => p.thrillPreference)),
      groupSizeVsBudgetPerGuest: pearson(groups.map((g) => g.memberIds.length), groups.map((g) => g.startingBalanceCents / g.memberIds.length)),
    },
    prose: { template: prose.filter((p) => p.origin === 'template').length, llm: prose.filter((p) => p.origin === 'llm').length, fallbacks: prose.filter((p) => p.fallbackReason).length },
    warnings: s.warnings,
  };
}

/** Flattens numeric summary sections into the manifest's `{ key, counts }` list. */
function diversityCounts(d: Omit<DiversitySummary, 'reproducibilityHash'>): PopulationManifest['diversity'] {
  const bps = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10000)]));
  return [
    { key: 'guests.requested_share_bps', counts: bps(d.requestedShares) },
    { key: 'guests.realized_share_bps', counts: bps(d.realizedShares) },
    { key: 'guests.target', counts: d.targetGuests },
    { key: 'guests.realized', counts: d.realizedGuests },
    { key: 'groups.size', counts: d.groupSizes },
    { key: 'roles', counts: d.roles },
    { key: 'age_years.histogram', counts: d.ageYears.histogram },
    { key: 'height_cm.histogram', counts: d.heightCm.histogram },
    { key: 'budget_per_guest_cents.histogram', counts: d.budgetPerGuestCents.histogram },
    { key: 'needs.hunger.histogram', counts: d.needs.hunger.histogram },
    { key: 'needs.patience.histogram', counts: d.needs.patience.histogram },
    { key: 'app', counts: d.app },
    { key: 'languages', counts: d.languages },
    { key: 'occasions', counts: d.occasions },
    { key: 'hooks.must_do_groups_by_place', counts: d.hooks.mustDoByPlace },
    { key: 'hooks.summary', counts: { groupsWithMustDo: d.hooks.groupsWithMustDo, infeasibleAspirations: d.hooks.infeasibleAspirations } },
    { key: 'constraints', counts: d.constraints },
    { key: 'prose', counts: d.prose },
    { key: 'warnings', counts: Object.fromEntries(d.warnings.map((w, i) => [`${i}:${w}`, 1])) },
  ];
}

export function proseVersionLabel(llmModel: string | null, llmPromptVersion: string | null): string {
  return llmModel ? `llm:${llmModel}:${llmPromptVersion}+fallback:template-prose-v1` : 'template-prose-v1';
}

export type FrozenPopulation = { manifest: PopulationManifest; bytes: Uint8Array; sha256: Hash; summary: DiversitySummary };

export function freezeManifest(s: SampledPopulation, prose: ProseOutcome[], proseVersion: string, park: ParkContext): FrozenPopulation {
  const personas: Persona[] = s.personas.map((p, i) => {
    const { hooks: _hooks, ...rest } = p;
    return { ...rest, backstory: prose[i]!.backstory };
  });
  const groups: GroupManifest[] = s.groups.map(({ archetype: _a, language: _l, occasion: _o, ...g }) => g);
  const partial = summarize(s, personas, groups, prose, park);
  const body: Omit<PopulationManifest, 'populationId'> = {
    contractVersion: CONTRACT_VERSION, crowd: s.crowd, parkHash: park.parkHash, personas, groups,
    proseVersion, randomVersion: RANDOM_VERSION, diversity: diversityCounts(partial),
  };
  const manifest: PopulationManifest = { ...body, populationId: `pop-${hashCanonical(body).slice(0, 24)}` };
  const bytes = canonicalBytes(manifest);
  const sha256 = sha256Hex(bytes);
  return { manifest, bytes, sha256, summary: { ...partial, reproducibilityHash: sha256 } };
}

export type ManifestCheck = { errors: FieldError[]; stats: { heightViolations: number; unsupervisedMinors: number } };

/** Structural validation of a population against its park (acceptance B-02). */
export function validatePopulationManifest(
  m: PopulationManifest, park: ParkContext, generatorVersion: string, expectedGuests: number, opts: { skipVersions?: boolean; closeAfterMs?: number } = {},
): ManifestCheck {
  const errors: FieldError[] = [];
  let heightViolations = 0; let unsupervisedMinors = 0;
  const closeAfterMs = opts.closeAfterMs ?? park.bundle.closeAfterMs;
  if (!opts.skipVersions) {
    if (m.contractVersion !== CONTRACT_VERSION) errors.push({ path: 'contractVersion', message: 'unsupported' });
    if (m.parkHash !== park.parkHash) errors.push({ path: 'parkHash', message: 'population was generated for a different park' });
    if (m.randomVersion !== RANDOM_VERSION) errors.push({ path: 'randomVersion', message: 'unsupported random version' });
  }
  if (m.personas.length !== expectedGuests) errors.push({ path: 'personas', message: `expected ${expectedGuests} guests, found ${m.personas.length}` });
  const agents = new Map(m.personas.map((p) => [p.agentId, p]));
  if (agents.size !== m.personas.length) errors.push({ path: 'personas', message: 'duplicate agent ids' });
  const groupIds = new Set(m.groups.map((g) => g.groupId));
  if (groupIds.size !== m.groups.length) errors.push({ path: 'groups', message: 'duplicate group ids' });
  const wallets = new Set(m.groups.map((g) => g.walletId));
  if (wallets.size !== m.groups.length) errors.push({ path: 'groups', message: 'wallet shared between groups or duplicated' });
  const memberOf = new Map<string, string>();
  for (const [gi, g] of m.groups.entries()) {
    const p = `groups[${gi}]`;
    if (g.memberIds.length === 0) errors.push({ path: p, message: 'empty group' });
    for (const id of g.memberIds) {
      if (!agents.has(id)) errors.push({ path: `${p}.memberIds`, message: `unknown agent ${id}` });
      if (memberOf.has(id)) errors.push({ path: `${p}.memberIds`, message: `agent ${id} in two groups` });
      memberOf.set(id, g.groupId);
      if (agents.get(id)?.groupId !== g.groupId) errors.push({ path: `${p}.memberIds`, message: `agent ${id} groupId mismatch` });
    }
    if (!g.memberIds.includes(g.leaderId)) errors.push({ path: `${p}.leaderId`, message: 'leader not a member' });
    for (const gid of g.guardianIds) {
      const a = agents.get(gid);
      if (!g.memberIds.includes(gid) || !a || a.ageYears < 18) errors.push({ path: `${p}.guardianIds`, message: `invalid guardian ${gid}` });
    }
    const members = g.memberIds.map((id) => agents.get(id)).filter((x): x is Persona => !!x);
    const minors = members.filter((a) => a.ageYears < MIN_UNSUPERVISED_AGE);
    if (minors.length && g.guardianIds.length === 0) { unsupervisedMinors += minors.length; errors.push({ path: `${p}.guardianIds`, message: 'children without a guardian' }); }
    const leader = agents.get(g.leaderId);
    if (minors.length && leader && leader.ageYears < 18) errors.push({ path: `${p}.leaderId`, message: 'leader of a group with children must be an adult' });
    if (!Number.isSafeInteger(g.startingBalanceCents) || g.startingBalanceCents < 0) errors.push({ path: `${p}.startingBalanceCents`, message: 'invalid cents' });
    if (g.arrivalMs % SIM_STEP_MS !== 0 || g.plannedDepartureMs % SIM_STEP_MS !== 0) errors.push({ path: p, message: 'times must be 5000 ms boundaries' });
    if (g.arrivalMs < 0 || g.plannedDepartureMs > closeAfterMs || g.plannedDepartureMs <= g.arrivalMs) errors.push({ path: p, message: 'arrival/departure outside park hours or not ordered' });
    if (!park.places.has(g.rallyPlaceId) || !park.reachable.has(g.rallyPlaceId)) errors.push({ path: `${p}.rallyPlaceId`, message: 'unknown or unreachable rally place' });
    const aspirational = generatorVersion.includes('+aspirations');
    for (const a of members) {
      for (const pid of a.mustDoPlaceIds) {
        const place = park.places.get(pid);
        if (!place || !park.reachable.has(pid)) { errors.push({ path: `${p}.${a.agentId}.mustDoPlaceIds`, message: `unknown or unreachable place ${pid}` }); continue; }
        if (place.minHeightCm !== null && a.heightCm < place.minHeightCm) {
          const labeled = aspirational && a.backstory.includes('aspiration');
          if (!labeled) { heightViolations += 1; errors.push({ path: `${p}.${a.agentId}.mustDoPlaceIds`, message: `${pid} requires ${place.minHeightCm} cm` }); }
        }
      }
    }
  }
  for (const a of m.personas) {
    if (!memberOf.has(a.agentId)) errors.push({ path: 'personas', message: `agent ${a.agentId} has no group` });
    if (a.phoneActiveUntilMs !== null && (a.phoneActiveUntilMs % SIM_STEP_MS !== 0 || !a.hasApp)) errors.push({ path: `personas.${a.agentId}.phoneActiveUntilMs`, message: 'invalid phone time' });
    for (const k of ['hunger', 'fatigue', 'patience', 'fun'] as const) {
      const v = a.initialNeeds[k];
      if (!(v >= 0 && v <= 100)) errors.push({ path: `personas.${a.agentId}.initialNeeds.${k}`, message: 'out of range' });
    }
  }
  return { errors, stats: { heightViolations, unsupervisedMinors } };
}
