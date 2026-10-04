import type { ArtifactRef, Distribution, Hash, Id } from '../../contract/behavior-v1.ts';

export type ExecutorClass = 'behavior' | 'measurement' | 'text' | 'experiment';

/** Write-once response cache entry. Distributions only; never a chosen action. */
export type CacheEntry = {
  schema: 'response-cache-entry.v1';
  namespace: string; key: Hash; kind: 'decision' | 'rating';
  modelRequested: string; modelReturned: string; policyVersion: string; instructionsVersion: string;
  originalSource: 'jev' | 'mock' | 'fallback' | 'laya';
  /** Validated raw values exactly as returned (decision: by option id; rating: by level index). */
  probabilities: Distribution | number[];
  /** Rating score index as returned by the provider (null for decisions). */
  score: number | null;
  confidence: number | null;
  responseArtifact: ArtifactRef;
  normalization: { rawSum: number; sumError: number; appliedBy: 'engine' };
  callId: Id | null;
  createdAtEpochMs: number;
  /** Provider reasoning text, when the provider returned any (optional; absent in older entries). */
  reasoning?: string | null;
};

export interface ResponseCachePort {
  get(namespace: string, key: Hash): Promise<CacheEntry | null>;
  /** First accepted value wins; later writers receive the winner. */
  putIfAbsent(entry: CacheEntry): Promise<{ entry: CacheEntry; created: boolean }>;
  link(namespace: string, key: Hash, requestId: Id): Promise<void>;
}

export interface CoalescerPort {
  /** Runs `fn` once per in-flight key; concurrent callers share the outcome. */
  run<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; owner: boolean }>;
}

export interface Permit { release(actual?: { inputTokens: number | null }): void }

export interface LimiterPort {
  acquire(cls: ExecutorClass, estimatedInputTokens: number, signal: AbortSignal): Promise<Permit>;
  /** Pause provider admission account-wide until the given wall-clock epoch. */
  pauseUntil(epochMs: number): void;
  snapshot(): Record<string, unknown>;
}

export const noCache: ResponseCachePort = {
  get: async () => null,
  putIfAbsent: async (entry) => ({ entry, created: true }),
  link: async () => undefined,
};

export const noCoalescing: CoalescerPort = {
  run: async (_key, fn) => ({ value: await fn(), owner: true }),
};

export const unlimited: LimiterPort = {
  acquire: async () => ({ release: () => undefined }),
  pauseUntil: () => undefined,
  snapshot: () => ({ kind: 'unlimited' }),
};
