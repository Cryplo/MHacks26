import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { Client } from "../client/index.js";
import type * as C from "../contract/behavior-v1.js";
import { operatorConfig } from "./local-client.js";
import { loadPark } from "../fixtures/load.js";
import { tinyPopulation, tinyManifest } from "../fixtures/tiny.js";
import { mockResponse } from "../fixtures/mock-driver.js";
const config = operatorConfig(),
  op = new Client(config),
  worker = new Client({ ...config, token: null });
await op.connect();
await worker.connect();
const ok = <T>(r: C.Receipt<T>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
};
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const scope = { runId: null, experimentId: null };
const results = [];
try {
  ok(
    await op.wire("provision", "", {
      identity: (await worker.query("session", {})).identity,
      roles: ["worker"],
    }),
  );
  const park = loadPark(),
    ref = await op.putArtifact({
      kind: "park",
      mediaType: "application/json",
      bytes: json(park),
      scope,
      commandId: randomUUID(),
    });
  let registered = ok(
    await op.command("registerPark", { artifact: ref }, randomUUID()),
  );
  const deadline = Date.now() + 120000;
  while (registered.status === "preparing") {
    if (Date.now() > deadline) throw new Error("Field initialization timeout");
    await new Promise((r) => setTimeout(r, 250));
    registered = (await op.query("listParks", { cursor: null })).items.find(
      (p) => p.parkId === park.parkId,
    )!;
  }
  if (registered.status !== "ready")
    throw new Error(registered.issues.join(";"));
  for (const count of [200, 300, 400])
    for (const viewers of [1, 4]) {
      const population = tinyPopulation(park, count);
      for (const g of population.groups) g.arrivalMs = 0;
      const manifest = tinyManifest(park, population);
      manifest.park = registered.artifact;
      manifest.population = await op.putArtifact({
        kind: "population",
        mediaType: "application/json",
        bytes: json(population),
        scope,
        commandId: randomUUID(),
      });
      manifest.config.horizonMs = 10000;
      const { runId } = ok(
        await op.command("createRun", { manifest }, randomUUID()),
      );
      const clients: Client[] = [],
        subscriptions: (() => void)[] = [];
      let deliveredBytes = 0,
        patches = 0;
      for (let i = 0; i < viewers; i++) {
        const c = new Client(config);
        await c.connect();
        clients.push(c);
        subscriptions.push(
          c.subscribeLive(runId, {
            snapshot: (s) => {
              deliveredBytes += json(s).byteLength;
            },
            patch: (p) => {
              deliveredBytes += json(p).byteLength;
              patches++;
            },
            status: () => {},
            error: (e) => {
              throw new Error(e.message);
            },
          }),
        );
      }
      let lease = ok(
        await op.command(
          "acquireDriver",
          { runId, leaseMs: 120000 },
          randomUUID(),
        ),
      );
      ok(await op.command("startRun", { runId }, randomUUID()));
      let run = await op.query("getRun", { runId });
      const latency: number[] = [];
      let barriers = 0,
        completedSteps = 0,
        barrierWallMs = 0;
      const began = performance.now();
      while (run.status !== "completed") {
        const before = performance.now();
        const advanced = ok(
          await op.command(
            "advanceRun",
            {
              lease,
              expectedStep: run.stepIndex,
              expectedPhase: run.phase,
              maxSteps: 1,
            },
            randomUUID(),
          ),
        );
        latency.push(performance.now() - before);
        completedSteps += advanced.completedSteps;
        const barrierStart = performance.now();
        if (advanced.blockedWorkIds.length) {
          barriers++;
          let jobs;
          do {
            jobs = ok(
              await worker.command(
                "claimWork",
                {
                  kinds: ["decision"],
                  limit: 32,
                  leaseMs: 120000,
                  workerNonce: randomUUID(),
                },
                randomUUID(),
              ),
            ).items;
            for (const j of jobs) {
              if (j.kind !== "decision") continue;
              const r = j.payload,
                choice = r.options.some((o) => o.id === "continue")
                  ? "continue"
                  : r.options.some((o) => o.id === "travel:ride")
                    ? "travel:ride"
                    : "leave";
              const response = mockResponse(r, choice);
              response.responseArtifact = await worker.putArtifact({
                kind: "model_response",
                mediaType: "application/json",
                bytes: json({
                  mock: true,
                  probabilities: response.probabilities,
                }),
                scope: j.scope,
                commandId: randomUUID(),
              });
              ok(
                await worker.command(
                  "completeWork",
                  {
                    item: {
                      kind: "decision",
                      lease: j.lease,
                      result: response,
                    },
                  },
                  randomUUID(),
                ),
              );
            }
          } while (jobs.length);
          barrierWallMs += performance.now() - barrierStart;
        }
        run = await op.query("getRun", { runId });
        if (lease.expiresAtEpochMs - Date.now() < 30000)
          lease = ok(
            await op.command(
              "renewDriver",
              { lease, leaseMs: 120000 },
              randomUUID(),
            ),
          );
      }
      latency.sort((a, b) => a - b);
      const p = (x: number) =>
        latency[Math.min(latency.length - 1, Math.floor(x * latency.length))];
      const result = {
        guests: count,
        viewers,
        grid: [200, 150],
        fields: 15,
        simulatedMs: 10000,
        mode: "real SpacetimeDB + engine fixture responses",
        latencyKind:
          "client-observed advanceRun round trip including reducer and transport",
        p50Ms: p(0.5),
        p95Ms: p(0.95),
        p99Ms: p(0.99),
        invocations: latency.length,
        completedSteps,
        wallMs: performance.now() - began,
        barriers,
        barrierWallMs,
        patches,
        deliveredApplicationBytes: deliveredBytes,
        networkWireBytes: null,
        clientHeapBytes: process.memoryUsage().heapUsed,
      };
      results.push(result);
      await writeFile(
        process.env.BENCH_OUTPUT ?? "docs/server-load-results.json",
        JSON.stringify(
          { recordedAt: new Date().toISOString(), partial: true, results },
          null,
          2,
        ) + "\n",
      );
      console.log(JSON.stringify(result));
      for (const stop of subscriptions) stop();
      await Promise.all(clients.map((c) => c.close()));
    }
  await writeFile(
    process.env.BENCH_OUTPUT ?? "docs/server-load-results.json",
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        spacetime: "2.10.2",
        node: process.version,
        results,
        limitations: [
          "10-second occupied-park sample",
          "Coincident entrance arrivals",
          "No real provider",
          "Round-trip timing is not isolated reducer CPU timing",
          "Application payload bytes exclude SDK wire overhead",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await op.close();
  await worker.close();
}
