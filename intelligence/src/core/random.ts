import type { Distribution } from '../../contract/behavior-v1.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';

export const RANDOM_VERSION = 'behavior-rng-v1';
export type RandomKey = string | number;
export type RandomStream = 'personas' | 'arrivals' | 'service' | 'movement' | 'behavior' | 'prose';

const TWO_POW_52 = 2 ** 52;

/** Semantic random value in [0, 1): sha256(canonical([version, seed, stream, ...keys])), first 13 hex digits / 2^52. */
export function semanticUniform(seed: string, stream: RandomStream | string, ...keys: RandomKey[]): number {
  const digest = sha256Hex(canonicalJson([RANDOM_VERSION, seed, stream, ...keys]));
  return parseInt(digest.slice(0, 13), 16) / TWO_POW_52;
}

/** Keyed generator bound to a seed and stream; every draw must name its semantic keys. */
export class SemanticRandom {
  constructor(readonly seed: string, readonly stream: RandomStream | string) {}

  uniform(...keys: RandomKey[]): number {
    return semanticUniform(this.seed, this.stream, ...keys);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number, ...keys: RandomKey[]): number {
    return min + Math.floor(this.uniform(...keys) * (max - min + 1));
  }

  range(min: number, max: number, ...keys: RandomKey[]): number {
    return min + this.uniform(...keys) * (max - min);
  }

  bernoulli(p: number, ...keys: RandomKey[]): boolean {
    return this.uniform(...keys) < p;
  }

  /** Approximately normal via Box-Muller from two keyed uniforms; clamped by caller. */
  normal(mean: number, sd: number, ...keys: RandomKey[]): number {
    const u1 = Math.max(this.uniform(...keys, 'n1'), 1e-12);
    const u2 = this.uniform(...keys, 'n2');
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  pick<T>(items: readonly T[], ...keys: RandomKey[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.min(items.length - 1, Math.floor(this.uniform(...keys) * items.length))] as T;
  }

  weighted<T extends string>(weights: readonly (readonly [T, number])[], ...keys: RandomKey[]): T {
    const total = weights.reduce((s, [, w]) => s + w, 0);
    if (!(total > 0)) throw new Error('weighted pick with zero total');
    const u = this.uniform(...keys) * total;
    let acc = 0;
    for (const [item, w] of weights) {
      acc += w;
      if (u < acc) return item;
    }
    return weights[weights.length - 1]![0];
  }
}

/**
 * Reference implementation of Engine's inverse-CDF sampling, used ONLY to verify golden vectors
 * and the plausibility lab. The worker never selects actions.
 */
export function referenceInverseCdf(probabilities: Distribution, u: number): string {
  const sorted = [...probabilities].sort((a, b) => (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0));
  const total = sorted.reduce((s, p) => s + p.probability, 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p.probability / total;
    if (u < acc) return p.optionId;
  }
  return sorted[sorted.length - 1]!.optionId;
}
