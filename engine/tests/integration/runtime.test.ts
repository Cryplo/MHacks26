import { it, expect } from "vitest";
import type * as C from "../../contract/behavior-v1.js";
import { MemoryStore, loadCore, put } from "../../src/runtime/store.js";
import { bootstrap, command, provision } from "../../src/runtime/runtime.js";
import { query } from "../../src/runtime/queries.js";
import {
  beginUpload,
  uploadChunk,
  finalizeUpload,
  MAX_CHUNK_BYTES,
} from "../../src/runtime/artifacts.js";
import type { Context } from "../../src/runtime/access.js";
import { encodeBase64 } from "../../src/navigation/grid.js";
import { hashBytes } from "../../src/domain/primitives.js";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { mockResponse, scriptedChoice } from "../../fixtures/mock-driver.js";
function unwrap<T>(receipt: C.Receipt<T>): T {
  if (!receipt.ok) throw new Error(JSON.stringify(receipt.error));
  return receipt.result;
}
it("A-10 A-17 durable public command path drives the real core with explicit mock responses", () => {
  const store = new MemoryStore();
  let id = 0;
  const op: Context = {
      identity: "operator",
      now: 1000,
      nonce: () => `nonce-${++id}`,
    },
    worker = { ...op, identity: "a".repeat(64) };
  bootstrap(store, op.identity);
  provision(store, op, worker.identity, ["worker"]);
  const call = <K extends keyof C.Commands>(
    ctx: Context,
    name: K,
    input: C.Commands[K]["input"],
    cid = `cmd:${++id}`,
  ) => unwrap(command(store, ctx, name, input, cid));
  function upload(
    ctx: Context,
    kind: C.ArtifactKind,
    value: unknown,
    scope: C.Scope = { runId: null, experimentId: null },
  ) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)),
      uploadId = `upload:${++id}`;
    beginUpload(store, ctx, {
      id: uploadId,
      kind,
      mediaType: "application/json",
      scope,
      byteLength: bytes.length,
      sha256: hashBytes(bytes),
    });
    for (let i = 0; i < Math.ceil(bytes.length / MAX_CHUNK_BYTES); i++)
      uploadChunk(
        store,
        ctx,
        uploadId,
        i,
        encodeBase64(
          bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES),
        ),
      );
    return finalizeUpload(store, ctx, uploadId);
  }
  const park = tinyPark(),
    pop = tinyPopulation(park, 3),
    manifest = tinyManifest(park, pop);
  manifest.config.horizonMs = 360000;
  manifest.park = upload(op, "park", park);
  manifest.population = upload(op, "population", pop);
  call(op, "registerPark", { artifact: manifest.park });
  const { runId } = call(op, "createRun", { manifest });
  call(op, "startRun", { runId });
  let lease = call(op, "acquireDriver", { runId, leaseMs: 120000 }),
    run = query(store, op, "getRun", { runId });
  let loops = 0;
  while (run.status !== "completed") {
    expect(++loops).toBeLessThan(1000);
    op.now += 10;
    worker.now = op.now;
    const input = {
        lease,
        expectedStep: run.stepIndex,
        expectedPhase: run.phase,
        maxSteps: 1,
      },
      cid = `advance:${++id}`,
      result = call(op, "advanceRun", input, cid);
    expect(call(op, "advanceRun", input, cid)).toEqual(result);
    expect(
      command(store, op, "advanceRun", { ...input, maxSteps: 2 }, cid).ok,
    ).toBe(false);
    for (const item of call(worker, "claimWork", {
      kinds: ["decision"],
      limit: 32,
      leaseMs: 120000,
      workerNonce: "random-worker-nonce-123456",
    }).items) {
      if (item.kind !== "decision") throw new Error("Wrong kind");
      const state = loadCore(store, runId)!,
        response = mockResponse(
          item.payload,
          scriptedChoice(state, item.payload),
        );
      response.responseArtifact = upload(
        worker,
        "model_response",
        { mock: true, probabilities: response.probabilities },
        item.scope,
      );
      call(worker, "completeWork", {
        item: { kind: "decision", lease: item.lease, result: response },
      });
    }
    run = query(store, op, "getRun", { runId });
    if (op.now > 100000)
      lease = call(op, "renewDriver", { lease, leaseMs: 120000 });
  }
  const state = loadCore(store, runId)!;
  expect(state.totals.departed).toBe(3);
  expect(state.sales.reduce((n, s) => n + s.amountCents, 0)).toBe(6000);
  expect(query(store, op, "getLiveSnapshot", { runId }).run.status).toBe(
    "completed",
  );
  const viewer = { ...op, identity: "viewer" };
  put(
    store,
    "grant",
    "viewer",
    {
      id: "viewer",
      identity: "viewer",
      runId,
      role: "viewer",
      expiresAt: null,
      shareId: null,
      delegable: false,
    },
    runId,
  );
  expect(
    command(
      store,
      viewer,
      "setSpeed",
      {
        runId,
        requestedSpeed: 2,
        expectedControlRevision: run.controlRevision,
      },
      "viewer-write",
    ).ok,
  ).toBe(false);
  expect(query(store, viewer, "getRun", { runId }).runId).toBe(runId);
}, 20000);
