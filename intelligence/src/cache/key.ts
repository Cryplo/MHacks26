import type { DecisionRequest, Hash, RatingRequest } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';

export const CACHE_KEY_VERSION = 'cache-key-v1';

export type ProviderIdentity = { source: 'jev' | 'mock' | 'laya'; model: string; instructionsVersion: string };

/**
 * The exact semantic content a provider sees for a decision. Includes the full observation
 * (text, goals, persona, needs, budget, memory, quotes), options with executable arguments, the
 * prompt permutation, moment and policy. Excludes request/run/lease/command IDs and bookkeeping
 * revisions, which do not change what is asked.
 */
export function semanticDecisionRequest(req: DecisionRequest) {
  return {
    schema: 'semantic-decision.v1', moment: req.moment, policyVersion: req.policyVersion,
    observation: req.observation, options: req.options, promptOptionOrder: req.promptOptionOrder,
  };
}

export function decisionCacheKey(req: DecisionRequest, provider: ProviderIdentity): Hash {
  return hashCanonical({
    v: CACHE_KEY_VERSION, kind: 'decision', semantic: semanticDecisionRequest(req),
    optionsHash: req.optionsHash, provider: provider.source, modelRequested: provider.model,
    instructionsVersion: provider.instructionsVersion, policyVersion: req.policyVersion,
  });
}

/** Rating identity: the rated member, frozen evidence and rubric. The rating/question ID is excluded. */
export function semanticRatingRequest(req: RatingRequest) {
  return {
    schema: 'semantic-rating.v1', agentId: req.agentId, evidenceHash: req.evidenceHash,
    observation: req.observation, rubricVersion: req.rubricVersion, levels: req.levels,
  };
}

export function ratingCacheKey(req: RatingRequest, provider: ProviderIdentity): Hash {
  return hashCanonical({
    v: CACHE_KEY_VERSION, kind: 'rating', semantic: semanticRatingRequest(req),
    provider: provider.source, modelRequested: provider.model, instructionsVersion: provider.instructionsVersion,
  });
}
