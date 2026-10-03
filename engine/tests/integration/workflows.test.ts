import { it, expect } from "vitest";
import type * as C from "../../contract/behavior-v1.js";
import {
  MemoryStore,
  loadCore,
  get,
  saveCore,
} from "../../src/runtime/store.js";
import {
  bootstrap,
  command,
  provision,
  type ParkRecord,
} from "../../src/runtime/runtime.js";
import { query, availableWork } from "../../src/runtime/queries.js";
import { writeJSON, readArtifact } from "../../src/runtime/artifacts.js";
import { scheduleLive } from "../../src/runtime/scheduler.js";
import { prepareFields } from "../../src/runtime/navigation.js";
import { hash } from "../../src/domain/primitives.js";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
function setup() {
  const store = new MemoryStore();
  let n = 0;
  const op = { identity: "operator", now: 1000, nonce: () => `n${++n}` },
    worker = { ...op, identity: "a".repeat(64) },
    coordinator = { ...op, identity: "b".repeat(64) };
  bootstrap(store, op.identity);
  provision(store, op, worker.identity, ["worker"]);
  provision(store, op, coordinator.identity, ["coordinator"]);
  const call = <K extends keyof C.Commands>(
    who: typeof op,
    name: K,
    input: C.Commands[K]["input"],
  ) => {
    const r = command(store, who, name, input, `command:${++n}`);
    if (!r.ok) throw new Error(r.error.message);
    return r.result;
  };
  const upload = (who: typeof op, kind: C.ArtifactKind, v: unknown) =>
    writeJSON(store, who, kind, { runId: null, experimentId: null }, v);
  const park = tinyPark(),
    pop = tinyPopulation(park, 3),
    manifest = tinyManifest(park, pop);
  manifest.park = upload(op, "park", park);
  manifest.population = upload(op, "population", pop);
  call(op, "registerPark", { artifact: manifest.park });
  const { runId } = call(op, "createRun", { manifest });
  return {
    store,
    op,
    worker,
    coordinator,
    call,
    upload,
    park,
    pop,
    manifest,
    runId,
  };
}
it("A-08 scheduler honors external driver and pause/resume safe points", () => {
  const { store, op, call, runId } = setup(),
    system = { ...op, identity: "scheduler" };
  const lease = call(op, "acquireDriver", { runId, leaseMs: 10000 });
  call(op, "startRun", { runId });
  scheduleLive(store, system);
  expect(loadCore(store, runId)!.view.simMs).toBe(0);
  call(op, "releaseDriver", { lease });
  call(op, "setSpeed", {
    runId,
    requestedSpeed: 100,
    expectedControlRevision: 1,
  });
  scheduleLive(store, system);
  system.now += 250;
  scheduleLive(store, system);
  expect(loadCore(store, runId)!.view.status).toBe("blocked");
  let view = query(store, op, "getRun", { runId });
  call(op, "pauseRun", {
    runId,
    expectedControlRevision: view.controlRevision,
  });
  view = query(store, op, "getRun", { runId });
  expect(view.status).toBe("paused");
  system.now += 250;
  scheduleLive(store, system);
  expect(query(store, op, "getRun", { runId }).status).toBe("paused");
  call(op, "resumeRun", {
    runId,
    expectedControlRevision: view.controlRevision,
  });
  expect(availableWork(store, { ...op, identity: "viewer" })).toEqual([]);
});
it("A-20 population workflow attaches validated worker artifact to requester", () => {
  const { store, op, worker, call, upload, manifest, pop } = setup();
  const { workId } = call(op, "requestProductWork", {
    request: { kind: "population", park: manifest.park, crowd: pop.crowd },
  });
  expect(query(store, op, "getWork", { workId }).status).toBe("pending");
  const job = call(worker, "claimWork", {
    kinds: ["population"],
    limit: 1,
    leaseMs: 10000,
    workerNonce: "worker-nonce-long",
  }).items[0]!;
  expect(readArtifact(store, worker, manifest.park).length).toBeGreaterThan(0);
  const artifact = upload(worker, "population", pop);
  call(worker, "completeWork", {
    item: {
      kind: "population",
      lease: job.lease,
      result: { artifact, guestCount: 3, groupCount: 1 },
    },
  });
  expect(query(store, op, "getWork", { workId }).status).toBe("ready");
  expect(readArtifact(store, op, artifact).length).toBeGreaterThan(0);
  expect(
    call(op, "createRun", { manifest: { ...manifest, population: artifact } })
      .runId,
  ).toBeTruthy();
});
it("A-09 invalid completed work preserves error evidence and fences its lease", () => {
  const { store, op, worker, call, upload, manifest, pop } = setup();
  const { workId } = call(op, "requestProductWork", {
    request: { kind: "population", park: manifest.park, crowd: pop.crowd },
  });
  const job = call(worker, "claimWork", {
    kinds: ["population"],
    limit: 1,
    leaseMs: 10000,
    workerNonce: "worker-nonce-long",
  }).items[0]!;
  const result = {
    artifact: upload(worker, "population", pop),
    guestCount: 99,
    groupCount: 1,
  };
  const r = command(
    store,
    worker,
    "completeWork",
    { item: { kind: "population", lease: job.lease, result } },
    "invalid",
  );
  expect(r.ok).toBe(false);
  expect(query(store, op, "getWork", { workId }).status).toBe("pending");
  expect(store.list("work_error")).toHaveLength(1);
  expect(() =>
    call(worker, "renewWork", { leases: [job.lease], leaseMs: 10000 }),
  ).toThrow();
});
it("A-20 viewer query matrix and cancel prevent subsequent work mutation", () => {
  const { store, op, call, runId } = setup(),
    viewer = { ...op, identity: "viewer" },
    token = "capability-material-long-enough-123";
  const share = call(op, "issueShare", {
    runId,
    access: "viewer",
    tokenHash: hash(token),
    expiresAtEpochMs: 5000,
  });
  call(viewer, "redeemShare", { token });
  expect(query(store, viewer, "getManifest", { runId }).config).toBeTruthy();
  expect(
    query(store, viewer, "getAgent", { runId, agentId: "a0" }).agent,
  ).not.toHaveProperty("facts");
  expect(
    query(store, viewer, "getEvents", { runId, afterSequence: 0, limit: 5 })
      .items,
  ).toEqual([]);
  expect(
    query(store, viewer, "getMetrics", {
      runId,
      fromMs: 0,
      toMs: 10000,
      cursor: null,
    }).items,
  ).toEqual([]);
  expect(
    query(store, viewer, "getFrames", {
      runId,
      fromMs: 0,
      toMs: 10000,
      cursor: null,
    }).items,
  ).toEqual([]);
  expect(
    query(store, viewer, "getHeatmap", {
      runId,
      layer: "waiting_person_minutes",
      fromMs: 0,
      toMs: 0,
    }).total,
  ).toBe(0);
  expect(
    query(store, viewer, "getFactBundle", { runId, experimentId: null }).facts
      .length,
  ).toBeGreaterThan(0);
  expect(() =>
    call(viewer, "acquireDriver", { runId, leaseMs: 10000 }),
  ).toThrow();
  call(op, "revokeShare", { grantId: share.grantId });
  expect(() => query(store, viewer, "getRun", { runId })).toThrow();
  call(op, "startRun", { runId });
  call(op, "cancelRun", { runId, expectedControlRevision: 1 });
  expect(() =>
    call(op, "resumeRun", { runId, expectedControlRevision: 2 }),
  ).toThrow();
  expect(query(store, op, "getRun", { runId }).status).toBe("cancelled");
});
it("A-01 staged park fields remain preparing until all required destinations exist", () => {
  const { store, op, park, manifest } = setup(),
    record = get<ParkRecord>(store, "park", `${park.parkId}:${park.revision}`)!;
  record.summary.status = "preparing";
  record.fieldCursor = 0;
  for (let i = 0; i < park.places.length - 1; i++) {
    prepareFields(store, record, 1);
    expect(record.summary.status).toBe("preparing");
  }
  prepareFields(store, record, 1);
  expect(record.summary.status).toBe("ready");
  expect(
    query(store, op, "listParks", { cursor: null }).items[0]!.artifact,
  ).toEqual(manifest.park);
});
it("A-23 checkpoint public command creates a clone with new run scope and same physics", () => {
  const { store, op, call, manifest, runId } = setup();
  const c = call(op, "checkpointRun", { runId }),
    restored = call(op, "createRun", {
      manifest: { ...manifest, initialCheckpoint: c.checkpoint },
    });
  expect(restored.runId).not.toBe(runId);
  const c2 = call(op, "checkpointRun", { runId: restored.runId });
  expect(c2.physicalStateHash).toBe(c.physicalStateHash);
  const s = loadCore(store, runId)!;
  s.view.phase = "barrier";
  saveCore(store, s);
  expect(() => call(op, "checkpointRun", { runId })).toThrow();
});
it("A-20 experiment coordinator cannot attach foreign arm metrics or alter declared scenario", () => {
  const { store, op, coordinator, call, upload, manifest, pop } = setup();
  const { seed: _seed, ...crowd } = pop.crowd;
  const spec: C.ExperimentSpec = {
    contractVersion: "behavior.v1",
    experimentId: "comparison",
    park: manifest.park,
    crowd,
    seeds: [manifest.replicateSeed],
    baseline: manifest.scenario,
    variant: { ...manifest.scenario, id: "variant" },
    config: manifest.config,
    interventionLabel: "Fixture",
    changedLever: "none",
    analysis: "paired_descriptive",
    alpha: 0.05,
    operationBudgetMs: 60000,
    maxConcurrentArms: 1,
    start: { kind: "opening" },
  };
  call(op, "createExperiment", { spec });
  const job = call(coordinator, "claimWork", {
    kinds: ["experiment"],
    limit: 1,
    leaseMs: 10000,
    workerNonce: "coordinator-nonce-long",
  }).items[0]!;
  manifest.population = upload(coordinator, "population", pop);
  const experiment = {
    experimentId: "comparison",
    pairId: "pair:0",
    arm: "A" as const,
  };
  const arm = call(coordinator, "createRun", {
    manifest: { ...manifest, experiment },
  });
  expect(arm.runId).toBeTruthy();
  expect(() =>
    call(coordinator, "createRun", {
      manifest: {
        ...manifest,
        experiment,
        scenario: { ...manifest.scenario, id: "wrong" },
      },
    }),
  ).toThrow();
  const report = query(store, coordinator, "getExperiment", {
    experimentId: "comparison",
  });
  report.revision++;
  call(coordinator, "recordExperimentProgress", {
    experimentId: "comparison",
    lease: job.lease,
    report,
  });
  report.revision++;
  report.pairs[0]!.aRunId = "foreign";
  expect(() =>
    call(coordinator, "recordExperimentProgress", {
      experimentId: "comparison",
      lease: job.lease,
      report,
    }),
  ).toThrow();
});
