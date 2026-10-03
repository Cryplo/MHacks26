import { cloneJson } from "../domain/primitives.js";
import type * as C from "../../contract/behavior-v1.js";
import { createCore, type CoreState } from "../domain/state.js";
import {
  canonical,
  hash,
  DomainFault,
  ensure,
  checkedInt,
} from "../domain/primitives.js";
import {
  validateContract,
  validatePortInput,
  assertJsonSize,
} from "../domain/contract-validation.js";
import {
  validateConfig,
  validatePopulation,
  validateScenario,
  crowdSchema,
  parse,
} from "../domain/schemas.js";
import { validatePark, Navigation } from "../navigation/grid.js";
import { startCore, advanceCore, acceptDecision } from "../sim/engine.js";
import { acceptRating, snapshot, metrics } from "../accounting/metrics.js";
import { checkpoint, restore, type Checkpoint } from "../replay/checkpoint.js";
import {
  get,
  put,
  list,
  loadCore,
  saveCore,
  payloadHash,
  TransactionStore,
  type Store,
} from "./store.js";
import {
  requireRole,
  requireRun,
  issueShare,
  redeemShare,
  rateLimit,
  type Context,
  type Grant,
  type Share,
  type RoleRecord,
} from "./access.js";
import {
  MAX_ARTIFACT_BYTES,
  MAX_CHUNK_BYTES,
  readJSON,
  readArtifact,
  writeJSON,
} from "./artifacts.js";
import {
  enqueue,
  claim,
  renew,
  finishJob,
  findJob,
  saveJob,
  validateLease,
  providerAttempt,
  leaseMs,
  type Job,
} from "./work.js";
import { acquire, validateDriver, expectedBoundary } from "./driver.js";
export const CAPABILITIES: C.Capabilities = {
  contractVersion: "behavior.v1",
  eventKinds: [
    "pass_price",
    "pass_share",
    "board",
    "notice",
    "closure",
    "show_schedule",
    "app_message",
  ],
  workKinds: [
    "population",
    "parse_crowd",
    "parse_scenario",
    "thought",
    "report",
  ],
  features: {
    routeChoice: true,
    bumpReactions: false,
    splitGroups: false,
    speechBubbles: false,
    discountMessages: false,
  },
  maxGuests: 1000,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
  maxChunkBytes: MAX_CHUNK_BYTES,
};
export type ParkRecord = {
  summary: C.ParkSummary;
  park: C.ParkBundle;
  owner: string;
};
export type ExperimentRecord = {
  owner: string;
  spec: C.ExperimentSpec;
  report: C.ExperimentReport;
  workId: string;
};
export function bootstrap(store: Store, identity: string) {
  ensure(!get(store, "owner", "root"), "Already bootstrapped");
  put(store, "owner", "root", { identity });
  put(store, "role", identity, {
    identity,
    roles: ["operator"],
  } satisfies RoleRecord);
}
export function provision(
  store: Store,
  ctx: Context,
  identity: string,
  roles: C.Role[],
) {
  ensure(
    get<{ identity: string }>(store, "owner", "root")?.identity ===
      ctx.identity,
    "Only publisher may provision",
  );
  ensure(/^[0-9a-f]{64}$/.test(identity), "Invalid identity");
  ensure(
    roles.length > 0 &&
      roles.every((x) => ["operator", "worker", "coordinator"].includes(x)),
    "Invalid trusted role",
  );
  put(store, "role", identity, { identity, roles });
}
export function core(store: Store, runId: string): CoreState {
  const state = loadCore(store, runId);
  if (!state) throw new DomainFault("NOT_FOUND", "Run not found");
  return state;
}
export function command<K extends keyof C.Commands>(
  store: Store,
  ctx: Context,
  name: K,
  input: C.Commands[K]["input"],
  commandId: string,
): C.Receipt<C.Commands[K]["output"]> {
  ensure(/^[A-Za-z0-9_.:-]{1,160}$/.test(commandId), "Invalid command ID");
  assertJsonSize(input);
  const digest = payloadHash(name, input),
    old = get<{ digest: string; receipt: C.Receipt<C.Commands[K]["output"]> }>(
      store,
      "receipt",
      commandId,
      ctx.identity,
    );
  if (old) {
    if (old.digest === digest) return old.receipt;
    return {
      commandId,
      ok: false,
      error: new DomainFault(
        "CONFLICT",
        "Command ID reused with different payload",
      ).error,
    };
  }
  const tx = new TransactionStore(store);
  let receipt: C.Receipt<C.Commands[K]["output"]>;
  try {
    validatePortInput("Commands", name, input);
    const result = dispatchCommand(
      tx,
      ctx,
      name,
      input,
      commandId,
    ) as C.Commands[K]["output"];
    receipt = { commandId, ok: true, result };
    tx.commit();
  } catch (error) {
    if (!(error instanceof DomainFault)) throw error;
    receipt = { commandId, ok: false, error: error.error };
  }
  put(store, "receipt", commandId, { digest, receipt }, ctx.identity);
  return receipt;
}
function publish(store: Store, s: CoreState) {
  if (
    s.view.phase === "prepare" ||
    s.view.phase === "barrier" ||
    s.view.status === "cancelled"
  ) {
    const old = get<C.LiveSnapshot>(store, "publication", s.runId, s.runId);
    const next = snapshot(s);
    const comparable = (x: C.LiveSnapshot) => ({
      ...x,
      run: { ...x.run, revision: 0 },
      metrics: { ...x.metrics, revision: 0 },
    });
    if (!old || hash(comparable(old)) !== hash(comparable(next))) {
      s.view.revision = (old?.run.revision ?? 0) + 1;
      next.run.revision = s.view.revision;
      next.metrics.revision = s.view.revision;
      put(
        store,
        "publication",
        s.runId,
        next,
        s.runId,
        "",
        s.view.simMs,
        s.view.revision,
      );
    }
  }
  saveCore(store, s);
}
function syncWork(store: Store, ctx: Context, s: CoreState) {
  const scope = {
    runId: s.runId,
    experimentId: s.manifest.experiment?.experimentId ?? null,
  };
  for (const slot of Object.values(s.decisions)) {
    const id = `${s.runId}:${slot.request.requestId}`;
    if (slot.status === "pending" || slot.status === "ready")
      enqueue(store, ctx, id, "decision", scope, slot.request);
    else {
      const j = findJob(store, id);
      if (j && j.status !== slot.status) {
        j.status = slot.status;
        saveJob(store, j);
      }
    }
  }
  for (const r of Object.values(s.ratings))
    if (!r.result)
      enqueue(
        store,
        ctx,
        `${s.runId}:${r.request.ratingId}`,
        "rating",
        scope,
        r.request,
      );
}
function parkFor(store: Store, ref: C.ArtifactRef): ParkRecord {
  const p = list<ParkRecord>(store, "park").find(
    (p) =>
      p.summary.artifact.sha256 === ref.sha256 &&
      p.summary.artifact.artifactId === ref.artifactId,
  );
  ensure(p && p.summary.status === "ready", "Park not ready");
  return p;
}
function control(s: CoreState, revision: number) {
  if (s.view.controlRevision !== revision)
    throw new DomainFault("STALE_REVISION", "Control revision changed");
  ensure(
    !["cancelled", "completed", "failed"].includes(s.view.status),
    "Run is terminal",
  );
  s.view.controlRevision++;
}
function dispatchCommand(
  store: Store,
  ctx: Context,
  name: keyof C.Commands,
  input: C.Commands[keyof C.Commands]["input"],
  commandId: string,
): unknown {
  switch (name) {
    case "registerPark": {
      requireRole(store, ctx, ["operator"]);
      const a = input as C.Commands["registerPark"]["input"];
      const artifact = readJSON<unknown>(store, ctx, a.artifact, "park");
      const { park } = validatePark(artifact);
      const existing = get<ParkRecord>(
        store,
        "park",
        `${park.parkId}:${park.revision}`,
      );
      if (existing) {
        ensure(
          existing.summary.artifact.sha256 === a.artifact.sha256,
          "Park revision conflict",
        );
        return existing.summary;
      }
      const summary: C.ParkSummary = {
        parkId: park.parkId,
        revision: park.revision,
        label: park.label,
        artifact: a.artifact,
        status: "ready",
        issues: [],
      };
      put(store, "park", `${park.parkId}:${park.revision}`, {
        summary,
        park,
        owner: ctx.identity,
      } satisfies ParkRecord);
      return summary;
    }
    case "createRun": {
      const { manifest } = input as C.Commands["createRun"]["input"];
      validateContract("RunManifest", manifest);
      validateConfig(manifest.config);
      if (manifest.experiment) {
        requireRole(store, ctx, ["coordinator"]);
        const e = get<ExperimentRecord>(
          store,
          "experiment",
          manifest.experiment.experimentId,
        );
        ensure(e, "Unknown experiment");
        const job = findJob(store, e.workId);
        ensure(
          job?.lease?.ownerIdentity === ctx.identity &&
            job.lease.expiresAtEpochMs > ctx.now,
          "Experiment lease required",
        );
        ensure(
          e.spec.seeds.includes(manifest.replicateSeed),
          "Unexpected experiment seed",
        );
      } else requireRole(store, ctx, ["operator"]);
      const p = parkFor(store, manifest.park),
        population = readJSON<C.PopulationManifest>(
          store,
          ctx,
          manifest.population,
          "population",
        );
      validatePopulation(population, p.park);
      validateScenario(manifest.scenario, p.park);
      const runId = `run:${hash([ctx.identity, commandId]).slice(0, 32)}`;
      let s = createCore(runId, manifest, p.park, population);
      if (manifest.initialCheckpoint) {
        const c = readJSON<Checkpoint>(
          store,
          ctx,
          manifest.initialCheckpoint,
          "checkpoint",
        );
        ensure(
          c.parkHash === hash(p.park) && c.populationHash === hash(population),
          "Checkpoint input mismatch",
        );
        s = restore(c, runId);
        s.manifest = cloneJson(manifest);
        s.view.manifestHash = hash(manifest);
        s.view.mode = manifest.config.mode;
        s.view.scenarioRevision = manifest.scenario.revision;
      }
      ensure(
        (manifest.config.mode === "replay") === (manifest.replayTape !== null),
        "Replay requires a response tape; fresh runs cannot have one",
      );
      put(
        store,
        "grant",
        `owner:${runId}`,
        {
          id: `owner:${runId}`,
          identity: ctx.identity,
          runId,
          role: manifest.experiment ? "coordinator" : "operator",
          expiresAt: null,
          shareId: null,
          delegable: !manifest.experiment,
        } satisfies Grant,
        runId,
      );
      publish(store, s);
      return { runId };
    }
    case "startRun": {
      const a = input as C.Commands["startRun"]["input"];
      requireRun(store, ctx, a.runId, true);
      const s = core(store, a.runId);
      startCore(s);
      publish(store, s);
      return s.view;
    }
    case "pauseRun":
    case "resumeRun":
    case "setSpeed":
    case "cancelRun": {
      const a = input as C.Commands["pauseRun"]["input"] & {
        requestedSpeed?: number;
      };
      requireRun(store, ctx, a.runId, true);
      const s = core(store, a.runId);
      control(s, a.expectedControlRevision);
      if (name === "pauseRun") {
        ensure(
          ["running", "blocked", "draining"].includes(s.view.status),
          "Run not active",
        );
        if (s.view.phase === "prepare") s.view.status = "paused";
        else s.pauseRequested = true;
      }
      if (name === "resumeRun") {
        ensure(s.view.status === "paused", "Run not paused");
        s.view.status = "running";
        s.pauseRequested = false;
      }
      if (name === "setSpeed") {
        ensure(
          typeof a.requestedSpeed === "number" &&
            a.requestedSpeed > 0 &&
            a.requestedSpeed <= 10000,
          "Invalid speed",
        );
        s.view.requestedSpeed = a.requestedSpeed;
      }
      if (name === "cancelRun") {
        s.view.status = "cancelled";
        for (const d of Object.values(s.decisions))
          if (d.status === "pending" || d.status === "ready")
            d.status = "cancelled";
        for (const j of list<Job>(store, "work", a.runId))
          if (["pending", "leased", "ready"].includes(j.status)) {
            j.status = "cancelled";
            saveJob(store, j);
          }
      }
      publish(store, s);
      return s.view;
    }
    case "scheduleEvents": {
      const a = input as C.Commands["scheduleEvents"]["input"];
      requireRun(store, ctx, a.runId, true);
      const s = core(store, a.runId);
      ensure(!s.manifest.experiment, "Comparative runs reject ad hoc edits");
      if (a.expectedScenarioRevision !== s.view.scenarioRevision)
        throw new DomainFault("STALE_REVISION", "Scenario revision changed");
      if (a.draftId) {
        const draftJob = list<Job>(store, "work").find(
          (j) =>
            j.kind === "parse_scenario" &&
            j.status === "ready" &&
            (j.result as C.ScenarioDraft)?.draftId === a.draftId,
        );
        ensure(
          draftJob?.scope.runId === a.runId,
          "Draft belongs to another run",
        );
        ensure(
          canonical((draftJob.result as C.ScenarioDraft).events) ===
            canonical(a.events),
          "Draft changed since review",
        );
      }
      ensure(
        a.events.every((e) => e.atMs >= s.view.earliestSchedulableMs),
        "Event targets prepared/past boundary",
      );
      const scenario = {
        ...s.manifest.scenario,
        revision: hash([s.view.scenarioRevision, a.events]).slice(0, 16),
        events: [...s.manifest.scenario.events, ...a.events],
      };
      validateScenario(scenario, s.park);
      s.manifest.scenario = scenario;
      s.view.scenarioRevision = scenario.revision;
      publish(store, s);
      return { scenarioRevision: scenario.revision, events: a.events };
    }
    case "claimWork": {
      const a = input as C.Commands["claimWork"]["input"];
      return {
        items: claim(store, ctx, a.kinds, a.limit, a.leaseMs, a.workerNonce),
      };
    }
    case "renewWork": {
      const a = input as C.Commands["renewWork"]["input"];
      return { leases: renew(store, ctx, a.leases, a.leaseMs) };
    }
    case "completeWork": {
      const { item } = input as C.Commands["completeWork"]["input"];
      validateContract("CompletedWork", item);
      return finishJob(store, ctx, item, (j) => {
        if (item.kind === "decision" || item.kind === "rating") {
          ensure(j.scope.runId, "Behavior work must have run");
          const s = core(store, j.scope.runId);
          ensure(s.view.status !== "cancelled", "Cancelled run");
          readArtifact(store, ctx, item.result.responseArtifact);
          if (item.kind === "decision") {
            const r = j.payload as C.DecisionRequest;
            ensure(
              item.result.requestId === r.requestId,
              "Wrong decision request",
            );
            acceptDecision(s, item.result);
          } else {
            const r = j.payload as C.RatingRequest;
            ensure(item.result.ratingId === r.ratingId, "Wrong rating request");
            acceptRating(s, item.result);
          }
          publish(store, s);
        } else if (item.kind === "population") {
          const payload = j.payload as C.WorkPayloads["population"],
            park = parkFor(store, payload.park).park,
            pop = readJSON<C.PopulationManifest>(
              store,
              ctx,
              item.result.artifact,
              "population",
            );
          validatePopulation(pop, park);
          ensure(
            pop.personas.length === item.result.guestCount &&
              pop.groups.length === item.result.groupCount,
            "Population result counts mismatch",
          );
        } else if (item.kind === "parse_scenario") {
          const payload = j.payload as C.WorkPayloads["parse_scenario"];
          ensure(
            item.result.contextRevision === payload.context.scenarioRevision,
            "Draft revision mismatch",
          );
          validateScenario(
            {
              id: "draft",
              revision: item.result.contextRevision,
              label: "Draft",
              events: item.result.events,
            },
            parkFor(store, payload.context.park.artifact).park,
          );
        } else if (item.kind === "parse_crowd")
          parse(crowdSchema, item.result.proposal);
        else if (item.kind === "experiment")
          validateContract(
            "ExperimentReport",
            readJSON(store, ctx, item.result.report, "experiment_report"),
          );
        else if (item.kind === "thought" || item.kind === "report") {
          validateContract("Narrative", item.result);
          const expected =
            item.kind === "thought"
              ? hash((j.payload as C.WorkPayloads["thought"]).evidence)
              : hash((j.payload as C.WorkPayloads["report"]).facts);
          ensure(
            item.result.evidenceHash === expected,
            "Narrative evidence mismatch",
          );
        }
      });
    }
    case "recordProviderAttempt":
      return providerAttempt(
        store,
        ctx,
        (input as C.Commands["recordProviderAttempt"]["input"]).attempt,
      );
    case "failWork": {
      const a = input as C.Commands["failWork"]["input"],
        j = validateLease(store, ctx, a.lease);
      j.error = a.error;
      if (a.retryAtEpochMs !== null) {
        ensure(a.retryAtEpochMs >= ctx.now, "Retry in past");
        j.retryAt = a.retryAtEpochMs;
        j.status = "pending";
        j.lease = null;
      } else j.status = "failed";
      saveJob(store, j);
      return { workId: j.id, status: j.status };
    }
    case "acquireDriver": {
      const a = input as C.Commands["acquireDriver"]["input"];
      return acquire(store, ctx, a.runId, a.leaseMs);
    }
    case "renewDriver": {
      const a = input as C.Commands["renewDriver"]["input"],
        d = validateDriver(store, ctx, a.lease);
      leaseMs(a.leaseMs);
      d.lease.expiresAtEpochMs = ctx.now + a.leaseMs;
      put(store, "driver", a.lease.runId, d);
      return d.lease;
    }
    case "releaseDriver": {
      const { lease } = input as C.Commands["releaseDriver"]["input"],
        d = validateDriver(store, ctx, lease);
      d.released = true;
      put(store, "driver", lease.runId, d);
      return { released: true };
    }
    case "advanceRun": {
      const a = input as C.Commands["advanceRun"]["input"];
      validateDriver(store, ctx, a.lease);
      const s = core(store, a.lease.runId);
      expectedBoundary(s.view, a.expectedStep, a.expectedPhase);
      checkedInt(a.maxSteps, "maxSteps", 1, 100);
      const result = advanceCore(
        s,
        new Navigation(s.park.grid),
        Math.min(500, a.maxSteps * 40),
        a.maxSteps,
      );
      syncWork(store, ctx, s);
      publish(store, s);
      return {
        run: s.view,
        completedSteps: result.completedSteps,
        physicalStateHash: s.lastCompletedHash,
        blockedWorkIds: s.view.blockedWorkIds.map((id) => `${s.runId}:${id}`),
      };
    }
    case "checkpointRun": {
      const { runId } = input as C.Commands["checkpointRun"]["input"];
      requireRun(store, ctx, runId, true);
      const s = core(store, runId),
        c = checkpoint(s),
        ref = writeJSON(
          store,
          ctx,
          "checkpoint",
          { runId, experimentId: s.manifest.experiment?.experimentId ?? null },
          c,
        );
      return { checkpoint: ref, physicalStateHash: c.physicalStateHash };
    }
    case "issueShare": {
      const a = input as C.Commands["issueShare"]["input"];
      return issueShare(
        store,
        ctx,
        a.runId,
        a.access,
        a.tokenHash,
        a.expiresAtEpochMs,
      );
    }
    case "redeemShare":
      return redeemShare(
        store,
        ctx,
        (input as C.Commands["redeemShare"]["input"]).token,
      );
    case "revokeShare": {
      const { grantId } = input as C.Commands["revokeShare"]["input"],
        share = get<Share>(store, "share", grantId);
      ensure(share && share.owner === ctx.identity, "Share ownership required");
      share.revoked = true;
      put(store, "share", grantId, share);
      return { revoked: true };
    }
    case "requestProductWork": {
      const { request } = input as C.Commands["requestProductWork"]["input"];
      return productWork(store, ctx, request, commandId);
    }
    case "createExperiment": {
      requireRole(store, ctx, ["operator"]);
      const { spec } = input as C.Commands["createExperiment"]["input"];
      parkFor(store, spec.park);
      validateConfig(spec.config);
      ensure(
        spec.seeds.length > 0 && new Set(spec.seeds).size === spec.seeds.length,
        "Unique seeds required",
      );
      ensure(
        !get(store, "experiment", spec.experimentId),
        "Experiment already exists",
      );
      validateScenario(spec.baseline, parkFor(store, spec.park).park);
      validateScenario(spec.variant, parkFor(store, spec.park).park);
      const report: C.ExperimentReport = {
        spec,
        revision: 0,
        status: "running",
        pairs: spec.seeds.map((seed, i) => ({
          pairId: `pair:${i}`,
          seed,
          populationHash: "0".repeat(64),
          initialStateHash: null,
          aRunId: null,
          bRunId: null,
          status: "pending",
          reasons: [],
          a: null,
          b: null,
          deltas: {},
        })),
        summaries: [],
        requestedPairs: spec.seeds.length,
        completePairs: 0,
        exploratory: true,
        limitations: ["Synthetic model; no calibration claim"],
        facts: null,
        responseTape: null,
      };
      const workId = `experiment:${spec.experimentId}`;
      put(store, "experiment", spec.experimentId, {
        owner: ctx.identity,
        spec,
        report,
        workId,
      } satisfies ExperimentRecord);
      enqueue(
        store,
        ctx,
        workId,
        "experiment",
        { runId: null, experimentId: spec.experimentId },
        spec,
      );
      return { experimentId: spec.experimentId, workId };
    }
    case "recordExperimentProgress": {
      const a = input as C.Commands["recordExperimentProgress"]["input"],
        j = validateLease(store, ctx, a.lease),
        e = get<ExperimentRecord>(store, "experiment", a.experimentId);
      ensure(
        e && j.id === e.workId && j.kind === "experiment",
        "Wrong experiment lease",
      );
      validateContract("ExperimentReport", a.report);
      ensure(
        hash(a.report.spec) === hash(e.spec) &&
          a.report.revision === e.report.revision + 1,
        "Experiment revision/spec mismatch",
      );
      ensure(
        a.report.requestedPairs === e.spec.seeds.length &&
          a.report.completePairs ===
            a.report.pairs.filter((p) => p.status === "complete").length,
        "Incorrect pair coverage",
      );
      e.report = a.report;
      put(store, "experiment", a.experimentId, e);
      return { revision: a.report.revision };
    }
  }
}
function productWork(
  store: Store,
  ctx: Context,
  r: C.ProductRequest,
  commandId: string,
) {
  rateLimit(
    store,
    ctx,
    r.kind === "thought" ? "narration" : "product",
    r.kind === "thought" ? 10 : 30,
  );
  let scope: C.Scope = { runId: null, experimentId: null },
    payload: Job["payload"];
  if (r.kind === "population") {
    requireRole(store, ctx, ["operator"]);
    parse(crowdSchema, r.crowd);
    const p = parkFor(store, r.park);
    payload = {
      crowd: r.crowd,
      park: r.park,
      closeAfterMs: p.park.closeAfterMs,
    };
  } else if (r.kind === "parse_crowd") {
    requireRole(store, ctx, ["operator"]);
    parse(crowdSchema, r.current);
    payload = { text: r.text, current: r.current };
  } else if (r.kind === "parse_scenario") {
    const p = parkFor(store, r.park);
    let s: CoreState | null = null;
    if (r.runId) {
      requireRun(store, ctx, r.runId, true);
      s = core(store, r.runId);
      scope.runId = r.runId;
      ensure(
        s.view.scenarioRevision === r.expectedScenarioRevision,
        "Scenario revision changed",
      );
    } else requireRole(store, ctx, ["operator"]);
    payload = {
      text: r.text,
      context: {
        runId: r.runId,
        currentSimMs: s?.view.simMs ?? 0,
        earliestSchedulableMs: s?.view.earliestSchedulableMs ?? 0,
        scenarioRevision: r.expectedScenarioRevision,
        park: p.summary,
        places: p.park.places.map(({ id, name, kind }) => ({ id, name, kind })),
        capabilities: CAPABILITIES,
      },
    };
  } else if (r.kind === "thought") {
    requireRun(store, ctx, r.runId);
    const s = core(store, r.runId),
      evidence = s.evidence.find((e) => e.evidenceId === r.evidenceId);
    ensure(
      evidence && evidence.request.agentIds.includes(r.agentId),
      "Evidence/member not found",
    );
    scope.runId = r.runId;
    payload = { evidence, agentId: r.agentId };
  } else {
    scope = { runId: r.runId, experimentId: r.experimentId };
    payload = { facts: factBundle(store, ctx, scope) };
  }
  const workId = `work:${hash([ctx.identity, commandId]).slice(0, 32)}`;
  enqueue(store, ctx, workId, r.kind, scope, payload);
  return { workId };
}
export function factBundle(
  store: Store,
  ctx: Context,
  scope: C.Scope,
): C.FactBundle {
  if (scope.runId) {
    requireRun(store, ctx, scope.runId);
    const s = core(store, scope.runId),
      m = metrics(s);
    return {
      contractVersion: "behavior.v1",
      id: `facts:${s.runId}:${s.view.revision}`,
      asOfMs: s.view.simMs,
      sourceHash: hash(m),
      facts: Object.values(m.measures)
        .filter((v) => v.value !== null)
        .map((v) => ({
          id: `metric:${v.id}`,
          label: v.id,
          value: v.value!,
          unit: v.unit,
          denominator: String(v.denominator ?? "none"),
          scope,
          sourceEventIds: [],
          metricId: v.id,
          limitations: v.complete ? [] : ["Incomplete measurement coverage"],
        })),
      quality: s.view.quality,
      scope,
    };
  }
  ensure(scope.experimentId, "Run or experiment required");
  const e = get<ExperimentRecord>(store, "experiment", scope.experimentId);
  ensure(e?.owner === ctx.identity, "Experiment access denied");
  ensure(e.report.facts, "Experiment facts not ready");
  return readJSON(store, ctx, e.report.facts, "fact_bundle", true);
}
