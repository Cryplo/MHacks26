/**
 * Real-Engine gates for B-18 (A/A) and B-21 (mock A/B). They need Engine's built Node adapter and a
 * running SpacetimeDB module with operator, coordinator and worker identities:
 *
 *   BEHAVIOR_RUNTIME_ADAPTER=../engine/client/dist/node.js SPACETIME_URI=ws://127.0.0.1:3000 \
 *   SPACETIME_DATABASE=behavior BEHAVIOR_OPERATOR_TOKEN=... BEHAVIOR_COORDINATOR_TOKEN=... \
 *   BEHAVIOR_WORKER_TOKEN=... npm run test:experiments
 *
 * Without them these tests are reported as skipped with a NOT RUN title; they never fall back to the fake.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExperimentReport, ExperimentSpec, RuntimeClient } from '../../contract/behavior-v1.ts';
import { InflightCoalescer, ResponseCache } from '../../src/cache/response-cache.ts';
import { passPriceExperiment } from '../../src/experiments/preflight.ts';
import { validateReportShape } from '../../src/experiments/report.ts';
import { TINY_CROWD } from '../../src/fixtures/crowds.ts';
import { harborLightsFixturePark, parkArtifact } from '../../src/fixtures/harbor-lights.ts';
import { experimentConfig } from '../../src/fixtures/orchestration.ts';
import { MockProvider } from '../../src/providers/mock.ts';
import { MemoryLogger, systemClock, systemJitter } from '../../src/runtime/clock.ts';
import { uuidIds } from '../../src/runtime/commands.ts';
import { RuntimeLoadError, loadRuntimeClient } from '../../src/runtime/loader.ts';
import { MemoryStore } from '../../src/runtime/store.ts';
import { createCoordinator, createWorker } from '../../src/worker/factory.ts';

const env = process.env;
const adapter = env.BEHAVIOR_RUNTIME_ADAPTER ? resolve(env.BEHAVIOR_RUNTIME_ADAPTER) : null;
const ready = !!(adapter && existsSync(adapter) && env.SPACETIME_URI && env.SPACETIME_DATABASE && env.BEHAVIOR_OPERATOR_TOKEN && env.BEHAVIOR_COORDINATOR_TOKEN && env.BEHAVIOR_WORKER_TOKEN);
const why = adapter ? (existsSync(adapter) ? 'Engine identities/URI not configured' : `adapter missing at ${adapter}`) : 'BEHAVIOR_RUNTIME_ADAPTER not set';

describe('real-Engine loader never falls back', () => {
  it('spacetime mode with a missing adapter is an explicit error', async () => {
    await expect(loadRuntimeClient({ mode: 'spacetime', adapterModulePath: '/nonexistent/engine/client/dist/node.js', config: { uri: 'ws://127.0.0.1:1', database: 'x', token: null } }))
      .rejects.toBeInstanceOf(RuntimeLoadError);
  });
});

async function client(token: string): Promise<RuntimeClient> {
  return loadRuntimeClient({ mode: 'spacetime', adapterModulePath: adapter!, config: { uri: env.SPACETIME_URI!, database: env.SPACETIME_DATABASE!, token } });
}

async function runOnEngine(mutate: (s: ExperimentSpec) => ExperimentSpec, timeoutMs: number): Promise<ExperimentReport> {
  const [operator, coordinatorClient, workerClient] = await Promise.all([client(env.BEHAVIOR_OPERATOR_TOKEN!), client(env.BEHAVIOR_COORDINATOR_TOKEN!), client(env.BEHAVIOR_WORKER_TOKEN!)]);
  const logger = new MemoryLogger();
  try {
    const bundle = harborLightsFixturePark();
    const art = parkArtifact(bundle);
    const park = await operator.putArtifact({ kind: 'park', mediaType: 'application/json', bytes: art.bytes, scope: { runId: null, experimentId: null }, commandId: `artifact:park:${art.ref.sha256}` });
    await operator.command('registerPark', { artifact: park }, `register:${park.sha256}`);
    const workerStore = new MemoryStore();
    const cache = new ResponseCache(workerStore);
    const worker = createWorker({ client: workerClient, provider: new MockProvider(), store: workerStore, clock: systemClock, jitter: systemJitter, ids: uuidIds, logger, cache, coalescer: new InflightCoalescer() });
    const coordinator = createCoordinator({
      client: coordinatorClient, provider: new MockProvider(), store: new MemoryStore(), clock: systemClock, jitter: systemJitter, ids: uuidIds, logger,
      coordinator: { runtime: 'engine', cache, ledger: worker.ledger },
    });
    const { seed: _s, ...crowd } = TINY_CROWD;
    const id = `exp-it-${uuidIds.next('x').slice(-8)}`;
    const spec = mutate(passPriceExperiment({ experimentId: id, park, crowd, seeds: ['s1', 's2', 's3'], config: experimentConfig({ horizonMs: 600_000 }), atMs: 60_000 }));
    const created = await operator.command('createExperiment', { spec }, `create:${id}`);
    if (!created.ok) throw new Error(`createExperiment ${created.error.code}: ${created.error.message}`);
    await worker.worker.start();
    await coordinator.worker.start();
    const deadline = systemClock.nowEpochMs() + timeoutMs;
    let report: ExperimentReport | null = null;
    while (systemClock.nowEpochMs() < deadline) {
      report = await operator.query('getExperiment', { experimentId: id });
      if (report.status !== 'running') break;
      await systemClock.sleep(2000);
    }
    await coordinator.worker.shutdown();
    await worker.worker.shutdown();
    if (!report || report.status === 'running') throw new Error('experiment did not finish within the test budget');
    return report;
  } finally {
    await Promise.all([operator.close(), coordinatorClient.close(), workerClient.close()]);
  }
}

describe.skipIf(!ready)(`B-18/B-21 real Engine (NOT RUN when skipped: ${why})`, () => {
  it('B-21 mock A/B pass price 1500 -> 2500 completes with exact report shape', async () => {
    const r = await runOnEngine((s) => s, 600_000);
    expect(validateReportShape(r)).toEqual([]);
    expect(r.pairs).toHaveLength(3);
    expect(r.limitations.join(' ')).toMatch(/MOCK experiment/);
    expect(r.limitations.join(' ')).not.toMatch(/ORCHESTRATION-ONLY/);
  }, 700_000);

  it('B-18 A/A on real Engine yields zero deltas from frozen responses', async () => {
    const r = await runOnEngine((s) => ({ ...s, variant: structuredClone(s.baseline), changedLever: 'none', interventionLabel: 'A/A' }), 600_000);
    for (const p of r.pairs) if (p.status === 'complete') for (const v of Object.values(p.deltas)) expect(v).toBe(0);
  }, 700_000);
});
