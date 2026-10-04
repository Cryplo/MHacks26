import type { DecisionRequest, RatingRequest } from '../../contract/behavior-v1.ts';
import { canonicalBytes } from '../../src/core/canonical.ts';
import { observationHash, optionsHash } from '../../src/core/validate.ts';
import { mockDistribution, mockRatingDistribution } from '../../src/providers/mock.ts';
import type { BehaviorProvider, ProviderDecision, ProviderRating, ProviderUsage } from '../../src/providers/types.ts';

/**
 * Scripted provider that reports source "jev" for orchestration/billing tests WITHOUT network.
 * Its numbers are the mock policy's; results from it are never presented as real Jev evidence.
 */
export class ScriptedJev implements BehaviorProvider {
  readonly source = 'jev' as const;
  readonly model = 'jev-1.13.0';
  readonly instructionsVersion = 'jev-instructions-v1';
  calls = 0;
  gate: Promise<void> | null = null;
  script: ((n: number) => Partial<ProviderDecision> | Error)[] = [];
  usage: ProviderUsage = { inputTokens: 100, outputTokens: null, costUsd: 0.00004 };

  estimateInputTokens(): number { return 100; }

  async decide(req: DecisionRequest): Promise<ProviderDecision> {
    const n = ++this.calls;
    if (this.gate) await this.gate;
    const step = this.script[n - 1]?.(n);
    if (step instanceof Error) throw step;
    const probabilities = mockDistribution(req);
    return { raw: canonicalBytes({ scripted: true, n, probabilities }), modelReturned: this.model, probabilities, confidence: null, usage: this.usage, httpMs: 5, ...step };
  }

  async rate(req: RatingRequest): Promise<ProviderRating> {
    this.calls++;
    const probabilities = mockRatingDistribution(req);
    return { raw: canonicalBytes({ scripted: true, probabilities }), modelReturned: this.model, probabilities, score: 2, usage: this.usage, httpMs: 5 };
  }
}

export function rehash<T extends DecisionRequest>(r: T): T {
  r.observationHash = observationHash(r);
  r.optionsHash = optionsHash(r);
  return r;
}
