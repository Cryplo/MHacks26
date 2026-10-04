import { it, expect } from "vitest";
import type * as C from "../../contract/behavior-v1.js";
import { MemoryStore, loadCore } from "../../src/runtime/store.js";
import { bootstrap, command } from "../../src/runtime/runtime.js";
import { query } from "../../src/runtime/queries.js";
import {
  beginUpload,
  uploadChunk,
  finalizeUpload,
  MAX_CHUNK_BYTES,
} from "../../src/runtime/artifacts.js";
import type { Context } from "../../src/runtime/access.js";
import { encodeBase64 } from "../../src/navigation/grid.js";
import { canonical, hashBytes } from "../../src/domain/primitives.js";
import { physicalHash } from "../../src/replay/physical.js";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { FULL_EVIDENCE_PER_GROUP } from "../../src/sim/retention.js";

function unwrap<T>(receipt: C.Receipt<T>): T {
  if (!receipt.ok) throw new Error(JSON.stringify(receipt.error));
  return receipt.result;
}
/** Drives an in-process mock run through the public command path. */
function drive(store: MemoryStore, guests: number) {
  let id = 0;
  const op: Context = {
    identity: "operator",
    now: 1000,
    nonce: () => `nonce-${++id}`,
  };
  bootstrap(store, op.identity);
  const call = <K extends keyof C.Commands>(
    name: K,
    input: C.Commands[K]["input"],
  ) => unwrap(command(store, op, name, input, `cmd:${++id}`));
  const upload = (kind: C.ArtifactKind, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)),
      uploadId = `upload:${++id}`;
    beginUpload(store, op, {
      id: uploadId,
      kind,
      mediaType: "application/json",
      scope: { runId: null, experimentId: null },
      byteLength: bytes.length,
      sha256: hashBytes(bytes),
    });
    for (let i = 0; i < Math.ceil(bytes.length / MAX_CHUNK_BYTES); i++)
      uploadChunk(
        store,
        op,
        uploadId,
        i,
        encodeBase64(
          bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES),
        ),
      );
    return finalizeUpload(store, op, uploadId);
  };
  const park = tinyPark(),
    pop = tinyPopulation(park, guests),
    manifest = tinyManifest(park, pop);
  manifest.config.horizonMs = 600000;
  delete manifest.config.mockResolution; // default: Engine evaluates the mock policy
  manifest.park = upload("park", park);
  manifest.population = upload("population", pop);
  call("registerPark", { artifact: manifest.park });
  const { runId } = call("createRun", { manifest });
  call("startRun", { runId });
  const lease = call("acquireDriver", { runId, leaseMs: 120000 });
  let run = query(store, op, "getRun", { runId }),
    advances = 0;
  while (run.status !== "completed") {
    expect(++advances).toBeLessThan(200);
    op.now += 10;
    const r = call("advanceRun", {
      lease,
      expectedStep: run.stepIndex,
      expectedPhase: run.phase,
      maxSteps: 6,
    });
    // In-process mock resolution never leaves a run waiting on a worker.
    expect(r.run.status).not.toBe("blocked");
    run = r.run;
  }
  return { runId, op, advances };
}

it("mock runs resolve behavior in-process and advance several steps per command", () => {
  const store = new MemoryStore(),
    { runId, op, advances } = drive(store, 24);
  expect(advances).toBeLessThanOrEqual(Math.ceil(600000 / 5000 / 6) + 1);
  const s = loadCore(store, runId)!;
  expect(s.view.quality.behaviorCounts.mock).toBeGreaterThan(0);
  expect(s.view.quality.terminalRatingsComplete).toBe(
    s.view.quality.terminalRatingsExpected,
  );
  // No work rows: nothing was queued for a worker.
  expect(
    [...store.rows.values()].filter((r) => r.family === "work"),
  ).toHaveLength(0);
  // Bounded history: no applied slots, at most a few full evidence records per group.
  expect(
    Object.values(s.decisions).every(
      (d) => d.status === "pending" || d.status === "ready",
    ),
  ).toBe(true);
  const perGroup = new Map<string, number>();
  for (const e of s.evidence)
    perGroup.set(e.request.groupId, (perGroup.get(e.request.groupId) ?? 0) + 1);
  expect(Math.max(...perGroup.values())).toBeLessThanOrEqual(
    FULL_EVIDENCE_PER_GROUP,
  );
  // Every applied decision carries a factual rationale; the inspector gets history + status.
  for (const e of s.evidence) {
    expect(e.rationale?.summary).toMatch(/-> chose /);
    expect(e.rationale?.chosen.optionId).toBe(e.chosenOptionId);
  }
  const agentId = s.population.personas[0]!.agentId,
    detail = query(store, op, "getAgent", { runId, agentId });
  expect(detail.statusText).toBeTruthy();
  expect(detail.decisions!.length).toBeGreaterThan(0);
  expect(detail.decisions![0]!.rationale.drivers.length).toBeGreaterThan(1);
  expect(detail.evidence?.rationale).toBeDefined();
  // Scrubbing: compact frames expand to full contract frames, paged by cursor.
  const first = query(store, op, "getFrames", {
    runId,
    fromMs: 0,
    toMs: 600000,
    cursor: null,
  });
  expect(first.items.length).toBe(10);
  expect(first.items[0]!.frameSchema).toBe("frame-v2");
  expect(first.items[0]!.snapshot.agents).toHaveLength(24);
  const gap = first.items[1]!.atMs - first.items[0]!.atMs;
  expect(gap).toBeLessThanOrEqual(15000);
  const next = query(store, op, "getFrames", {
    runId,
    fromMs: 0,
    toMs: 600000,
    cursor: first.nextCursor,
  });
  expect(next.items[0]!.atMs).toBe(first.items[9]!.atMs + gap);
  const seek = query(store, op, "getFrames", {
    runId,
    fromMs: 300000,
    toMs: 300000 + gap,
    cursor: null,
  });
  expect(seek.items[0]!.atMs).toBe(300000);
  const queued = seek.items[0]!.snapshot.queues.flatMap((q) =>
    q.entries.flatMap((e) => e.positions),
  );
  for (const p of queued)
    expect(
      seek.items[0]!.snapshot.agents.find((a) => a.agentId === p.agentId)!
        .position,
    ).toEqual(p.position);
});

it("the cross-command state cache persists exactly what a cold load/save cycle persists", () => {
  const cold = new MemoryStore(),
    warm = new MemoryStore({ cache: true }),
    a = drive(cold, 30),
    b = drive(warm, 30);
  const strip = (store: MemoryStore) =>
    new Map(
      [...store.rows].map(([k, r]) => [
        k,
        r.family === "run"
          ? { ...r, body: r.body.replace(/"persistStamp":"[^"]*"/, "") }
          : r.family === "publication"
            ? { ...r, body: canonical(JSON.parse(r.body)) } // plain JSON; key order may vary
            : r,
      ]),
    );
  const sw = strip(warm),
    sc = strip(cold);
  expect(sw).toEqual(sc);
  expect(physicalHash(loadCore(warm, b.runId)!)).toBe(
    physicalHash(loadCore(cold, a.runId)!),
  );
});
