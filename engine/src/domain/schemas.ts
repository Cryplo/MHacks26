import { z } from 'zod';
import type { ParkBundle, PopulationManifest, RunConfig, Scenario } from '../../contract/behavior-v1.js';
import { DomainFault, ensure, hash } from './primitives.js';

const obj = z.strictObject;
export const idSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = int.min(1);
const time = int.refine(v => v % 5000 === 0, 'Must be a 5000 ms boundary');
const duration = time.refine(v => v > 0, 'Duration must be positive');
const meter = z.number().min(0).max(100);
const fraction = z.number().min(0).max(1);
const text = z.string().max(16000);
const vec = obj({ xM: z.number().min(0), yM: z.number().min(0) });
const needs = obj({ hunger: meter, fatigue: meter, patience: meter, fun: meter });
const wait = z.discriminatedUnion('kind', [
  obj({ kind: z.literal('fixed'), lowerMin: z.number().min(0).nullable(), upperMin: z.number().min(0).nullable(), text }),
  obj({ kind: z.literal('rounded_estimate'), roundToMin: positive, template: text }),
  obj({ kind: z.literal('range_estimate'), roundToMin: positive, spreadMin: int, template: text }),
]).refine(v => v.kind !== 'fixed' || v.lowerMin === null || v.upperMin === null || v.lowerMin <= v.upperMin, 'Invalid wait range');
const notice = obj({ text, channel: z.enum(['visual', 'aroma']), radiusM: z.number().positive().max(1000), cooldownMs: time });
const service = z.discriminatedUnion('kind', [
  obj({ kind: z.literal('ride'), seats: positive.max(1000), vehicles: positive.max(100), dispatchMs: duration,
    durationMs: duration, turnaroundMs: time, passShareBps: int.max(10000), passEnabled: z.boolean() }),
  obj({ kind: z.literal('counter'), servers: positive.max(1000), serviceMs: duration, activityMs: time,
    products: z.array(obj({ id: idSchema, label: text, unitPriceCents: int })).max(100) }),
  obj({ kind: z.literal('show'), seats: positive.max(10000), startsAtMs: z.array(time).max(1000), durationMs: duration }),
  obj({ kind: z.literal('rest'), durationMs: duration }), obj({ kind: z.literal('none') }),
]);
export const parkSchema = obj({
  contractVersion: z.literal('behavior.v1'), parkId: idSchema, revision: text.min(1), label: text,
  openLocal: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), closeAfterMs: duration.max(86400000),
  grid: obj({ width: positive.max(1000), height: positive.max(1000), cellM: z.number().positive().max(20),
    encoding: z.literal('u8-row-major-v1'), cellsBase64: z.string().max(1400000), cellsSha256: hashSchema, grassWalkable: z.literal(false) }),
  places: z.array(obj({ id: idSchema, name: text, kind: z.enum(['ride','food','shop','restroom','show','scenery','entrance','exit']),
    entrance: vec, queueZoneId: idSchema.nullable(), service, minHeightCm: z.number().min(0).max(250).nullable(),
    thrill: fraction, board: wait.nullable(), notice: notice.nullable() })).min(2).max(200),
  queueZones: z.array(obj({ id: idSchema, placeId: idSchema, cellIndices: z.array(int).min(1), entry: vec, exit: vec })).max(200),
  routeProfiles: z.array(obj({ id: idSchema, destinationId: idSchema, via: z.array(vec).min(1).max(100), label: text })).max(100),
  pass: obj({ productId: idSchema, unitPriceCents: int, unit: z.literal('per_guest'), validity: z.literal('remaining_day') }),
});
const archetype = z.enum(['young_family','teens','couple','thrill_seekers','seniors','solo']);
export const crowdSchema = obj({ guestCount: positive.max(1000), seed: text.min(1),
  shares: obj({ young_family: fraction, teens: fraction, couple: fraction, thrill_seekers: fraction, seniors: fraction, solo: fraction }),
  contextNotes: text, generatorVersion: text.min(1),
}).refine(v => Math.abs(Object.values(v.shares).reduce((a,b) => a+b,0)-1) <= 1e-6, 'Shares must sum to one');
export const populationSchema = obj({ contractVersion: z.literal('behavior.v1'), populationId: idSchema, crowd: crowdSchema,
  parkHash: hashSchema,
  personas: z.array(obj({ agentId: idSchema, groupId: idSchema, archetype,
    role: z.enum(['parent','child','teen','adult','senior']), ageYears: z.number().min(0).max(120),
    heightCm: z.number().positive().max(250), walkSpeedMps: z.number().positive().max(3), thrillPreference: fraction,
    initialNeeds: needs, hungerPerHour: z.number().min(0).max(100), fatiguePerKm: z.number().min(0).max(100),
    patiencePerMinute: z.number().min(0).max(100), familiarity: fraction, hasApp: z.boolean(), language: z.string().min(1).max(40),
    phoneActiveUntilMs: time.nullable(), stroller: z.boolean(), mobilityRestricted: z.boolean(), occasion: text,
    mustDoPlaceIds: z.array(idSchema).max(200), backstory: text,
  })).min(1).max(1000),
  groups: z.array(obj({ groupId: idSchema, memberIds: z.array(idSchema).min(1).max(100), leaderId: idSchema,
    guardianIds: z.array(idSchema).max(100), rallyPlaceId: idSchema, walletId: idSchema, startingBalanceCents: int,
    arrivalMs: time, plannedDepartureMs: duration,
  })).min(1).max(1000), proseVersion: text.min(1), randomVersion: z.literal('behavior-rng-v1'),
  diversity: z.array(obj({ key: text, counts: z.record(z.string(), int) })).max(100),
});
export const scenarioEventSchema = obj({ id: idSchema, atMs: time, order: int,
  change: z.discriminatedUnion('kind', [
    obj({ kind: z.literal('pass_price'), unitPriceCents: int }),
    obj({ kind: z.literal('pass_share'), placeId: idSchema, shareBps: int.max(10000) }),
    obj({ kind: z.literal('board'), placeId: idSchema, display: wait }),
    obj({ kind: z.literal('notice'), placeId: idSchema, notice }),
    obj({ kind: z.literal('closure'), placeId: idSchema, closed: z.boolean() }),
    obj({ kind: z.literal('show_schedule'), placeId: idSchema, startsAtMs: z.array(time) }),
    obj({ kind: z.literal('app_message'), messageId: idSchema, text, expiresAtMs: time, suggestedPlaceId: idSchema.nullable(),
      discount: obj({ productIds: z.array(idSchema), discountBps: int.max(10000), maxUsesPerGroup: positive }).nullable() }),
  ]),
});
export const scenarioSchema = obj({ id: idSchema, revision: text.min(1), label: text, events: z.array(scenarioEventSchema).max(10000) });
export const configSchema = obj({ mode: z.enum(['mock','live','experiment','replay']), horizonMs: duration.max(86400000),
  logicalStepMs: z.literal(5000), movementStepMs: z.literal(250), requestedSpeed: z.number().positive().max(10000),
  temperature: z.literal(1), earlyDepartureThresholdMs: time, ratingEveryMs: duration.nullable(),
  visualFrameEveryMs: duration, checkpointEveryMs: duration, fallback: z.enum(['forbidden','live_timeout_v1']), liveTimeoutMs: positive,
  features: obj({ routeChoice: z.boolean(), bumpReactions: z.literal(false), splitGroups: z.literal(false),
    speechBubbles: z.literal(false), discountMessages: z.literal(false) }),
  versions: obj({ engine: text.min(1), observation: text.min(1), options: text.min(1), random: z.literal('behavior-rng-v1'),
    persona: text.min(1), prompt: text.min(1), requestedModel: text.min(1), meter: text.min(1), loading: text.min(1),
    metrics: text.min(1), rubric: text.min(1), replay: text.min(1), sourceCommit: text.min(1) }),
}).refine(v => v.mode === 'live' || v.fallback === 'forbidden', 'Fallback is only permitted in declared live mode');
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fault = new DomainFault('INVALID_INPUT', 'Schema validation failed');
    fault.error.fieldErrors = r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
    throw fault;
  }
  return r.data;
}
export function unique(values: string[], label: string): void { ensure(new Set(values).size === values.length, `Duplicate ${label}`); }
export function validatePopulation(input: unknown, park: ParkBundle): PopulationManifest {
  const p = parse(populationSchema, input);
  ensure(p.parkHash === hash(park), 'Population belongs to a different park');
  ensure(p.crowd.guestCount === p.personas.length, 'Guest count mismatch');
  unique(p.personas.map(x => x.agentId), 'agent'); unique(p.groups.map(x => x.groupId), 'group');
  unique(p.groups.map(x => x.walletId), 'wallet');
  const people = new Map(p.personas.map(x => [x.agentId,x]));
  const places = new Set(park.places.map(x => x.id)); const assigned = new Set<string>();
  for (const g of p.groups) {
    unique(g.memberIds, 'member'); unique(g.guardianIds, 'guardian');
    ensure(g.arrivalMs < g.plannedDepartureMs && g.plannedDepartureMs <= park.closeAfterMs, 'Invalid visit times');
    ensure(places.has(g.rallyPlaceId), 'Unknown rally place');
    ensure(g.memberIds.includes(g.leaderId), 'Leader is not a member');
    for (const id of g.memberIds) {
      const person = people.get(id);
      ensure(person && person.groupId === g.groupId && !assigned.has(id), 'Missing, mismatched or repeated member');
      assigned.add(id);
      for (const goal of person.mustDoPlaceIds) ensure(places.has(goal), 'Unknown must-do place');
    }
    for (const id of g.guardianIds) ensure(g.memberIds.includes(id) && people.get(id)!.ageYears >= 18, 'Guardian must be an adult member');
    if (g.memberIds.some(id => people.get(id)!.role === 'child')) ensure(g.guardianIds.length > 0, 'Child requires guardian');
  }
  ensure(assigned.size === p.personas.length, 'Orphan persona');
  return p;
}
export function validateConfig(input: unknown): RunConfig { return parse(configSchema, input); }
export function validateScenario(input: unknown, park: ParkBundle): Scenario {
  const s = parse(scenarioSchema, input); unique(s.events.map(e => e.id), 'scenario event');
  const places = new Map(park.places.map(p => [p.id,p]));
  for (const e of s.events) {
    ensure(e.atMs <= 86400000, 'Event beyond supported day');
    const c = e.change;
    if ('placeId' in c) ensure(places.has(c.placeId), 'Unknown scenario place');
    if (c.kind === 'pass_share') ensure(places.get(c.placeId)!.service.kind === 'ride', 'Pass share requires a ride');
    if (c.kind === 'show_schedule') ensure(places.get(c.placeId)!.service.kind === 'show', 'Schedule requires a show');
    if (c.kind === 'app_message') {
      ensure(c.discount === null, 'Discounts unsupported'); ensure(c.expiresAtMs > e.atMs, 'Message already expired');
      ensure(c.suggestedPlaceId === null || places.has(c.suggestedPlaceId), 'Unknown suggested place');
    }
  }
  return s;
}
