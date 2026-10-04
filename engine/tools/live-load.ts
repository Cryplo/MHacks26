/**
 * Live crowd load check against a running stack (Engine module + Intelligence worker for the
 * population job). Creates a scheduler-driven run of Harbor Lights, then reports guests in
 * the park and achieved speed over wall time, plus inspector query latency.
 *
 *   SPACETIME_URI=http://127.0.0.1:3000 LOAD_GUESTS=1000 LOAD_SPEED=20 LOAD_MODE=mock \
 *     LOAD_WALL_S=120 npx tsx tools/live-load.ts
 *
 * LOAD_MODE=live requests Jev (needs a Jev worker). The run is cancelled at the end.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "../client/index.js";
import type * as C from "../contract/behavior-v1.js";
import { operatorConfig } from "./local-client.js";

const guests = Number(process.env.LOAD_GUESTS ?? 1000),
  speed = Number(process.env.LOAD_SPEED ?? 20),
  mode = (process.env.LOAD_MODE ?? "mock") as C.Mode,
  wallS = Number(process.env.LOAD_WALL_S ?? 120),
  horizonMs = Number(process.env.LOAD_HORIZON_MS ?? 3 * 3600_000);
const op = new Client(operatorConfig());
await op.connect();
const ok = <T>(r: C.Receipt<T>) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result;
};
const wantRevision = process.env.LOAD_PARK_REVISION ?? null;
const park = (await op.query("listParks", { cursor: null })).items.find(
  (p) =>
    p.status === "ready" &&
    p.parkId.includes("harbor") &&
    (wantRevision === null || p.revision === wantRevision),
);
if (!park) throw new Error("No ready Harbor Lights park");
const shares = {
  young_family: 0.35,
  teens: 0.15,
  couple: 0.2,
  thrill_seekers: 0.1,
  seniors: 0.1,
  solo: 0.1,
};
const t0 = performance.now();
const { workId } = ok(
  await op.command(
    "requestProductWork",
    {
      request: {
        kind: "population",
        park: park.artifact,
        crowd: {
          guestCount: guests,
          seed: `load-${guests}`,
          shares,
          contextNotes: "",
          generatorVersion: "population-v1",
        },
      },
    },
    randomUUID(),
  ),
);
let work = await op.query("getWork", { workId });
while (work.status !== "ready") {
  if (work.status === "failed") throw new Error(JSON.stringify(work.error));
  await new Promise((r) => setTimeout(r, 250));
  work = await op.query("getWork", { workId });
}
const population = (work.result as C.WorkResults["population"]).artifact;
console.log(
  `population ${guests} guests ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
);
const versions: C.VersionSet = {
  engine: "engine-v1",
  observation: "observation.v1",
  options: "options.v1",
  random: "behavior-rng-v1",
  persona: "population-v1",
  prompt: "jev-instructions-v1",
  requestedModel: mode === "live" ? "jev-1.13.0" : "mock-policy-v1",
  meter: "meter.v1",
  loading: "loading.v1",
  metrics: "metrics-v1",
  rubric: "satisfaction-rubric-v1",
  replay: "replay.v1",
  sourceCommit: "live-load",
};
const manifest: C.RunManifest = {
  contractVersion: "behavior.v1",
  park: park.artifact,
  population,
  scenario: { id: "baseline", revision: "1", label: "Baseline", events: [] },
  replicateSeed: "load-seed",
  config: {
    mode,
    horizonMs,
    logicalStepMs: 5000,
    movementStepMs: 250,
    requestedSpeed: speed,
    temperature: 1,
    earlyDepartureThresholdMs: 30 * 60_000,
    ratingEveryMs: 30 * 60_000,
    visualFrameEveryMs: 30_000,
    checkpointEveryMs: 30 * 60_000,
    fallback: mode === "live" ? "live_timeout_v1" : "forbidden",
    liveTimeoutMs: 20_000,
    features: {
      routeChoice: false,
      bumpReactions: false,
      splitGroups: false,
      speechBubbles: false,
      discountMessages: false,
    },
    versions,
  },
  experiment: null,
  initialCheckpoint: null,
  replayTape: null,
};
const { runId } = ok(await op.command("createRun", { manifest }, randomUUID()));
let latest: C.LiveSnapshot | null = null,
  publications = 0;
const unsubscribe = op.subscribeLive(runId, {
  snapshot: (s) => {
    latest = s;
    publications++;
  },
  patch: () => {
    publications++;
  },
  status: () => {},
  error: (e) => console.error("live error", e.message),
});
ok(await op.command("startRun", { runId }, randomUUID()));
const started = performance.now(),
  samples: {
    wallS: number;
    simMin: number;
    inPark: number;
    achieved: number;
  }[] = [];
let lastAgentProbe = 0;
while ((performance.now() - started) / 1000 < wallS) {
  await new Promise((r) => setTimeout(r, 2000));
  const run = await op.query("getRun", { runId }),
    snap = (await op.query("getLiveSnapshot", { runId })) as C.LiveSnapshot,
    wall = (performance.now() - started) / 1000;
  samples.push({
    wallS: Math.round(wall),
    simMin: Math.round(run.simMs / 600) / 100,
    inPark: snap.metrics.guestsInPark,
    achieved: snap.run.achievedSpeed,
  });
  console.log(
    `wall ${wall.toFixed(0)}s  sim ${(run.simMs / 60000).toFixed(1)} min  in park ${snap.metrics.guestsInPark}  admitted ${snap.metrics.admittedGuests}  achieved ${snap.run.achievedSpeed}x (avg ${(run.simMs / 1000 / wall).toFixed(1)}x)  status ${run.status}`,
  );
  if (wall - lastAgentProbe > 10) {
    lastAgentProbe = wall;
    const agent = snap.agents.find(
      (a) =>
        a.state !== "not_arrived" && a.state !== "left" && a.latestEvidenceId,
    );
    if (agent) {
      const q0 = performance.now(),
        detail = await op.query("getAgent", { runId, agentId: agent.agentId });
      console.log(
        `  getAgent ${(performance.now() - q0).toFixed(0)} ms: ${detail.statusText} | ${detail.decisions?.[0]?.rationale.summary ?? "(no decisions yet)"}`,
      );
    }
  }
  if (run.status === "completed") break;
}
void latest;
unsubscribe();
// Scrubbing: frame interval, page and seek latency.
{
  const now = (await op.query("getRun", { runId })).simMs,
    f0 = performance.now(),
    page = await op.query("getFrames", {
      runId,
      fromMs: 0,
      toMs: now,
      cursor: null,
    }),
    pageMs = performance.now() - f0,
    mid = Math.floor(now / 2 / 5000) * 5000,
    s0 = performance.now(),
    seek = await op.query("getFrames", {
      runId,
      fromMs: mid,
      toMs: mid + 60000,
      cursor: null,
    }),
    seekMs = performance.now() - s0,
    gaps = page.items.slice(1).map((f, i) => f.atMs - page.items[i]!.atMs);
  console.log(
    `frames: interval ${gaps[0] ?? "n/a"} ms, page of ${page.items.length} in ${pageMs.toFixed(0)} ms (${(JSON.stringify(page).length / 1e6).toFixed(1)} MB), seek to ${mid} ms -> frame ${seek.items[0]?.atMs} in ${seekMs.toFixed(0)} ms, agents/frame ${seek.items[0]?.snapshot.agents.length}`,
  );
}
const run = await op.query("getRun", { runId });
if (!["completed", "cancelled"].includes(run.status))
  ok(
    await op.command(
      "cancelRun",
      { runId, expectedControlRevision: run.controlRevision },
      randomUUID(),
    ),
  );
const wall = (performance.now() - started) / 1000;
console.log(
  JSON.stringify({
    guests,
    mode,
    requestedSpeed: speed,
    wallS: Math.round(wall),
    simulatedMin: Math.round(run.simMs / 600) / 100,
    averageSpeed: Math.round((run.simMs / 1000 / wall) * 10) / 10,
    peakInPark: Math.max(...samples.map((s) => s.inPark)),
    publications,
    behaviorCounts: run.quality.behaviorCounts,
    samples,
  }),
);
await op.close();
process.exit(0);
