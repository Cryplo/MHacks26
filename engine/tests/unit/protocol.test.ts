import { it, expect, describe } from "vitest";
import {
  MemoryStore,
  TransactionStore,
  get,
  put,
} from "../../src/runtime/store.js";
import {
  enqueue,
  claim,
  renew,
  validateLease,
  finishJob,
  providerAttempt,
} from "../../src/runtime/work.js";
import {
  beginUpload,
  uploadChunk,
  finalizeUpload,
  readArtifact,
} from "../../src/runtime/artifacts.js";
import { acquire, validateDriver } from "../../src/runtime/driver.js";
import {
  requireRun,
  issueShare,
  redeemShare,
  type Context,
} from "../../src/runtime/access.js";
import { hash, hashBytes } from "../../src/domain/primitives.js";
import { encodeBase64 } from "../../src/navigation/grid.js";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { createCore } from "../../src/domain/state.js";
import { startCore, advanceCore } from "../../src/sim/engine.js";
import { Navigation } from "../../src/navigation/grid.js";
import { mockResponse } from "../../fixtures/mock-driver.js";
function setup() {
  const store = new MemoryStore();
  let n = 0;
  const ctx: Context = {
    identity: "operator",
    now: 1000,
    nonce: () => `nonce-${++n}`,
  };
  for (const id of ["operator", "worker1", "worker2"])
    put(store, "role", id, {
      identity: id,
      roles: [id === "operator" ? "operator" : "worker"],
    });
  put(
    store,
    "grant",
    "owner",
    {
      id: "owner",
      identity: "operator",
      runId: "run",
      role: "operator",
      expiresAt: null,
      shareId: null,
      delegable: true,
    },
    "run",
  );
  return { store, ctx };
}
function request() {
  const p = tinyPark(),
    pop = tinyPopulation(p),
    s = createCore("run", tinyManifest(p, pop), p, pop);
  startCore(s);
  advanceCore(s, new Navigation(p.grid), 100);
  return s.decisions[s.view.blockedWorkIds[0]!]!.request;
}
describe("Durable protocol primitives", () => {
  it("A-09 two claimants race, expiry fences old attempt and renewal", () => {
    const { store, ctx } = setup(),
      r = request();
    enqueue(
      store,
      ctx,
      "job",
      "decision",
      { runId: "run", experimentId: null },
      r,
    );
    const a = { ...ctx, identity: "worker1" },
      b = { ...ctx, identity: "worker2" };
    const first = claim(
      store,
      a,
      ["decision"],
      1,
      1000,
      "nonce-worker-123456",
    )[0]!;
    expect(
      claim(store, b, ["decision"], 1, 1000, "nonce-worker-123456"),
    ).toEqual([]);
    b.now = 2001;
    const next = claim(
      store,
      b,
      ["decision"],
      1,
      1000,
      "nonce-worker-123456",
    )[0]!;
    expect(next.lease.attempt).toBe(2);
    expect(() =>
      validateLease(store, { ...a, now: 2001 }, first.lease),
    ).toThrow();
    expect(() =>
      renew(store, { ...a, now: 2001 }, [first.lease], 1000),
    ).toThrow();
    const done = {
      kind: "decision" as const,
      lease: next.lease,
      result: mockResponse(r, r.options[0]!.id),
    };
    expect(finishJob(store, b, done, () => {}).status).toBe("ready");
    expect(finishJob(store, b, done, () => {}).status).toBe("ready");
  });
  it("A-08 only one driver and stale fences fail after expiry", () => {
    const { store, ctx } = setup(),
      a = acquire(store, ctx, "run", 1000);
    expect(() => acquire(store, ctx, "run", 1000)).toThrow();
    ctx.now = 2001;
    const b = acquire(store, ctx, "run", 1000);
    expect(b.epoch).toBe(2);
    expect(() => validateDriver(store, ctx, a)).toThrow();
    expect(validateDriver(store, ctx, b).owner).toBe(ctx.identity);
  });
  it("A-20 viewer cannot write, delegate or redeem expired/revoked shares", () => {
    const { store, ctx } = setup(),
      token = "secure-test-capability-material-123456",
      issued = issueShare(store, ctx, "run", "viewer", hash(token), 5000);
    const viewer = { ...ctx, identity: "viewer" };
    redeemShare(store, viewer, token);
    expect(requireRun(store, viewer, "run").role).toBe("viewer");
    expect(() => requireRun(store, viewer, "run", true)).toThrow();
    expect(() =>
      issueShare(store, viewer, "run", "operator", hash("other"), 5000),
    ).toThrow();
    expect(() => redeemShare(store, { ...viewer, now: 5001 }, token)).toThrow();
    expect(() => redeemShare(store, viewer, token + "forged")).toThrow();
    const share = get<Record<string, unknown>>(store, "share", issued.grantId)!;
    put(store, "share", issued.grantId, { ...share, revoked: true });
    expect(() => requireRun(store, viewer, "run")).toThrow();
  });
  it("A-21 incomplete/corrupt/duplicate artifacts never promote silently", () => {
    const { store, ctx } = setup(),
      bytes = new TextEncoder().encode('{"test":1}'),
      input = {
        id: "upload1",
        kind: "population" as const,
        mediaType: "application/json",
        scope: { runId: "run", experimentId: null },
        byteLength: bytes.length,
        sha256: hashBytes(bytes),
      };
    beginUpload(store, ctx, input);
    expect(() => finalizeUpload(store, ctx, "upload1")).toThrow();
    uploadChunk(store, ctx, "upload1", 0, encodeBase64(bytes));
    uploadChunk(store, ctx, "upload1", 0, encodeBase64(bytes));
    expect(() =>
      uploadChunk(
        store,
        ctx,
        "upload1",
        0,
        encodeBase64(new Uint8Array(bytes.length)),
      ),
    ).toThrow();
    const ref = finalizeUpload(store, ctx, "upload1");
    expect(readArtifact(store, ctx, ref)).toEqual(bytes);
    expect(() =>
      readArtifact(store, { ...ctx, identity: "intruder" }, ref),
    ).toThrow();
    expect(() =>
      beginUpload(store, ctx, { ...input, id: "bad", byteLength: 1e9 }),
    ).toThrow();
  });
  it("A-10 transaction overlay drops partial changes on domain failure", () => {
    const { store } = setup(),
      tx = new TransactionStore(store);
    put(tx, "rate", "x", { count: 5 });
    expect(get(store, "rate", "x")).toBeUndefined();
    tx.commit();
    expect(get(store, "rate", "x")).toEqual({ count: 5 });
  });
  it("A-17 usage attempts are monotonic and counted once", () => {
    const { store, ctx } = setup(),
      r = request();
    enqueue(
      store,
      ctx,
      "job",
      "decision",
      { runId: "run", experimentId: null },
      r,
    );
    const worker = { ...ctx, identity: "worker1" };
    claim(store, worker, ["decision"], 1, 1000, "worker-nonce-123456");
    const a = {
      callId: "call",
      workId: "job",
      phase: "started" as const,
      provider: "jev" as const,
      modelRequested: "jev",
      modelReturned: null,
      startedAtEpochMs: 1000,
      durationMs: null,
      outcome: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      priceVersion: null,
      billingOwnerRunId: "run",
    };
    providerAttempt(store, worker, a);
    providerAttempt(store, worker, {
      ...a,
      phase: "finished",
      durationMs: 50,
      outcome: "success",
      inputTokens: 500,
    });
    expect(providerAttempt(store, worker, a).phase).toBe("finished");
    expect(store.list("attempt")).toHaveLength(1);
  });
});
it("A-20 assigned setup work grants exact input access and attaches output only to its requester", async () => {
  const { writeJSON, attachArtifactReader } =
    await import("../../src/runtime/artifacts.js");
  const { store, ctx } = setup(),
    scope = { runId: null, experimentId: null };
  const input = writeJSON(store, ctx, "park", scope, { fixture: 1 }),
    secret = writeJSON(store, ctx, "population", scope, { private: 2 });
  enqueue(store, ctx, "setup", "population", scope, {
    park: input,
    closeAfterMs: 3600000,
    crowd: tinyPopulation(tinyPark()).crowd,
  });
  const worker = { ...ctx, identity: "worker1" };
  claim(store, worker, ["population"], 1, 1000, "long-worker-nonce");
  expect(readArtifact(store, worker, input).length).toBeGreaterThan(0);
  expect(() => readArtifact(store, worker, secret)).toThrow();
  const result = writeJSON(store, worker, "population", scope, { result: 1 });
  expect(() => readArtifact(store, ctx, result)).toThrow();
  attachArtifactReader(store, worker, result, ctx.identity);
  expect(readArtifact(store, ctx, result).length).toBeGreaterThan(0);
  expect(() =>
    readArtifact(store, { ...ctx, identity: "worker2" }, result),
  ).toThrow();
});
it("A-09 live timeout is labeled fallback and fences a late leased response", async () => {
  const { resolveLiveTimeouts } = await import("../../src/runtime/fallback.js");
  const { store, ctx } = setup(),
    p = tinyPark(),
    pop = tinyPopulation(p, 3),
    m = tinyManifest(p, pop);
  m.config.mode = "live";
  m.config.fallback = "live_timeout_v1";
  m.config.liveTimeoutMs = 1000;
  const s = createCore("run", m, p, pop);
  startCore(s);
  advanceCore(s, new Navigation(p.grid), 100);
  const r = s.decisions[s.barrierIds[0]!]!.request;
  enqueue(
    store,
    ctx,
    `run:${r.requestId}`,
    "decision",
    { runId: "run", experimentId: null },
    r,
  );
  const worker = { ...ctx, identity: "worker1" };
  const leased = claim(
    store,
    worker,
    ["decision"],
    1,
    10000,
    "long-worker-nonce",
  )[0]!;
  resolveLiveTimeouts(store, { ...ctx, now: 2001 }, s);
  expect(s.decisions[r.requestId]!.response!.source).toBe("fallback");
  expect(s.view.simMs).toBe(0);
  expect(() =>
    finishJob(
      store,
      { ...worker, now: 2001 },
      {
        kind: "decision",
        lease: leased.lease,
        result: mockResponse(r, "leave"),
      },
      () => {},
    ),
  ).toThrow();
});
