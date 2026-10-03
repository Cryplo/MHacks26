import type { Distribution } from '../../contract/behavior-v1';
import { canonicalJson, compareCodeUnits, sha256Hex } from './canonical';

/**
 * Semantic random value (charter section 6). Display/verification helper only: the browser
 * never samples guest behavior. Used to verify that evidence draws match their keys.
 */
export async function semanticUniform(key: (string | number)[]): Promise<number> {
  const hex = await sha256Hex(canonicalJson(key));
  return parseInt(hex.slice(0, 13), 16) / 2 ** 52;
}

/** Inverse-CDF over option IDs in ascending code-unit order with `u < cumulative`. */
export function inverseCdfChoice(probabilities: Distribution, u: number): string {
  const sorted = [...probabilities].sort((a, b) => compareCodeUnits(a.optionId, b.optionId));
  let cumulative = 0;
  for (const p of sorted) {
    cumulative += p.probability;
    if (u < cumulative) return p.optionId;
  }
  // The final interval absorbs only normalization round-off.
  const last = sorted[sorted.length - 1];
  if (!last) throw new Error('empty distribution');
  return last.optionId;
}
