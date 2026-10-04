/**
 * Intelligence worker / coordinator process.
 *
 *   npm run dev:worker                       # fixture runtime + mock provider, labeled demo work, then exit
 *   BEHAVIOR_RUNTIME_MODE=spacetime BEHAVIOR_RUNTIME_ADAPTER=../engine/client/dist/node.js \
 *     BEHAVIOR_RUNTIME_URI=ws://127.0.0.1:3000 BEHAVIOR_RUNTIME_DATABASE=behavior-engine \
 *     BEHAVIOR_ROLE=worker BEHAVIOR_WORKER_TOKEN=...            (or BEHAVIOR_ROLE=coordinator BEHAVIOR_COORDINATOR_TOKEN=...)
 *     [BEHAVIOR_PROVIDER=mock|jev JEV_API_KEY=...] npm run dev:worker
 *
 * All variables are listed in .env.example and docs/HANDOFF.md.
 *
 * The worker only answers frozen requests with probability vectors and text; it never samples or
 * chooses actions and never calls world-mutation or scenario commands. Spacetime mode never falls
 * back to the fixture runtime; a missing adapter is a startup error.
 */
import { resolve } from 'node:path';
import type { ProductRequest, RuntimeClient, WorkKind } from '../../contract/behavior-v1.ts';
import { InflightCoalescer, ResponseCache } from '../cache/response-cache.ts';
import { DEFAULT_CROWD_300 } from '../fixtures/crowds.ts';
import { harborLightsFixturePark, parkArtifact } from '../fixtures/harbor-lights.ts';
import { fixtureDecisionRequest } from '../fixtures/orchestration.ts';
import { FetchHttp } from '../providers/http.ts';
import { DEFAULT_JEV_MODEL, JevProvider } from '../providers/jev.ts';
import { BatchingJevProvider, DEFAULT_BATCH } from '../providers/jev-batch.ts';
import { LayaProvider } from '../providers/laya.ts';
import { MockProvider } from '../providers/mock.ts';
import type { BehaviorProvider } from '../providers/types.ts';
import { jsonLineLogger, systemClock, systemJitter } from '../runtime/clock.ts';
import { uuidIds } from '../runtime/commands.ts';
import { FakeRuntimeServer } from '../runtime/fake-runtime.ts';
import { loadRuntimeClient } from '../runtime/loader.ts';
import { FileStore, MemoryStore } from '../runtime/store.ts';
import { createCoordinator, createWorker } from '../worker/factory.ts';
import { CONSERVATIVE_LIMITS, ProviderLimiter } from '../worker/limiter.ts';

const env = process.env;
const mode = env.BEHAVIOR_RUNTIME_MODE ?? 'fixture';
const role = env.BEHAVIOR_ROLE ?? 'worker';
const token = role === 'coordinator' ? env.BEHAVIOR_COORDINATOR_TOKEN : env.BEHAVIOR_WORKER_TOKEN;
const secrets = [env.JEV_API_KEY, env.BEHAVIOR_WORKER_TOKEN, env.BEHAVIOR_COORDINATOR_TOKEN].filter((s): s is string => !!s);
const num = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);
const logger = jsonLineLogger(undefined, systemClock, secrets);

const usesLaya = () => env.BEHAVIOR_PROVIDER === 'laya';
const usesJev = () => env.BEHAVIOR_PROVIDER === 'jev';
/** Batched Jev (default): many requests per HTTP call. JEV_BATCH_SIZE=1 restores one call per request. */
const batchSize = () => (usesJev() ? Math.max(1, num('JEV_BATCH_SIZE', DEFAULT_BATCH.maxItems)) : 1);
const batching = () => batchSize() > 1;

function provider(): BehaviorProvider {
  if ((env.BEHAVIOR_PROVIDER ?? 'mock') === 'mock') return new MockProvider();
  if (usesLaya()) return new LayaProvider(env.LAYA_ENDPOINT, num('LAYA_BATCH_SIZE', 8));
  if (env.BEHAVIOR_PROVIDER !== 'jev') throw new Error(`BEHAVIOR_PROVIDER must be mock, jev or laya, not ${env.BEHAVIOR_PROVIDER}`);
  if (!env.JEV_API_KEY) throw new Error('BEHAVIOR_PROVIDER=jev requires JEV_API_KEY');
  const jev = new JevProvider({
    endpoint: env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone', apiKey: env.JEV_API_KEY, model: env.JEV_MODEL ?? DEFAULT_JEV_MODEL,
    timeoutMs: num('JEV_HTTP_TIMEOUT_MS', batching() ? 20_000 : 10_000), maxResponseBytes: num('JEV_MAX_RESPONSE_BYTES', 1024 * 1024), retryAfterCapMs: 60_000,
  }, new FetchHttp(systemClock), systemClock);
  if (!batching()) return jev;
  return new BatchingJevProvider(jev, {
    maxItems: batchSize(),
    maxInputTokens: num('JEV_BATCH_MAX_INPUT_TOKENS', DEFAULT_BATCH.maxInputTokens),
    lingerMs: num('JEV_BATCH_LINGER_MS', DEFAULT_BATCH.lingerMs),
    // With batching, these bound actual HTTP calls rather than logical requests.
    maxInFlight: num('JEV_MAX_CONCURRENCY', DEFAULT_BATCH.maxInFlight),
    minIntervalMs: Math.round(1000 / num('JEV_REQUESTS_PER_SECOND', 1000 / DEFAULT_BATCH.minIntervalMs)),
  }, systemClock);
}

function limiter() {
  const maxCalls = env.BEHAVIOR_MAX_PROVIDER_CALLS ? Number(env.BEHAVIOR_MAX_PROVIDER_CALLS) : undefined;
  // Batched Jev: the batching provider spaces real HTTP calls; this limiter admits logical
  // requests so a whole barrier's decisions can wait in one batch queue.
  const logical = usesLaya()
    ? { requestsPerSecond: 400, requestBurst: 128, inputTokensPerMinute: 4_000_000, tokenBurst: 200_000, maxConcurrency: 32, reservedForBehavior: 8, maxQueue: 2048 }
    : batching()
    ? { requestsPerSecond: 400, requestBurst: 256, inputTokensPerMinute: num('JEV_INPUT_TOKENS_PER_MINUTE', 4_000_000), tokenBurst: 400_000, maxConcurrency: 4 * batchSize() * num('JEV_MAX_CONCURRENCY', DEFAULT_BATCH.maxInFlight), reservedForBehavior: batchSize(), maxQueue: 2048 }
    : {
      requestsPerSecond: num('JEV_REQUESTS_PER_SECOND', CONSERVATIVE_LIMITS.requestsPerSecond),
      inputTokensPerMinute: num('JEV_INPUT_TOKENS_PER_MINUTE', CONSERVATIVE_LIMITS.inputTokensPerMinute),
      maxConcurrency: num('JEV_MAX_CONCURRENCY', CONSERVATIVE_LIMITS.maxConcurrency),
      maxQueue: num('WORKER_QUEUE_LIMIT', CONSERVATIVE_LIMITS.maxQueue),
    };
  return new ProviderLimiter({
    ...CONSERVATIVE_LIMITS,
    ...logical,
    budgets: maxCalls ? { behavior: { maxCalls }, measurement: { maxCalls }, text: { maxCalls } } : undefined,
  }, systemClock);
}

/** In-flight work items per class; batching needs enough concurrent items to fill batches. */
function capacity() {
  if (usesLaya()) return { behavior: 24, measurement: 8, text: 2, experiment: 0 };
  const behavior = num('WORKER_BEHAVIOR_CAPACITY', batching() ? 4 * batchSize() * num('JEV_MAX_CONCURRENCY', DEFAULT_BATCH.maxInFlight) / 2 : 8);
  return { behavior, measurement: num('WORKER_MEASUREMENT_CAPACITY', batching() ? 2 * batchSize() : 2), text: 2, experiment: 0 };
}

function build(client: RuntimeClient, store: FileStore | MemoryStore) {
  const p = provider();
  const common = { client, provider: p, store, clock: systemClock, jitter: systemJitter, ids: uuidIds, logger, limiter: limiter() };
  if (role === 'coordinator') return createCoordinator({ ...common, coordinator: { runtime: 'engine' } });
  return createWorker({
    ...common, cache: new ResponseCache(store), coalescer: new InflightCoalescer(),
    options: { leaseMs: num('WORKER_LEASE_MS', 30_000), capacity: capacity() },
    inference: (batching() || usesLaya()) ? { backgroundTelemetry: true } : undefined,
  });
}

async function fixtureDemo() {
  const server = new FakeRuntimeServer({ clock: systemClock, identities: { worker: ['worker'], operator: ['operator'] } });
  const operator = server.client('operator');
  const art = parkArtifact(harborLightsFixturePark());
  const park = server.storeArtifact('operator', 'park', 'application/json', art.bytes, { runId: null, experimentId: null });
  const store = new MemoryStore();
  const built = createWorker({ client: server.client('worker'), provider: new MockProvider(), store, clock: systemClock, jitter: systemJitter, ids: uuidIds, logger, cache: new ResponseCache(store), coalescer: new InflightCoalescer() });
  const ids: Record<string, string> = {};
  const product = async (name: string, request: ProductRequest) => {
    const r = await operator.command('requestProductWork', { request }, `demo:${name}`);
    if (!r.ok) throw new Error(`${name}: ${r.error.message}`);
    ids[name] = (r.result as { workId: string }).workId;
  };
  await product('population', { kind: 'population', crowd: DEFAULT_CROWD_300, park });
  await product('parse_crowd', { kind: 'parse_crowd', text: 'about 200 guests, mostly families with young kids and some teens', current: DEFAULT_CROWD_300 });
  ids.decision = server.enqueueWork('decision', fixtureDecisionRequest(), { runId: 'fixture-run', experimentId: null });
  await built.worker.start();
  const deadline = systemClock.nowEpochMs() + 30_000;
  const pending = () => Object.values(ids).filter((id) => !['ready', 'failed', 'applied'].includes(server.work.get(id)!.status));
  while (pending().length && systemClock.nowEpochMs() < deadline) await systemClock.sleep(100);
  const shutdown = await built.worker.shutdown();
  const summary = Object.fromEntries(Object.entries(ids).map(([k, id]) => {
    const w = server.work.get(id)!;
    const r = w.result as Record<string, unknown> | null;
    const brief = k === 'population' ? { guestCount: r?.guestCount, groupCount: r?.groupCount, artifactSha256: (r?.artifact as { sha256?: string } | undefined)?.sha256 }
      : k === 'decision' ? { source: r?.source, probabilities: r?.probabilities }
        : { guestCount: (r?.proposal as { guestCount?: number } | undefined)?.guestCount, assumptions: r?.assumptions };
    return [k, { status: w.status, error: w.error?.message ?? null, ...brief }];
  }));
  console.log(JSON.stringify({ runtime: 'fixture (orchestration-only fake runtime, mock provider)', work: summary, status: built.worker.status(), shutdown }, null, 2));
  if (pending().length) process.exitCode = 1;
}

async function serve() {
  if (role !== 'worker' && role !== 'coordinator') throw new Error(`BEHAVIOR_ROLE must be worker or coordinator, not ${role}`);
  if (!env.BEHAVIOR_RUNTIME_ADAPTER) throw new Error('BEHAVIOR_RUNTIME_ADAPTER is required in spacetime mode');
  if (!env.BEHAVIOR_RUNTIME_URI || !env.BEHAVIOR_RUNTIME_DATABASE) throw new Error('BEHAVIOR_RUNTIME_URI and BEHAVIOR_RUNTIME_DATABASE are required in spacetime mode');
  const client = await loadRuntimeClient({ mode: 'spacetime', adapterModulePath: env.BEHAVIOR_RUNTIME_ADAPTER, config: { uri: env.BEHAVIOR_RUNTIME_URI, database: env.BEHAVIOR_RUNTIME_DATABASE, token: token ?? null } });
  const store = new FileStore(resolve(env.INTELLIGENCE_DATA_DIR ?? '.data', role));
  const built = build(client, store);
  const kinds: WorkKind[] = role === 'coordinator' ? ['experiment'] : ['decision', 'rating', 'population', 'parse_crowd', 'parse_scenario', 'thought', 'report'];
  logger.log('info', 'process.start', { role, mode, kinds, provider: env.BEHAVIOR_PROVIDER ?? 'mock', stateDir: store.root });
  await built.worker.start();
  const statusEvery = Number(env.BEHAVIOR_STATUS_EVERY_MS ?? 30_000);
  const timer = setInterval(() => logger.log('info', 'process.status', { status: built.worker.status() }), statusEvery);
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    logger.log('info', 'process.stopping', { signal });
    const report = await built.worker.shutdown();
    logger.log('info', 'process.stopped', { report });
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

try {
  if (mode === 'fixture') await fixtureDemo();
  else if (mode === 'spacetime') await serve();
  else throw new Error(`BEHAVIOR_RUNTIME_MODE must be fixture or spacetime, not ${mode}`);
} catch (e) {
  logger.log('error', 'process.startup_failed', { error: (e as Error).message, name: (e as Error).name });
  process.exit(1);
}
