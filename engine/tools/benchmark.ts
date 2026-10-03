import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { tinyPark, tinyPopulation, tinyManifest } from "../fixtures/tiny.js";
import { mockResponse, scriptedChoice } from "../fixtures/mock-driver.js";
import { hashBytes } from "../src/domain/primitives.js";
import { encodeBase64, Navigation } from "../src/navigation/grid.js";
import { createCore } from "../src/domain/state.js";
import { startCore, advanceCore, acceptDecision } from "../src/sim/engine.js";
import { snapshot } from "../src/accounting/metrics.js";
import { MemoryStore, saveCore, type RecordRow } from "../src/runtime/store.js";
class MeasuredStore extends MemoryStore {
  writes = 0;
  bytes = 0;
  override put(row: RecordRow) {
    this.writes++;
    this.bytes += Buffer.byteLength(JSON.stringify(row));
    super.put(row);
  }
}
const duration = Number(process.env.BENCH_HORIZON_MS ?? 60000);
const results = [];
for (const count of [200, 300, 400]) {
  const park = tinyPark(),
    width = 200,
    height = 150,
    cells = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) cells[y * width + x] = 2;
  for (const zone of park.queueZones) {
    zone.cellIndices = zone.cellIndices.map(
      (i) => Math.floor(i / 20) * width + (i % 20),
    );
    for (const cell of zone.cellIndices) cells[cell] = 4;
  }
  park.grid = {
    ...park.grid,
    width,
    height,
    cellsBase64: encodeBase64(cells),
    cellsSha256: hashBytes(cells),
  };
  while (park.places.length < 15) {
    const i = park.places.length;
    park.places.push({
      ...park.places[4]!,
      id: `rest${i}`,
      name: `Rest ${i}`,
      entrance: { xM: 20.5 + i * 8, yM: 30.5 + i * 4 },
    });
  }
  const pop = tinyPopulation(park, count),
    manifest = tinyManifest(park, pop);
  manifest.config.horizonMs = duration;
  manifest.config.visualFrameEveryMs = 5000;
  const s = createCore("benchmark", manifest, park, pop),
    nav = new Navigation(park.grid),
    store = new MeasuredStore();
  const fieldStart = performance.now();
  for (const p of park.places) nav.field(p.entrance);
  const fieldBuildMs = performance.now() - fieldStart;
  // Spread arrivals over walkable cells to measure distributed motion rather
  // than measuring only one coincident entry bottleneck.
  for (const g of Object.values(s.groups)) {
    g.manifest.arrivalMs = 0;
    const i = Number(g.manifest.groupId.slice(1));
    for (const id of g.manifest.memberIds)
      s.persons[id]!.position = {
        xM: 2.5 + (i % 20) * 6,
        yM: 2.5 + Math.floor(i / 20) * 6,
      };
  }
  startCore(s);
  let checks = 0,
    steps = 0,
    publicationBytes = 0,
    barriers = 0;
  const latencies: number[] = [],
    began = performance.now();
  while (s.view.status !== "completed") {
    const before = performance.now(),
      result = advanceCore(s, nav, 100, 1);
    checks += result.neighborChecks;
    steps += result.completedSteps;
    saveCore(store, s);
    latencies.push(performance.now() - before);
    if (result.completedSteps)
      publicationBytes += Buffer.byteLength(JSON.stringify(snapshot(s)));
    if (s.view.status === "blocked") {
      barriers++;
      for (const id of s.view.blockedWorkIds) {
        const r = s.decisions[id]!.request;
        acceptDecision(s, mockResponse(r, scriptedChoice(s, r)));
      }
    }
  }
  const elapsedMs = performance.now() - began;
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies[
      Math.min(latencies.length - 1, Math.floor(latencies.length * p))
    ]!;
  const result = {
    guests: count,
    grid: [width, height],
    destinationFields: 15,
    simulatedMs: duration,
    mode: "Node pure engine + normalized MemoryStore (NOT database reducer latency)",
    fieldBuildMs,
    invocations: latencies.length,
    completedSteps: steps,
    stepsPerInvocation: steps / latencies.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    elapsedMs,
    simulatedSpeed: duration / elapsedMs,
    neighborChecks: checks,
    rowWrites: store.writes,
    serializedRowBytes: store.bytes,
    storedRows: store.rows.size,
    publicationBytes,
    estimatedEgressBytes: {
      oneViewer: publicationBytes,
      fourViewers: publicationBytes * 4,
    },
    heapUsedBytes: process.memoryUsage().heapUsed,
    barriers,
    provider: "engine fixture; no network inference",
    barrierNetworkDelayMs: 0,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(
  "docs/benchmark-results.json",
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      results,
      unrun: [
        "real database load",
        "real-provider mode",
        "measured network egress",
      ],
    },
    null,
    2,
  ) + "\n",
);
