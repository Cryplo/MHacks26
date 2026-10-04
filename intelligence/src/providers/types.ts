import type { DecisionRequest, RatingRequest } from '../../contract/behavior-v1.ts';

export type ProviderUsage = { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };

export type ProviderCallContext = { signal: AbortSignal; callId: string };

/** Unvalidated provider output plus the exact raw bytes received. Validation happens in the worker. */
export type ProviderDecision = {
  raw: Uint8Array; modelReturned: string;
  probabilities: { optionId: unknown; probability: unknown }[];
  confidence: number | null; usage: ProviderUsage; httpMs: number;
  /** Set when a vendor-quantized vector was renormalized at the adapter (raw bytes unchanged). */
  quantization?: { step: number; rawSum: number } | null;
};

export type ProviderRating = {
  raw: Uint8Array; modelReturned: string;
  /** Distribution over rubric level indices 0..K-1, in index order. */
  probabilities: unknown[];
  /** Score as returned by the provider (expected to be a level index). */
  score: unknown;
  usage: ProviderUsage; httpMs: number;
  quantization?: { step: number; rawSum: number } | null;
};

export type ProviderErrorKind =
  | 'transient' | 'timeout' | 'rate_limited' | 'aborted'
  | 'auth' | 'payment' | 'unsupported_model' | 'schema' | 'invalid_output' | 'too_large' | 'budget';

const PERMANENT: ReadonlySet<ProviderErrorKind> = new Set(['auth', 'payment', 'unsupported_model', 'schema', 'budget']);

export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    readonly kind: ProviderErrorKind, message: string,
    readonly opts: { status?: number; retryAfterMs?: number | null; raw?: Uint8Array; modelReturned?: string | null; usage?: ProviderUsage; billed?: boolean; httpMs?: number } = {},
  ) { super(message); }

  get permanent(): boolean { return PERMANENT.has(this.kind); }
  get retryable(): boolean { return !this.permanent && this.kind !== 'aborted'; }
}

export interface BehaviorProvider {
  readonly source: 'jev' | 'mock';
  /** Requested model identity; part of every cache key. */
  readonly model: string;
  /** Versioned instructions/request format; part of every cache key. */
  readonly instructionsVersion: string;
  estimateInputTokens(req: DecisionRequest | RatingRequest): number;
  decide(req: DecisionRequest, ctx: ProviderCallContext): Promise<ProviderDecision>;
  rate(req: RatingRequest, ctx: ProviderCallContext): Promise<ProviderRating>;
}

/** Rough deterministic token estimate (UTF-8 bytes / 4) used only for limiter admission. */
export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 4);
}
