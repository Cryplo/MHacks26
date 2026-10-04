import type {
  ArtifactRef, DecisionRequest, DecisionResult, Hash, Id, RatingRequest, RatingResult, RuntimeClient, Scope, Source, Usage,
} from '../../contract/behavior-v1.ts';
import { sha256Hex } from '../core/canonical.ts';
import { validateDecisionRequest, validateDistribution } from '../core/validate.ts';
import { decisionCacheKey, ratingCacheKey } from '../cache/key.ts';
import { validateRatingOutput, validateRatingRequest } from '../measurements/rating.ts';
import type { Clock, Jitter, Logger } from '../runtime/clock.ts';
import type { IdSource } from '../runtime/commands.ts';
import { artifactCommandId } from '../runtime/commands.ts';
import type { DurableStore } from '../runtime/store.ts';
import type { BehaviorProvider, ProviderCallContext, ProviderDecision, ProviderRating, ProviderUsage } from '../providers/types.ts';
import { ProviderError } from '../providers/types.ts';
import type { BackoffPolicy } from './backoff.ts';
import { backoffDelayMs } from './backoff.ts';
import type { CacheEntry, CoalescerPort, ExecutorClass, LimiterPort, ResponseCachePort } from './ports.ts';
import { noCache, noCoalescing, unlimited } from './ports.ts';
import type { UsageLedger } from './usage.ts';
import { costFor } from './usage.ts';

export class InvalidRequestError extends Error {
  override name = 'InvalidRequestError';
  constructor(message: string, readonly fieldErrors: { path: string; message: string }[] = []) { super(message); }
}

export type InferenceConfig = {
  maxAttempts: number; backoff: BackoffPolicy;
  /** Namespace for the write-once response cache; frozen per experiment. */
  namespace: (scope: Scope) => string;
  billingOwnerRunId: (scope: Scope) => Id | null;
};

export type InferenceDeps = {
  provider: BehaviorProvider; client: RuntimeClient; ledger: UsageLedger; store: DurableStore;
  clock: Clock; jitter: Jitter; ids: IdSource; logger: Logger;
  cache?: ResponseCachePort; coalescer?: CoalescerPort; limiter?: LimiterPort;
};

export type InferenceStats = {
  providerCalls: number; cacheHits: number; coalesced: number; invalidOutputs: number; retries: number;
  errors: Record<string, number>; httpMs: number[]; queueMs: number[];
};

export type CallHooks = { onCallStarted?: (callId: Id) => Promise<void> };

type Accepted = { entry: CacheEntry; callId: Id; usage: Usage };
type ProviderOutput = { raw: Uint8Array; modelReturned: string; usage: ProviderUsage; httpMs: number };
type Validator<R> = (r: R) =>
  | { ok: true; probabilities: CacheEntry['probabilities']; rawSum: number; sumError: number; confidence: number | null; score: number | null }
  | { ok: false; reason: string };

const ABORT = () => new ProviderError('aborted', 'aborted');

/**
 * Shared pipeline: exact cache lookup -> coalescing -> rate-limit admission -> started telemetry ->
 * provider call -> raw response persistence -> validation -> write-once cache -> finished telemetry.
 * Retries happen ONLY here (one layer); provider adapters never retry internally.
 */
export class InferenceService {
  readonly stats: InferenceStats = { providerCalls: 0, cacheHits: 0, coalesced: 0, invalidOutputs: 0, retries: 0, errors: {}, httpMs: [], queueMs: [] };
  private readonly cache: ResponseCachePort;
  private readonly coalescer: CoalescerPort;
  private readonly limiter: LimiterPort;

  constructor(private readonly deps: InferenceDeps, private readonly config: InferenceConfig) {
    this.cache = deps.cache ?? noCache;
    this.coalescer = deps.coalescer ?? noCoalescing;
    this.limiter = deps.limiter ?? unlimited;
  }

  get provider(): BehaviorProvider { return this.deps.provider; }

  /** A cached entry is acceptable only if it came from this provider's own source (mock/fallback never satisfy Jev). */
  private acceptable(e: CacheEntry): boolean {
    return e.originalSource === this.deps.provider.source && e.modelRequested === this.deps.provider.model;
  }

  async decide(workId: Id, scope: Scope, req: DecisionRequest, signal: AbortSignal, hooks: CallHooks = {}): Promise<DecisionResult> {
    const v = validateDecisionRequest(req);
    if (!v.ok) throw new InvalidRequestError(`invalid decision snapshot: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    const key = decisionCacheKey(req, this.deps.provider);
    const expectedIds = req.options.map((o) => o.id);
    const { accepted, source } = await this.resolve('behavior', 'decision', req.policyVersion, workId, scope, req.requestId, key, this.deps.provider.estimateInputTokens(req), signal, hooks,
      (ctx) => this.deps.provider.decide(req, ctx),
      (resp: ProviderDecision) => {
        const d = validateDistribution(expectedIds, resp.probabilities);
        if (!d.ok) return { ok: false as const, reason: d.errors.map((e) => e.message).join('; ') };
        if (resp.confidence !== null && !(Number.isFinite(resp.confidence) && resp.confidence >= 0 && resp.confidence <= 1)) return { ok: false as const, reason: 'confidence out of range' };
        return { ok: true as const, probabilities: d.value.raw, rawSum: d.value.sum, sumError: d.value.sumError, confidence: resp.confidence, score: null };
      });
    const byId = new Map((accepted.entry.probabilities as { optionId: string; probability: number }[]).map((p) => [p.optionId, p.probability]));
    return {
      requestId: req.requestId, observationHash: req.observationHash, optionsHash: req.optionsHash,
      modelRequested: this.deps.provider.model, modelReturned: accepted.entry.modelReturned, source,
      probabilities: req.options.map((o) => ({ optionId: o.id, probability: byId.get(o.id)! })),
      confidence: accepted.entry.confidence, responseArtifact: accepted.entry.responseArtifact, usage: accepted.usage,
      cacheKey: key, originalSource: accepted.entry.originalSource,
    };
  }

  async rate(workId: Id, scope: Scope, req: RatingRequest, signal: AbortSignal, hooks: CallHooks = {}): Promise<RatingResult> {
    const v = validateRatingRequest(req);
    if (!v.ok) throw new InvalidRequestError(`invalid rating snapshot: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    const key = ratingCacheKey(req, this.deps.provider);
    const { accepted, source } = await this.resolve('measurement', 'rating', req.rubricVersion, workId, scope, req.ratingId, key, this.deps.provider.estimateInputTokens(req), signal, hooks,
      (ctx) => this.deps.provider.rate(req, ctx),
      (resp: ProviderRating) => {
        const r = validateRatingOutput(req, resp.probabilities, resp.score);
        if (!r.ok) return { ok: false as const, reason: r.reason };
        return { ok: true as const, probabilities: r.probabilities, rawSum: r.sum, sumError: Math.abs(r.sum - 1), confidence: null, score: r.scoreIndex };
      });
    const probabilities = accepted.entry.probabilities as number[];
    return {
      ratingId: req.ratingId, evidenceHash: req.evidenceHash, rubricVersion: req.rubricVersion,
      scoreIndex: accepted.entry.score!, probabilities, source, modelReturned: accepted.entry.modelReturned,
      responseArtifact: accepted.entry.responseArtifact, usage: accepted.usage,
    };
  }

  private async resolve<R extends ProviderOutput>(
    cls: ExecutorClass, kind: 'decision' | 'rating', policyVersion: string, workId: Id, scope: Scope, requestId: Id, key: Hash, estTokens: number,
    signal: AbortSignal, hooks: CallHooks,
    call: (ctx: ProviderCallContext) => Promise<R>,
    validate: Validator<R>,
  ): Promise<{ accepted: Accepted; source: Source }> {
    const ns = this.config.namespace(scope);
    const cached = await this.cache.get(ns, key);
    if (cached && this.acceptable(cached)) {
      this.stats.cacheHits += 1;
      await this.cache.link(ns, key, requestId);
      return { accepted: { entry: cached, callId: cached.callId ?? '', usage: zeroUsage(null) }, source: 'cache' };
    }
    if (cached) this.deps.logger.log('warn', 'cache.provenance_rejected', { key, originalSource: cached.originalSource, required: this.deps.provider.source });
    const { value, owner } = await this.coalescer.run(`${ns}|${key}`, () => this.callWithRetries(cls, kind, policyVersion, workId, scope, key, ns, estTokens, signal, hooks, call, validate));
    await this.cache.link(ns, key, requestId);
    if (!owner) {
      this.stats.coalesced += 1;
      await this.deps.ledger.addBeneficiary(value.callId, workId);
      return { accepted: { ...value, usage: zeroUsage(value.callId) }, source: 'cache' };
    }
    return { accepted: value, source: this.deps.provider.source };
  }

  private async callWithRetries<R extends ProviderOutput>(
    cls: ExecutorClass, kind: 'decision' | 'rating', policyVersion: string, workId: Id, scope: Scope, key: Hash, ns: string, estTokens: number,
    signal: AbortSignal, hooks: CallHooks,
    call: (ctx: ProviderCallContext) => Promise<R>,
    validate: Validator<R>,
  ): Promise<Accepted> {
    const { provider, ledger, clock, ids, logger } = this.deps;
    let lastError: ProviderError | null = null;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      if (signal.aborted) throw ABORT();
      const queuedAt = clock.nowEpochMs();
      const permit = await this.limiter.acquire(cls, estTokens, signal);
      const queueMs = clock.nowEpochMs() - queuedAt;
      this.stats.queueMs.push(queueMs);
      const callId = ids.next('call');
      const startedAt = clock.nowEpochMs();
      const base = {
        callId, workId, provider: 'jev' as const, modelRequested: provider.model, startedAtEpochMs: startedAt,
        billingOwnerRunId: this.config.billingOwnerRunId(scope),
      };
      try {
        await hooks.onCallStarted?.(callId);
        await ledger.started({ ...base, phase: 'started', modelReturned: null, durationMs: null, outcome: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null, priceVersion: null });
      } catch (e) {
        permit.release();
        throw e;
      }
      this.stats.providerCalls += 1;
      let resp: R;
      try {
        resp = await call({ signal, callId });
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError(signal.aborted ? 'aborted' : 'transient', (e as Error).message);
        permit.release({ inputTokens: pe.opts.usage?.inputTokens ?? null });
        const usage = pe.opts.usage ?? { inputTokens: null, outputTokens: null, costUsd: null };
        const cost = costFor(usage);
        await ledger.finished({
          ...base, phase: 'finished', modelReturned: pe.opts.modelReturned ?? null, durationMs: clock.nowEpochMs() - startedAt,
          outcome: pe.kind === 'timeout' ? 'timeout' : pe.kind === 'rate_limited' ? 'rate_limited' : pe.kind === 'invalid_output' || pe.kind === 'too_large' ? 'invalid' : 'error',
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: cost.usd, priceVersion: cost.priceVersion,
        }, cost.basis);
        this.stats.errors[pe.kind] = (this.stats.errors[pe.kind] ?? 0) + 1;
        if (pe.opts.raw) await this.persistRaw(pe.opts.raw);
        if (pe.kind === 'aborted' || signal.aborted) throw ABORT();
        if (pe.permanent) throw pe;
        if (pe.kind === 'invalid_output' || pe.kind === 'too_large') this.stats.invalidOutputs += 1;
        lastError = pe;
        if (attempt >= this.config.maxAttempts) break;
        const backoff = backoffDelayMs(attempt - 1, this.config.backoff, this.deps.jitter);
        const retryAfter = pe.opts.retryAfterMs ?? null;
        if (pe.kind === 'rate_limited' && retryAfter !== null) this.limiter.pauseUntil(clock.nowEpochMs() + retryAfter);
        const delay = retryAfter !== null ? Math.max(retryAfter, 0) : backoff;
        logger.log('warn', 'provider.retry', { kind: pe.kind, attempt, delayMs: delay, workId, status: pe.opts.status ?? null });
        this.stats.retries += 1;
        await clock.sleep(delay, signal).catch(() => { throw ABORT(); });
        continue;
      }
      permit.release({ inputTokens: resp.usage.inputTokens });
      this.stats.httpMs.push(resp.httpMs);
      const artifact = await this.persistRaw(resp.raw, scope);
      const v = validate(resp);
      const cost = costFor(resp.usage);
      const finished = {
        ...base, phase: 'finished' as const, modelReturned: resp.modelReturned, durationMs: clock.nowEpochMs() - startedAt,
        inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens, estimatedCostUsd: cost.usd, priceVersion: cost.priceVersion,
      };
      if (!v.ok) {
        await ledger.finished({ ...finished, outcome: 'invalid' }, cost.basis);
        this.stats.invalidOutputs += 1;
        lastError = new ProviderError('invalid_output', v.reason);
        logger.log('warn', 'provider.invalid_output', { workId, attempt, reason: v.reason });
        continue;
      }
      await ledger.finished({ ...finished, outcome: 'success' }, cost.basis);
      const entry: CacheEntry = {
        schema: 'response-cache-entry.v1', namespace: ns, key, kind,
        modelRequested: provider.model, modelReturned: resp.modelReturned, policyVersion, instructionsVersion: provider.instructionsVersion,
        originalSource: provider.source, probabilities: v.probabilities, score: v.score, confidence: v.confidence, responseArtifact: artifact!,
        normalization: { rawSum: v.rawSum, sumError: v.sumError, appliedBy: 'engine' }, callId, createdAtEpochMs: clock.nowEpochMs(),
      };
      const stored = await this.cache.putIfAbsent(entry);
      const winner = this.acceptable(stored.entry) ? stored.entry : entry;
      if (winner !== stored.entry) logger.log('warn', 'cache.write_conflict_provenance', { key, existing: stored.entry.originalSource });
      return {
        entry: winner, callId,
        usage: {
          callId, inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens, estimatedCostUsd: cost.usd,
          priceVersion: cost.priceVersion, queueMs, httpMs: resp.httpMs, attemptCount: attempt,
        },
      };
    }
    throw lastError ?? new ProviderError('transient', 'provider attempts exhausted');
  }

  /** Raw bytes are kept locally (content-addressed) and, when a scope is given, uploaded as a private artifact. */
  private async persistRaw(raw: Uint8Array, scope?: Scope): Promise<ArtifactRef | null> {
    const sha = sha256Hex(raw);
    await this.deps.store.putIfAbsent(`raw/${sha}`, raw);
    if (!scope) return null;
    return this.deps.client.putArtifact({ kind: 'model_response', mediaType: 'application/json', bytes: raw, scope, commandId: artifactCommandId('model_response', sha, scope) });
  }
}

function zeroUsage(callId: Id | null): Usage {
  return { callId, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, priceVersion: null, queueMs: 0, httpMs: 0, attemptCount: 0 };
}
