import type {
  ArtifactRef, DecisionRequest, Distribution, Id, MetricSnapshot, MetricId, Scenario,
} from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { hashCanonical, isHash } from './canonical.ts';
import type { FieldError, Validated } from './errors.ts';
import { fail, ok } from './errors.ts';

export const PROBABILITY_SUM_TOLERANCE = 1e-6;
export const SIM_STEP_MS = 5000;

const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
export function isId(value: unknown): value is Id {
  return typeof value === 'string' && ID_RE.test(value);
}

export function isSimMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isBoundaryMs(value: unknown): value is number {
  return isSimMs(value) && value % SIM_STEP_MS === 0;
}

export function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export const METRIC_IDS: readonly MetricId[] = [
  'net_revenue_cents', 'revenue_per_guest_cents', 'satisfaction_0_100', 'queue_minutes_per_guest',
  'completed_ride_wait_minutes', 'rides_per_guest', 'abandonment_rate', 'queue_time_share',
  'early_departures', 'ride_seat_utilization', 'server_utilization',
];

export type DistributionCheck = {
  /** Raw values exactly as returned, in expected-ID order. */
  raw: Distribution;
  sum: number;
  sumError: number;
};

/**
 * Validates a probability vector against exactly the expected option IDs.
 * Never normalizes and never invents mass; Engine applies accepted round-off normalization.
 */
export function validateDistribution(
  expectedIds: readonly Id[], values: readonly { optionId: unknown; probability: unknown }[], path = 'probabilities',
): Validated<DistributionCheck> {
  const errors: FieldError[] = [];
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length) errors.push({ path, message: 'expected option IDs are not unique' });
  const seen = new Set<string>();
  values.forEach((v, i) => {
    const p = `${path}[${i}]`;
    if (typeof v.optionId !== 'string') { errors.push({ path: `${p}.optionId`, message: 'missing option ID' }); return; }
    if (!expected.has(v.optionId)) errors.push({ path: `${p}.optionId`, message: `unknown option ${v.optionId}` });
    if (seen.has(v.optionId)) errors.push({ path: `${p}.optionId`, message: `duplicate option ${v.optionId}` });
    seen.add(v.optionId);
    if (!isFiniteNumber(v.probability)) errors.push({ path: `${p}.probability`, message: 'probability is not finite' });
    else if (v.probability < 0) errors.push({ path: `${p}.probability`, message: 'negative probability' });
    else if (v.probability > 1 + PROBABILITY_SUM_TOLERANCE) errors.push({ path: `${p}.probability`, message: 'probability exceeds 1' });
  });
  for (const id of expectedIds) if (!seen.has(id)) errors.push({ path, message: `missing option ${id}` });
  if (errors.length) return fail(errors);
  const byId = new Map(values.map((v) => [v.optionId as string, v.probability as number]));
  const raw = expectedIds.map((id) => ({ optionId: id, probability: byId.get(id)! }));
  const sum = raw.reduce((s, p) => s + p.probability, 0);
  if (sum === 0) return fail([{ path, message: 'all-zero distribution' }]);
  const sumError = Math.abs(sum - 1);
  if (sumError > PROBABILITY_SUM_TOLERANCE) return fail([{ path, message: `probabilities sum to ${sum}, outside tolerance ${PROBABILITY_SUM_TOLERANCE}` }]);
  return ok({ raw, sum, sumError });
}

export function observationHash(req: Pick<DecisionRequest, 'observation'>): string {
  return hashCanonical(req.observation);
}

export function optionsHash(req: Pick<DecisionRequest, 'options' | 'promptOptionOrder'>): string {
  return hashCanonical({ options: req.options, promptOptionOrder: req.promptOptionOrder });
}

/** Validates the frozen DecisionRequest snapshot before any provider call. */
export function validateDecisionRequest(req: DecisionRequest): Validated<DecisionRequest> {
  const errors: FieldError[] = [];
  if (req.contractVersion !== CONTRACT_VERSION) errors.push({ path: 'contractVersion', message: 'unsupported contract version' });
  for (const k of ['requestId', 'runId', 'groupId'] as const) if (!isId(req[k])) errors.push({ path: k, message: 'invalid id' });
  if (!isSimMs(req.createdAtMs) || !isSimMs(req.applyAtMs)) errors.push({ path: 'applyAtMs', message: 'invalid sim time' });
  if (!Array.isArray(req.options) || req.options.length === 0) errors.push({ path: 'options', message: 'no options' });
  const ids = (req.options ?? []).map((o) => o.id);
  if (new Set(ids).size !== ids.length) errors.push({ path: 'options', message: 'duplicate option ids' });
  const order = req.promptOptionOrder ?? [];
  if (order.length !== ids.length || new Set(order).size !== order.length || !order.every((id) => ids.includes(id))) {
    errors.push({ path: 'promptOptionOrder', message: 'not a complete unique permutation of option ids' });
  }
  if (!isHash(req.observationHash) || req.observationHash !== observationHash(req)) errors.push({ path: 'observationHash', message: 'observation hash mismatch' });
  if (!isHash(req.optionsHash) || req.optionsHash !== optionsHash(req)) errors.push({ path: 'optionsHash', message: 'options hash mismatch' });
  if (req.observation?.schema !== 'observation.v1') errors.push({ path: 'observation.schema', message: 'unsupported observation schema' });
  return errors.length ? fail(errors) : ok(req);
}

export function validateArtifactRef(ref: ArtifactRef): Validated<ArtifactRef> {
  const errors: FieldError[] = [];
  if (!isId(ref.artifactId)) errors.push({ path: 'artifactId', message: 'invalid id' });
  if (!isHash(ref.sha256)) errors.push({ path: 'sha256', message: 'invalid hash' });
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) errors.push({ path: 'byteLength', message: 'invalid length' });
  if (ref.contractVersion !== CONTRACT_VERSION) errors.push({ path: 'contractVersion', message: 'unsupported contract version' });
  return errors.length ? fail(errors) : ok(ref);
}

export function validateScenario(s: Scenario, path = 'scenario'): FieldError[] {
  const errors: FieldError[] = [];
  if (!isId(s.id)) errors.push({ path: `${path}.id`, message: 'invalid id' });
  const ids = new Set<string>();
  s.events.forEach((e, i) => {
    const p = `${path}.events[${i}]`;
    if (!isId(e.id) || ids.has(e.id)) errors.push({ path: `${p}.id`, message: 'invalid or duplicate event id' });
    ids.add(e.id);
    if (!isBoundaryMs(e.atMs)) errors.push({ path: `${p}.atMs`, message: 'event time must be a 5000 ms boundary' });
    if (e.change.kind === 'pass_price' && (!isCents(e.change.unitPriceCents) || e.change.unitPriceCents < 0)) {
      errors.push({ path: `${p}.change.unitPriceCents`, message: 'invalid cents' });
    }
  });
  return errors;
}

export function validateMetricSnapshot(m: MetricSnapshot): FieldError[] {
  const errors: FieldError[] = [];
  for (const id of METRIC_IDS) {
    const v = m.measures[id];
    if (!v) { errors.push({ path: `measures.${id}`, message: 'missing metric' }); continue; }
    if (v.id !== id) errors.push({ path: `measures.${id}.id`, message: 'id mismatch' });
    if (v.value !== null && !isFiniteNumber(v.value)) errors.push({ path: `measures.${id}.value`, message: 'non-finite value' });
    if (v.denominator !== null && !isFiniteNumber(v.denominator)) errors.push({ path: `measures.${id}.denominator`, message: 'non-finite denominator' });
    if (v.denominator === 0 && v.value !== null) errors.push({ path: `measures.${id}.value`, message: 'value with zero denominator must be null' });
  }
  return errors;
}
