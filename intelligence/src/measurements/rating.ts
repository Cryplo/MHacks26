import type { MetricValue, RatingRequest, RatingResult } from '../../contract/behavior-v1.ts';
import { isHash } from '../core/canonical.ts';
import type { FieldError, Validated } from '../core/errors.ts';
import { fail, ok } from '../core/errors.ts';
import { PROBABILITY_SUM_TOLERANCE, isId, isSimMs } from '../core/validate.ts';

/** Fixed rubrics. A rating is a synthetic judgment, not a validated human survey. */
export const RUBRICS: Record<string, { levels: readonly string[]; question: string }> = {
  'satisfaction-rubric-v1': {
    question: 'Overall, how satisfied would this guest say they are with their visit so far?',
    levels: ['very dissatisfied', 'dissatisfied', 'neutral', 'satisfied', 'very satisfied'],
  },
};

export function validateRatingRequest(req: RatingRequest): Validated<RatingRequest> {
  const errors: FieldError[] = [];
  for (const k of ['ratingId', 'runId', 'agentId'] as const) if (!isId(req[k])) errors.push({ path: k, message: 'invalid id' });
  if (!isSimMs(req.atMs)) errors.push({ path: 'atMs', message: 'invalid sim time' });
  if (!['periodic', 'departure', 'horizon'].includes(req.endpoint)) errors.push({ path: 'endpoint', message: 'unknown endpoint' });
  if (!isHash(req.evidenceHash)) errors.push({ path: 'evidenceHash', message: 'invalid hash' });
  const rubric = RUBRICS[req.rubricVersion];
  if (!rubric) errors.push({ path: 'rubricVersion', message: `unknown rubric ${req.rubricVersion}` });
  else if (req.levels.length !== rubric.levels.length || req.levels.some((l, i) => l !== rubric.levels[i])) {
    errors.push({ path: 'levels', message: 'levels do not match the frozen rubric' });
  }
  if (req.levels.length < 2 || req.levels.length > 10) errors.push({ path: 'levels', message: 'rubric must have 2..10 levels' });
  if (!req.observation?.members?.some((m) => m.persona.agentId === req.agentId)) {
    errors.push({ path: 'agentId', message: 'rated member is not in the frozen observation' });
  }
  return errors.length ? fail(errors) : ok(req);
}

export type RatingOutputCheck = { ok: true; probabilities: number[]; sum: number; scoreIndex: number } | { ok: false; reason: string };

/** Validates a returned score index and level distribution; never imputes or normalizes. */
export function validateRatingOutput(req: RatingRequest, probabilities: unknown[], score: unknown): RatingOutputCheck {
  const k = req.levels.length;
  if (!Array.isArray(probabilities) || probabilities.length !== k) return { ok: false, reason: `expected ${k} level probabilities` };
  for (const p of probabilities) if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) return { ok: false, reason: 'invalid level probability' };
  const ps = probabilities as number[];
  const sum = ps.reduce((s, p) => s + p, 0);
  if (sum === 0) return { ok: false, reason: 'all-zero rating distribution' };
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return { ok: false, reason: `rating probabilities sum to ${sum}` };
  if (typeof score !== 'number' || !Number.isFinite(score)) return { ok: false, reason: 'missing score' };
  if (score < 0 || score > k - 1) return { ok: false, reason: `score ${score} outside level range 0..${k - 1}` };
  // A fractional provider score maps to its nearest level index; the raw score stays in the response artifact.
  return { ok: true, probabilities: ps, sum, scoreIndex: Math.round(score) };
}

/** Display mapping `100 * index / (K-1)`; null when the rating is missing. */
export function displayScore(r: Pick<RatingResult, 'scoreIndex' | 'probabilities'> | null): number | null {
  if (!r) return null;
  const k = r.probabilities.length;
  return k > 1 ? (100 * r.scoreIndex) / (k - 1) : null;
}

/**
 * Available-case satisfaction over the expected terminal ratings (one per admitted individual).
 * Missing or failed ratings reduce coverage; they are never imputed from the experience ledger,
 * the group leader, or zero. No ratings at all gives value null.
 */
export function summarizeTerminalRatings(expectedAgentIds: readonly string[], ratings: ReadonlyMap<string, Pick<RatingResult, 'scoreIndex' | 'probabilities'>>): MetricValue {
  const values: number[] = [];
  for (const id of new Set(expectedAgentIds)) {
    const r = ratings.get(id);
    const v = r ? displayScore(r) : null;
    if (v !== null) values.push(v);
  }
  const expected = new Set(expectedAgentIds).size;
  const n = values.length;
  const numerator = values.reduce((s, v) => s + v, 0);
  return {
    id: 'satisfaction_0_100', value: n ? numerator / n : null, unit: 'score', numerator, denominator: n || null, n,
    coverage: expected ? n / expected : 0, complete: expected > 0 && n === expected,
    missingReason: n === expected ? (expected ? null : 'no admitted guests') : `${expected - n} of ${expected} terminal ratings missing or failed; available-case value`,
  };
}

/** Checks that a result answers exactly the request it claims to (B-13). */
export function ratingMatchesRequest(req: RatingRequest, res: RatingResult): boolean {
  return res.ratingId === req.ratingId && res.evidenceHash === req.evidenceHash && res.rubricVersion === req.rubricVersion
    && res.probabilities.length === req.levels.length && res.scoreIndex >= 0 && res.scoreIndex < req.levels.length;
}
