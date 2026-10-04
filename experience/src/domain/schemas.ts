/**
 * Runtime validators for contract DTOs the UI consumes from artifacts or text jobs. They
 * mirror contract/behavior-v1.ts (types are checked against it with `satisfies`-style
 * assertions in tests) and reject unknown enum values, non-integer money and bad IDs.
 */
import { z } from 'zod';
import type * as C from '../../contract/behavior-v1';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/, 'invalid id');
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'invalid sha256');
const simMs = z.number().int().nonnegative().refine(Number.isSafeInteger, 'unsafe integer');
const cents = z.number().int().refine(Number.isSafeInteger, 'unsafe integer');
const prob = z.number().finite().nonnegative();
const vec2 = z.object({ xM: z.number().finite(), yM: z.number().finite() }).strict();
const version = z.literal('behavior.v1');

export const domainErrorSchema = z.object({
  code: z.enum(['INVALID_INPUT', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'STALE_REVISION', 'STALE_LEASE', 'INVALID_STATE', 'UNSUPPORTED', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'INCOMPLETE', 'INTERNAL']),
  message: z.string(), retryable: z.boolean(), fieldErrors: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
}).strict();

export const artifactRefSchema = z.object({
  artifactId: id, kind: z.enum(['park', 'population', 'model_response', 'checkpoint', 'response_tape', 'fact_bundle', 'experiment_report', 'narrative', 'frames']),
  sha256: hash, byteLength: z.number().int().nonnegative(), mediaType: z.string(), contractVersion: version,
}).strict();

const waitDisplay = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rounded_estimate'), roundToMin: z.number().positive(), template: z.string() }).strict(),
  z.object({ kind: z.literal('range_estimate'), roundToMin: z.number().positive(), spreadMin: z.number().nonnegative(), template: z.string() }).strict(),
  z.object({ kind: z.literal('fixed'), lowerMin: z.number().nullable(), upperMin: z.number().nullable(), text: z.string() }).strict(),
]);
const service = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ride'), seats: z.number().int().positive(), vehicles: z.number().int().positive(), dispatchMs: simMs, durationMs: simMs, turnaroundMs: simMs, passShareBps: z.number().int().min(0).max(10000), passEnabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('counter'), servers: z.number().int().positive(), serviceMs: simMs, activityMs: simMs, products: z.array(z.object({ id, label: z.string(), unitPriceCents: cents }).strict()) }).strict(),
  z.object({ kind: z.literal('show'), seats: z.number().int().positive(), startsAtMs: z.array(simMs), durationMs: simMs }).strict(),
  z.object({ kind: z.literal('rest'), durationMs: simMs }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
const notice = z.object({ text: z.string(), channel: z.enum(['visual', 'aroma']), radiusM: z.number().nonnegative(), cooldownMs: simMs }).strict();
export const placeSchema = z.object({
  id, name: z.string(), kind: z.enum(['ride', 'food', 'shop', 'restroom', 'show', 'scenery', 'entrance', 'exit']), entrance: vec2,
  queueZoneId: id.nullable(), service, minHeightCm: z.number().nullable(), thrill: z.number().min(0).max(1), board: waitDisplay.nullable(), notice: notice.nullable(),
}).strict();
export const parkBundleSchema = z.object({
  contractVersion: version, parkId: id, revision: z.string(), label: z.string(), openLocal: z.string().regex(/^\d{2}:\d{2}$/), closeAfterMs: simMs,
  grid: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), cellM: z.number().positive(), encoding: z.literal('u8-row-major-v1'), cellsBase64: z.string(), cellsSha256: hash, grassWalkable: z.boolean() }).strict(),
  places: z.array(placeSchema),
  queueZones: z.array(z.object({ id, placeId: id, cellIndices: z.array(z.number().int().nonnegative()), entry: vec2, exit: vec2 }).strict()),
  routeProfiles: z.array(z.object({ id, destinationId: id, via: z.array(vec2), label: z.string() }).strict()),
  pass: z.object({ productId: id, unitPriceCents: cents, unit: z.literal('per_guest'), validity: z.literal('remaining_day') }).strict(),
}).strict();

const archetype = z.enum(['young_family', 'teens', 'couple', 'thrill_seekers', 'seniors', 'solo']);
const needs = z.object({ hunger: z.number(), fatigue: z.number(), patience: z.number(), fun: z.number() }).strict();
export const crowdSpecSchema = z.object({
  guestCount: z.number().int().positive(), seed: z.string(), shares: z.record(archetype, z.number().nonnegative()), contextNotes: z.string(), generatorVersion: z.string(),
}).strict();
export const personaSchema = z.object({
  agentId: id, groupId: id, archetype, role: z.enum(['parent', 'child', 'teen', 'adult', 'senior']), ageYears: z.number(), heightCm: z.number(),
  walkSpeedMps: z.number().positive(), thrillPreference: z.number().min(0).max(1), initialNeeds: needs, hungerPerHour: z.number(), fatiguePerKm: z.number(),
  patiencePerMinute: z.number(), familiarity: z.number(), hasApp: z.boolean(), language: z.string(), phoneActiveUntilMs: simMs.nullable(), stroller: z.boolean(),
  mobilityRestricted: z.boolean(), occasion: z.string(), mustDoPlaceIds: z.array(id), backstory: z.string(),
}).strict();
export const groupManifestSchema = z.object({
  groupId: id, memberIds: z.array(id).min(1), leaderId: id, guardianIds: z.array(id), rallyPlaceId: id, walletId: id, startingBalanceCents: cents,
  arrivalMs: simMs, plannedDepartureMs: simMs,
}).strict();
export const populationManifestSchema = z.object({
  contractVersion: version, populationId: id, crowd: crowdSpecSchema, parkHash: hash, personas: z.array(personaSchema), groups: z.array(groupManifestSchema),
  proseVersion: z.string(), randomVersion: z.string(), diversity: z.array(z.object({ key: z.string(), counts: z.record(z.string(), z.number()) }).strict()),
}).strict().superRefine((m, ctx) => {
  const ids = new Set(m.personas.map((p) => p.agentId));
  for (const g of m.groups) {
    if (!g.memberIds.includes(g.leaderId)) ctx.addIssue({ code: 'custom', message: `group ${g.groupId} leader not a member` });
    for (const mid of g.memberIds) if (!ids.has(mid)) ctx.addIssue({ code: 'custom', message: `group ${g.groupId} member ${mid} has no persona` });
  }
});

const change = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pass_price'), unitPriceCents: cents.refine((v) => v > 0, 'price must be positive') }).strict(),
  z.object({ kind: z.literal('pass_share'), placeId: id, shareBps: z.number().int().min(0).max(10000) }).strict(),
  z.object({ kind: z.literal('board'), placeId: id, display: waitDisplay }).strict(),
  z.object({ kind: z.literal('notice'), placeId: id, notice }).strict(),
  z.object({ kind: z.literal('closure'), placeId: id, closed: z.boolean() }).strict(),
  z.object({ kind: z.literal('show_schedule'), placeId: id, startsAtMs: z.array(simMs) }).strict(),
  z.object({ kind: z.literal('app_message'), messageId: id, text: z.string(), expiresAtMs: simMs, suggestedPlaceId: id.nullable(),
    discount: z.object({ productIds: z.array(id), discountBps: z.number().int().min(1).max(10000), maxUsesPerGroup: z.number().int().positive() }).strict().nullable() }).strict(),
]);
export const scenarioEventSchema = z.object({ id, atMs: simMs.refine((v) => v % 5000 === 0, 'must be a multiple of 5000 ms'), order: z.number().int(), change }).strict();
export const scenarioSchema = z.object({ id, revision: z.string(), label: z.string(), events: z.array(scenarioEventSchema) }).strict();
export const scenarioDraftSchema = z.object({
  draftId: id, contextRevision: z.string(), events: z.array(scenarioEventSchema), assumptions: z.array(z.string()), unsupported: z.array(z.string()), requiresConfirmation: z.literal(true),
}).strict();

const unit = z.enum(['cents', 'score', 'minutes', 'ratio', 'guests']);
const metricId = z.enum(['net_revenue_cents', 'revenue_per_guest_cents', 'satisfaction_0_100', 'queue_minutes_per_guest', 'completed_ride_wait_minutes', 'rides_per_guest', 'abandonment_rate', 'queue_time_share', 'early_departures', 'ride_seat_utilization', 'server_utilization']);
export const metricValueSchema = z.object({
  id: metricId, value: z.number().finite().nullable(), unit, numerator: z.number().finite(), denominator: z.number().finite().nullable(), n: z.number(),
  coverage: z.number().min(0).max(1), complete: z.boolean(), missingReason: z.string().nullable(),
}).strict();
export const metricSnapshotSchema = z.object({
  runId: id, simMs, revision: z.number().int(), definitionVersion: z.string(), admittedGuests: z.number().int(), guestsInPark: z.number().int(),
  measures: z.record(metricId, metricValueSchema),
  /** Additive, optional: per-state counts, per-place queue/revenue, satisfaction levels. */
  breakdown: z.object({
    states: z.record(z.string(), z.number()),
    places: z.array(z.object({
      placeId: id, standardPersons: z.number(), passPersons: z.number(), predictedWaitMs: z.number().nullable(),
      revenueCents: z.number(), servedGuests: z.number(),
    }).passthrough()),
    satisfactionLevels: z.array(z.number()),
  }).passthrough().optional(),
}).strict();

const scope = z.object({ runId: id.nullable(), experimentId: id.nullable() }).strict();
const quality = z.object({
  comparisonEligible: z.boolean(), reasons: z.array(z.string()), behaviorCounts: z.object({ laya: z.number().optional(), jev: z.number(), cache: z.number(), mock: z.number(), fallback: z.number() }).strict(),
  invalidAttempts: z.number(), staleAttempts: z.number(), pendingRatings: z.number(), terminalRatingsExpected: z.number(), terminalRatingsComplete: z.number(),
}).strict();
export const factBundleSchema = z.object({
  contractVersion: version, id, asOfMs: simMs, sourceHash: hash,
  facts: z.array(z.object({ id, label: z.string(), value: z.union([z.number().finite(), z.string()]), unit: z.string(), denominator: z.string(), scope,
    sourceEventIds: z.array(id), metricId: metricId.nullable(), limitations: z.array(z.string()) }).strict()),
  quality: quality.nullable(), scope,
}).strict();
export const narrativeSchema = z.object({
  id, evidenceHash: hash, origin: z.enum(['template', 'llm']), label: z.enum(['narrated from state', 'modeled-results report']),
  sections: z.array(z.object({ heading: z.string(), segments: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }).strict(), z.object({ kind: z.literal('fact'), factId: id }).strict()])) }).strict()),
  limitations: z.array(z.string()),
}).strict();

const distribution = z.array(z.object({ optionId: id, probability: prob }).strict());
export const decisionResultSchema = z.object({
  requestId: id, observationHash: hash, optionsHash: hash, modelRequested: z.string(), modelReturned: z.string(), source: z.enum(['jev', 'cache', 'mock', 'fallback', 'laya']),
  probabilities: distribution, confidence: z.number().nullable(), responseArtifact: artifactRefSchema,
  usage: z.object({ callId: id.nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), estimatedCostUsd: z.number().nullable(), priceVersion: z.string().nullable(), queueMs: z.number(), httpMs: z.number(), attemptCount: z.number() }).strict(),
  cacheKey: hash.nullable(), originalSource: z.enum(['jev', 'mock', 'fallback', 'laya']),
}).strict();

export const pairResultSchema = z.object({
  pairId: id, seed: z.string(), populationHash: hash, initialStateHash: hash.nullable(), aRunId: id.nullable(), bRunId: id.nullable(),
  status: z.enum(['pending', 'running', 'complete', 'incomplete', 'degraded', 'failed']), reasons: z.array(z.string()),
  a: metricSnapshotSchema.nullable(), b: metricSnapshotSchema.nullable(), deltas: z.record(metricId, z.number()),
}).strict();
export const pairedSummarySchema = z.object({
  metricId, pairCount: z.number().int(), differences: z.array(z.number()), mean: z.number().nullable(), min: z.number().nullable(), max: z.number().nullable(),
  sampleSd: z.number().nullable(), interval: z.object({ kind: z.literal('paired_t_mean'), lower: z.number(), upper: z.number(), level: z.literal(0.95) }).strict().nullable(),
}).strict();

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: string[] };
export function validate<T>(schema: z.ZodType, value: unknown): Validated<T> {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data as T };
  return { ok: false, issues: r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

// Compile-time links between validators and the frozen contract types.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _ContractChecks = [
  Assert<Same<z.infer<typeof artifactRefSchema>, C.ArtifactRef>>,
  Assert<Same<z.infer<typeof domainErrorSchema>, C.DomainError>>,
  Assert<Same<z.infer<typeof scenarioSchema>, C.Scenario>>,
  Assert<Same<z.infer<typeof narrativeSchema>, C.Narrative>>,
];
