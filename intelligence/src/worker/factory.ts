import type { RuntimeClient, Scope, WorkKind } from '../../contract/behavior-v1.ts';
import type { ProseProvider } from '../population/prose.ts';
import type { ReportProseProvider } from '../reports/narrative.ts';
import { parseCrowdHandler, parseScenarioHandler, reportHandler, thoughtHandler } from '../text/handlers.ts';
import type { NarrationProvider } from '../text/narration.ts';
import type { BehaviorProvider } from '../providers/types.ts';
import type { Clock, Jitter, Logger } from '../runtime/clock.ts';
import type { IdSource } from '../runtime/commands.ts';
import type { DurableStore } from '../runtime/store.ts';
import type { Handlers } from './handlers.ts';
import { decisionHandler, populationHandler, ratingHandler } from './handlers.ts';
import type { InferenceConfig } from './inference.ts';
import { InferenceService } from './inference.ts';
import { Journal } from './journal.ts';
import type { CoalescerPort, LimiterPort, ResponseCachePort } from './ports.ts';
import { UsageLedger } from './usage.ts';
import type { WorkerOptions } from './worker.ts';
import { Worker } from './worker.ts';

/** Experiment-scoped namespace (frozen per experiment) or per-run namespace for exploratory runs. */
export function defaultNamespace(scope: Scope): string {
  if (scope.experimentId) return `exp/${scope.experimentId}`;
  if (scope.runId) return `run/${scope.runId}`;
  return 'common';
}

export type CreateWorkerInput = {
  client: RuntimeClient; provider: BehaviorProvider; store: DurableStore;
  clock: Clock; jitter: Jitter; ids: IdSource; logger: Logger;
  cache?: ResponseCachePort; coalescer?: CoalescerPort; limiter?: LimiterPort;
  prose?: ProseProvider | null; narration?: NarrationProvider | null; reportProse?: ReportProseProvider | null;
  extraHandlers?: Handlers;
  options?: Partial<WorkerOptions>; inference?: Partial<InferenceConfig>;
};

export const DEFAULT_WORKER_KINDS: WorkKind[] = ['decision', 'rating', 'population', 'parse_crowd', 'parse_scenario', 'thought', 'report'];

export function createWorker(input: CreateWorkerInput) {
  const ops = { clock: input.clock, jitter: input.jitter, logger: input.logger };
  const ledger = new UsageLedger(input.store, input.client, ops);
  const journal = new Journal(input.store);
  const inference = new InferenceService({
    provider: input.provider, client: input.client, ledger, store: input.store, clock: input.clock, jitter: input.jitter,
    ids: input.ids, logger: input.logger, cache: input.cache, coalescer: input.coalescer, limiter: input.limiter,
  }, {
    maxAttempts: 4, backoff: { baseMs: 500, maxMs: 30_000 }, namespace: defaultNamespace,
    billingOwnerRunId: (s) => s.runId, ...input.inference,
  });
  const handlers: Handlers = {
    decision: decisionHandler, rating: ratingHandler, population: populationHandler({ prose: input.prose ?? null }),
    parse_crowd: parseCrowdHandler(), parse_scenario: parseScenarioHandler,
    thought: thoughtHandler({ store: input.store, provider: input.narration ?? null }),
    report: reportHandler({ provider: input.reportProse ?? null }),
    ...input.extraHandlers,
  };
  const options: WorkerOptions = {
    kinds: DEFAULT_WORKER_KINDS.filter((k) => handlers[k]), leaseMs: 30_000, renewEveryMs: 10_000, reconcileEveryMs: 2_000,
    capacity: { behavior: 8, measurement: 2, text: 2, experiment: 0 }, shutdownDeadlineMs: 10_000, workerNonce: input.ids.next('nonce'),
    ...input.options,
  };
  const worker = new Worker({ client: input.client, inference, handlers, journal, ledger, clock: input.clock, jitter: input.jitter, ids: input.ids, logger: input.logger, limiter: input.limiter }, options);
  return { worker, inference, ledger, journal, handlers };
}
