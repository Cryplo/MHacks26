import { it, expect, vi } from "vitest";
import { Client } from "../../client/index.js";
import type {
  LiveSnapshot,
  LivePatch,
  Receipt,
} from "../../contract/behavior-v1.js";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { createCore } from "../../src/domain/state.js";
import { snapshot } from "../../src/accounting/metrics.js";
import { hash } from "../../src/domain/primitives.js";
type TestConnection = {
  connection: unknown;
  flushLive: () => void;
  flushReplies: () => void;
  previous: Map<unknown, unknown>;
  live: Map<unknown, unknown>;
};
function harness() {
  const client = new Client({
      uri: "http://fixture",
      database: "fixture",
      token: null,
    }),
    internals = client as unknown as TestConnection,
    rows: { runId: string; body: string }[] = [],
    replies: { id: string; digest: string; body: string }[] = [],
    invoke = vi.fn(async () => {});
  internals.connection = {
    db: {
      liveRuns: { iter: () => rows.values() },
      myReplies: { iter: () => replies.values() },
    },
    reducers: { invoke },
    disconnect: () => {},
  };
  return { client, internals, rows, replies, invoke };
}
function state() {
  const p = tinyPark(),
    pop = tinyPopulation(p, 3);
  return snapshot(createCore("run", tinyManifest(p, pop), p, pop));
}
it("A-22 subscription resets gaps, ignores stale revisions, carries deletes and removes listeners", async () => {
  const { client, internals, rows } = harness(),
    s = state(),
    snapshots: LiveSnapshot[] = [],
    patches: LivePatch[] = [],
    errors: string[] = [];
  const stop = client.subscribeLive("run", {
    snapshot: (s) => snapshots.push(s),
    patch: (p) => patches.push(p),
    status: () => {},
    error: (e) => errors.push(e.code),
  });
  const emit = (x: LiveSnapshot) => {
    rows.splice(0, rows.length, { runId: "run", body: JSON.stringify(x) });
    internals.flushLive();
  };
  s.run.revision = 1;
  emit(s);
  emit(s);
  expect(snapshots).toHaveLength(1);
  expect(patches).toHaveLength(0);
  s.run.revision = 2;
  s.agents = s.agents.slice(1);
  emit(s);
  expect(patches[0]!.agents.removeIds).toEqual(["a0"]);
  expect(patches[0]!.fromRevision).toBe(1);
  s.run.revision = 1;
  emit(s);
  expect(patches).toHaveLength(1);
  s.run.revision = 5;
  emit(s);
  expect(snapshots).toHaveLength(2);
  rows.length = 0;
  internals.flushLive();
  expect(errors).toEqual(["FORBIDDEN"]);
  stop();
  expect(internals.live.size).toBe(0);
  expect(internals.previous.size).toBe(0);
  await client.close();
});
it("A-10 lost acknowledgement retries same wire command and resolves only matching durable receipt", async () => {
  vi.useFakeTimers();
  const { client, internals, replies, invoke } = harness();
  try {
    const pending = client.command("startRun", { runId: "run" }, "intent");
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]).toEqual(invoke.mock.calls[1]);
    const sent = invoke.mock.calls[0] as unknown as [
        { kind: string; name: string; payload: string },
      ],
      r: Receipt<unknown> = {
        commandId: "intent",
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Denied",
          retryable: false,
          fieldErrors: [],
        },
      };
    replies.push({
      id: "intent",
      digest: hash(sent[0]),
      body: JSON.stringify(r),
    });
    // Digest intentionally excludes transport ID, just as server receipts do.
    replies[0]!.digest = hash({
      kind: sent[0].kind,
      name: sent[0].name,
      payload: sent[0].payload,
    });
    internals.flushReplies();
    expect(await pending).toEqual(r);
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
