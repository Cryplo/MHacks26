/**
 * ORCHESTRATION-ONLY experiment fixture: the scripted fake runtime plus a real worker and a real
 * coordinator in one process. Run scripts and metric snapshots are FIXTURES (pass buyers depend only
 * on the scripted price); nothing here simulates a park. Used by tests and `npm run experiment:mock`
 * to exercise durability, fencing, statistics and reporting without Engine.
 */
import { readFileSync } from 'node:fs';
import type {
  DecisionRequest, ExperimentSpec, MetricId, MetricSnapshot, MetricValue, PopulationManifest, RatingRequest, RunConfig, RunManifest, Scenario,
} from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';
import { METRIC_IDS, observationHash, optionsHash } from '../core/validate.ts';
import { InflightCoalescer, ResponseCache } from '../cache/response-cache.ts';
import type { CoordinatorDeps, CoordinatorOptions } from '../experiments/coordinator.ts';
import { passPriceExperiment } from '../experiments/preflight.ts';
import { RUBRICS, summarizeTerminalRatings } from '../measurements/rating.ts';
import { MockProvider } from '../providers/mock.ts';
import type { BehaviorProvider } from '../providers/types.ts';
import type { Clock, Logger } from '../runtime/clock.ts';
import { MemoryLogger, SequenceJitter } from '../runtime/clock.ts';
import { CounterIds } from '../runtime/commands.ts';
import type { RunScript } from '../runtime/fake-runtime.ts';
import { FakeRuntimeServer } from '../runtime/fake-runtime.ts';
import { MemoryStore } from '../runtime/store.ts';
import { createCoordinator, createWorker } from '../worker/factory.ts';
import { TINY_CROWD } from './crowds.ts';
import { harborLightsFixturePark, parkArtifact } from './harbor-lights.ts';

export const FIXTURE_STEP_MS = 5000;

export function fixtureDecisionRequest(): DecisionRequest {
  const c = JSON.parse(readFileSync(new URL('../../fixtures/conformance-fixtures.json', import.meta.url), 'utf8')) as { decisionRequest: DecisionRequest };
  return c.decisionRequest;
}

export function experimentConfig(over: Partial<RunConfig> = {}): RunConfig {
  return {
    mode: 'mock', horizonMs: 60_000, logicalStepMs: 5000, movementStepMs: 250, requestedSpeed: 1, temperature: 1,
    earlyDepartureThresholdMs: 1_800_000, ratingEveryMs: null, visualFrameEveryMs: 5000, checkpointEveryMs: 60_000,
    fallback: 'forbidden', liveTimeoutMs: 10_000,
    features: { routeChoice: false, bumpReactions: false, splitGroups: false, speechBubbles: false, discountMessages: false },
    versions: {
      engine: 'fixture', observation: 'observation.v1', options: 'options.v1', random: 'behavior-rng-v1', persona: 'population-v1',
      prompt: 'jev-instructions-v1', requestedModel: 'mock-policy-v1', meter: 'meter.v1', loading: 'loading.v1', metrics: 'metrics-v1',
      rubric: 'satisfaction-rubric-v1', replay: 'replay.v1', sourceCommit: 'fixture',
    },
    ...over,
  };
}

const passPriceAt = (s: Scenario, atMs: number, fallback: number) => {
  let p = fallback;
  for (const e of [...s.events].sort((a, b) => a.atMs - b.atMs || a.order - b.order)) if (e.change.kind === 'pass_price' && e.atMs <= atMs) p = e.change.unitPriceCents;
  return p;
};

export type ScriptOptions = {
  /** Steps with a decision barrier. */
  barrierSteps?: number[];
  /** Make the barrier decisions of matching runs invalid (worker fails them, so the run fails). */
  failDecisions?: (m: RunManifest) => boolean;
  /** Make one terminal rating invalid for matching runs (missing rating coverage). */
  breakRating?: (m: RunManifest) => boolean;
  /** Decision request IDs independent of the run (frozen-response A/A). */
  runIndependentIds?: boolean;
};

/** Scripted (NOT simulated) run: barriers from the conformance decision, terminal ratings, fixture metrics. */
export function scriptFor(getPopulation: (m: RunManifest) => PopulationManifest, opts: ScriptOptions = {}) {
  const template = fixtureDecisionRequest();
  return (m: RunManifest): RunScript => {
    const steps = m.config.horizonMs / FIXTURE_STEP_MS;
    const admitted = getPopulation(m).personas.length;
    const barriers: RunScript['barriers'] = {};
    for (const s of opts.barrierSteps ?? [2, 7]) {
      if (s >= steps) continue;
      barriers[s] = (runId) => {
        const r: DecisionRequest = structuredClone(template);
        r.runId = runId;
        r.requestId = opts.runIndependentIds ? `decision:g001:s${s}` : `decision:${runId}:s${s}`;
        const price = passPriceAt(m.scenario, s * FIXTURE_STEP_MS, 1500);
        r.observation.facts.push({ id: `price-s${s}`, kind: 'price', placeId: null, source: 'app', observedAtMs: s * FIXTURE_STEP_MS, contentVersion: 'price:1', text: `Pass ${price} cents`, waitLowerMs: null, waitUpperMs: null, priceCents: price });
        r.observationHash = observationHash(r);
        r.optionsHash = optionsHash(r);
        if (opts.failDecisions?.(m)) r.observationHash = '0'.repeat(64);
        return [r];
      };
    }
    const ratingAgents = ['a001', 'a002', 'a003'];
    return {
      totalSteps: steps, barriers,
      terminalRatings: (runId) => ratingAgents.map((agentId, i): RatingRequest => {
        const obs = structuredClone(template.observation);
        obs.atMs = m.config.horizonMs;
        obs.members.forEach((mm, j) => { mm.needs = { ...mm.needs, fun: 30 + 20 * j, patience: 40 + 10 * j }; });
        const broken = opts.breakRating?.(m) && i === 2;
        return {
          ratingId: `rating:${runId}:${agentId}:horizon`, runId, agentId: broken ? 'not-a-member' : agentId, atMs: m.config.horizonMs, endpoint: 'horizon',
          evidenceHash: hashCanonical(obs), observation: obs, rubricVersion: 'satisfaction-rubric-v1', levels: [...RUBRICS['satisfaction-rubric-v1']!.levels],
        };
      }),
      metrics: ({ runId, decisions, ratings, terminalExpected }) => {
        const price = passPriceAt(m.scenario, m.config.horizonMs, 1500);
        const buyers = Math.round(admitted * (price >= 2500 ? 0.25 : 0.5));
        const revenue = price * buyers;
        const travel = decisions.reduce((s, d) => s + (d.probabilities.find((p) => p.optionId === 'travel_splash')?.probability ?? 0), 0);
        const queueMinutes = Math.round(travel * 10 * 1000) / 1000;
        const byAgent = new Map(ratingAgents.flatMap((a) => ratings.filter((r) => r.ratingId.endsWith(`:${a}:horizon`)).map((r) => [a, r] as const)));
        const sat = summarizeTerminalRatings(ratingAgents.slice(0, terminalExpected), byAgent);
        const mv = (id: MetricId, value: number | null, unit: MetricValue['unit'], numerator: number, denominator: number | null, n = admitted): MetricValue =>
          ({ id, value, unit, numerator, denominator, n, coverage: 1, complete: value !== null, missingReason: value === null ? 'denominator unavailable' : null });
        const measures = {
          net_revenue_cents: mv('net_revenue_cents', revenue, 'cents', revenue, null),
          revenue_per_guest_cents: mv('revenue_per_guest_cents', revenue / admitted, 'cents', revenue, admitted),
          satisfaction_0_100: sat,
          queue_minutes_per_guest: mv('queue_minutes_per_guest', queueMinutes / admitted, 'minutes', queueMinutes, admitted),
          completed_ride_wait_minutes: mv('completed_ride_wait_minutes', queueMinutes, 'minutes', queueMinutes, null),
          rides_per_guest: mv('rides_per_guest', 0, 'ratio', 0, admitted),
          abandonment_rate: mv('abandonment_rate', null, 'ratio', 0, null, 0),
          queue_time_share: mv('queue_time_share', 0, 'ratio', 0, admitted),
          early_departures: mv('early_departures', 0, 'guests', 0, null),
          ride_seat_utilization: mv('ride_seat_utilization', null, 'ratio', 0, null, 0),
          server_utilization: mv('server_utilization', null, 'ratio', 0, null, 0),
        } as Record<MetricId, MetricValue>;
        for (const id of METRIC_IDS) if (!measures[id]) throw new Error(`script missing ${id}`);
        const snap: MetricSnapshot = { runId, simMs: m.config.horizonMs, revision: decisions.length + ratings.length + 1, definitionVersion: 'metrics-v1', admittedGuests: admitted, guestsInPark: 0, measures };
        return snap;
      },
    };
  };
}

export type OrchestrationWorldOptions = ScriptOptions & {
  clock: Clock;
  seeds?: string[]; spec?: (s: ExperimentSpec) => ExperimentSpec;
  faultAt?: CoordinatorDeps['faultAt']; config?: Partial<RunConfig>;
  provider?: BehaviorProvider; logger?: Logger; coordinatorOptions?: Partial<CoordinatorOptions>;
};

export function createOrchestrationWorld(o: OrchestrationWorldOptions) {
  const { clock } = o;
  const populations = new Map<string, PopulationManifest>();
  const server: FakeRuntimeServer = new FakeRuntimeServer({
    clock,
    identities: { worker: ['worker'], coordinator: ['coordinator'], operator: ['operator'], viewer: ['viewer'] },
    runScript: scriptFor((m) => {
      const cached = populations.get(m.population.artifactId);
      if (cached) return cached;
      const p = JSON.parse(new TextDecoder().decode(server.artifacts.get(m.population.artifactId)!.bytes)) as PopulationManifest;
      populations.set(m.population.artifactId, p);
      return p;
    }, o),
  });
  const bundle = harborLightsFixturePark();
  const parkRef = server.storeArtifact('operator', 'park', 'application/json', parkArtifact(bundle).bytes, { runId: null, experimentId: null });
  const logger = o.logger ?? new MemoryLogger();
  const workerStore = new MemoryStore();
  const cache = new ResponseCache(workerStore);
  const worker = createWorker({
    client: server.client('worker'), provider: o.provider ?? new MockProvider(), store: workerStore, clock, jitter: new SequenceJitter([0.5]),
    ids: new CounterIds('w'), logger, cache, coalescer: new InflightCoalescer(),
  });
  const waitHook = async () => {
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 4; i++) { const n = await worker.worker.runOnce(); await worker.worker.drain(); if (!n) break; }
  };
  const coordinatorStore = new MemoryStore();
  let incarnation = 0;
  const makeCoordinator = (faultAt = o.faultAt) => createCoordinator({
    client: server.client('coordinator'), provider: new MockProvider(), store: coordinatorStore, clock, jitter: new SequenceJitter([0.5]),
    ids: new CounterIds(`k${++incarnation}`), logger,
    coordinator: { runtime: 'fixture-orchestration-only', cache, ledger: worker.ledger, waitHook, faultAt },
    coordinatorOptions: { pollBaseMs: 100, pollMaxMs: 2000, driverLeaseMs: 30_000, ...o.coordinatorOptions },
  });
  const { seed: _seed, ...crowd } = TINY_CROWD;
  let spec = passPriceExperiment({
    experimentId: 'exp-price-1', park: parkRef, crowd, seeds: o.seeds ?? ['s1', 's2', 's3'], config: experimentConfig(o.config), atMs: 10_000,
  });
  if (o.spec) spec = o.spec(spec);
  const create = async () => {
    const r = await server.client('operator').command('createExperiment', { spec }, `create:${spec.experimentId}`);
    if (!r.ok) throw new Error(`createExperiment: ${r.error.message}`);
    return r.result.workId;
  };
  const runCoordinator = async (c: ReturnType<typeof makeCoordinator>) => {
    const n = await c.worker.runOnce();
    await c.worker.drain();
    return n;
  };
  return { clock, server, spec, parkRef, bundle, worker, cache, coordinatorStore, logger, makeCoordinator, create, runCoordinator };
}
