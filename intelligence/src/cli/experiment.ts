/**
 * Mock paired experiment: pass price 1500 -> 2500 cents (the only change), 3 seeds by default.
 *
 *   npm run experiment:mock -- [--seeds s1,s2,s3] [--analysis paired_descriptive|paired_t] [--out .data/exp]
 *
 * Runtime "fixture" (default) is the scripted fake runtime: ORCHESTRATION-ONLY, metrics are fixtures.
 * Runtime "spacetime" (--runtime spacetime) uses Engine's adapter and the real Engine path; it needs
 * BEHAVIOR_RUNTIME_ADAPTER, SPACETIME_URI, SPACETIME_DATABASE and operator/coordinator/worker tokens,
 * and never falls back to the fixture. The printed differences are B - A with whatever sign results.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ExperimentReport, ExperimentSpec, RuntimeClient } from '../../contract/behavior-v1.ts';
import { InflightCoalescer, ResponseCache } from '../cache/response-cache.ts';
import { readExperimentState } from '../experiments/coordinator.ts';
import { passPriceExperiment } from '../experiments/preflight.ts';
import { TINY_CROWD } from '../fixtures/crowds.ts';
import { harborLightsFixturePark, parkArtifact } from '../fixtures/harbor-lights.ts';
import { createOrchestrationWorld, experimentConfig } from '../fixtures/orchestration.ts';
import { MockProvider } from '../providers/mock.ts';
import { InstantClock, jsonLineLogger, systemClock, systemJitter } from '../runtime/clock.ts';
import { uuidIds } from '../runtime/commands.ts';
import { loadRuntimeClient } from '../runtime/loader.ts';
import { MemoryStore } from '../runtime/store.ts';
import { createCoordinator, createWorker } from '../worker/factory.ts';

const { values } = parseArgs({
  options: {
    seeds: { type: 'string', default: 's1,s2,s3' },
    analysis: { type: 'string', default: 'paired_descriptive' },
    runtime: { type: 'string', default: 'fixture' },
    out: { type: 'string' },
    'timeout-ms': { type: 'string', default: '1800000' },
  },
});
const seeds = values.seeds!.split(',').map((s) => s.trim()).filter(Boolean);
const analysis = values.analysis === 'paired_t' ? 'paired_t' : 'paired_descriptive';
const { seed: _seed, ...crowd } = TINY_CROWD;

function printSummary(report: ExperimentReport, runtime: string) {
  const fmt = (x: number | null) => (x === null ? 'unavailable' : String(Math.round(x * 1000) / 1000));
  console.log(JSON.stringify({
    runtime, label: runtime === 'fixture' ? 'ORCHESTRATION-ONLY fixture metrics (not a park simulation)' : 'Engine run, mock policy',
    intervention: report.spec.interventionLabel, status: report.status, requestedPairs: report.requestedPairs, completePairs: report.completePairs,
    exploratory: report.exploratory,
    pairs: report.pairs.map((p) => ({ seed: p.seed, status: p.status, reasons: p.reasons })),
    differencesBminusA: Object.fromEntries(report.summaries.map((s) => [s.metricId, {
      n: s.pairCount, differences: s.differences, mean: fmt(s.mean), min: fmt(s.min), max: fmt(s.max), sampleSd: fmt(s.sampleSd),
      interval: s.interval ? `${fmt(s.interval.lower)} .. ${fmt(s.interval.upper)} (paired t, 95%)` : null,
    }])),
    limitations: report.limitations,
  }, null, 2));
}

async function fixture() {
  const w = createOrchestrationWorld({ clock: new InstantClock(), seeds, spec: (s) => ({ ...s, analysis }) });
  await w.create();
  await w.runCoordinator(w.makeCoordinator());
  const st = await readExperimentState(w.coordinatorStore, w.spec.experimentId);
  if (!st?.artifacts.report) throw new Error('experiment did not produce a report');
  const get = (ref: { artifactId: string }) => w.server.artifacts.get(ref.artifactId)!.bytes;
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    for (const [name, ref] of Object.entries(st.artifacts)) if (ref) writeFileSync(join(values.out, `${name}.json`), get(ref));
  }
  printSummary(JSON.parse(new TextDecoder().decode(get(st.artifacts.report))) as ExperimentReport, 'fixture');
}

async function spacetime() {
  const env = process.env;
  const missing = ['BEHAVIOR_RUNTIME_ADAPTER', 'SPACETIME_URI', 'SPACETIME_DATABASE', 'BEHAVIOR_OPERATOR_TOKEN', 'BEHAVIOR_COORDINATOR_TOKEN', 'BEHAVIOR_WORKER_TOKEN'].filter((k) => !env[k]);
  if (missing.length) { console.log(JSON.stringify({ status: 'NOT RUN', reason: `missing ${missing.join(', ')}` })); process.exit(2); }
  const secrets = [env.BEHAVIOR_OPERATOR_TOKEN!, env.BEHAVIOR_COORDINATOR_TOKEN!, env.BEHAVIOR_WORKER_TOKEN!];
  const logger = jsonLineLogger(undefined, systemClock, secrets);
  const client = (token: string): Promise<RuntimeClient> => loadRuntimeClient({ mode: 'spacetime', adapterModulePath: env.BEHAVIOR_RUNTIME_ADAPTER!, config: { uri: env.SPACETIME_URI!, database: env.SPACETIME_DATABASE!, token } });
  const [operator, coordinatorClient, workerClient] = await Promise.all([client(secrets[0]!), client(secrets[1]!), client(secrets[2]!)]);
  try {
    const art = parkArtifact(harborLightsFixturePark());
    const park = await operator.putArtifact({ kind: 'park', mediaType: 'application/json', bytes: art.bytes, scope: { runId: null, experimentId: null }, commandId: `artifact:park:${art.ref.sha256}` });
    await operator.command('registerPark', { artifact: park }, `register:${park.sha256}`);
    const store = new MemoryStore();
    const cache = new ResponseCache(store);
    const worker = createWorker({ client: workerClient, provider: new MockProvider(), store, clock: systemClock, jitter: systemJitter, ids: uuidIds, logger, cache, coalescer: new InflightCoalescer() });
    const coordinator = createCoordinator({ client: coordinatorClient, provider: new MockProvider(), store: new MemoryStore(), clock: systemClock, jitter: systemJitter, ids: uuidIds, logger, coordinator: { runtime: 'engine', cache, ledger: worker.ledger } });
    const experimentId = `exp-${uuidIds.next('x').slice(-12)}`;
    const spec: ExperimentSpec = { ...passPriceExperiment({ experimentId, park, crowd, seeds, config: experimentConfig({ horizonMs: 3_600_000 }), atMs: 60_000 }), analysis };
    const created = await operator.command('createExperiment', { spec }, `create:${experimentId}`);
    if (!created.ok) throw new Error(`createExperiment ${created.error.code}: ${created.error.message}`);
    await worker.worker.start();
    await coordinator.worker.start();
    const deadline = systemClock.nowEpochMs() + Number(values['timeout-ms']);
    let report = await operator.query('getExperiment', { experimentId });
    while (report.status === 'running' && systemClock.nowEpochMs() < deadline) { await systemClock.sleep(2000); report = await operator.query('getExperiment', { experimentId }); }
    await coordinator.worker.shutdown();
    await worker.worker.shutdown();
    if (values.out) { mkdirSync(values.out, { recursive: true }); writeFileSync(join(values.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); }
    printSummary(report, 'spacetime');
  } finally {
    await Promise.all([operator.close(), coordinatorClient.close(), workerClient.close()]);
  }
}

if (values.runtime === 'spacetime') await spacetime();
else if (values.runtime === 'fixture') await fixture();
else { console.error(`unknown --runtime ${values.runtime}`); process.exit(1); }
