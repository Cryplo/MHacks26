import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import type * as C from "../contract/behavior-v1.js";
import { Client } from "../client/index.js";
import { tinyPark, tinyPopulation, tinyManifest } from "../fixtures/tiny.js";
import { mockResponse } from "../fixtures/mock-driver.js";
import { hash } from "../src/domain/primitives.js";
const cli =
  process.env.SPACETIME_CLI ?? "/tmp/mhacks-spacetime-2.10.2/spacetimedb-cli";
const captured = execFileSync(cli, ["login", "show", "--token"], {
  encoding: "utf8",
});
const token =
  process.env.SPACETIME_OPERATOR_TOKEN ??
  captured.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];
assert(token, "Local operator identity required");
const config = {
  uri: process.env.SPACETIME_URI ?? "http://127.0.0.1:3099",
  database: process.env.SPACETIME_DATABASE ?? "mhacks-engine-runtime",
  token,
};
const op = new Client(config),
  worker = new Client({ ...config, token: null }),
  viewer = new Client({ ...config, token: null });
const unwrap = <T>(r: C.Receipt<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.result;
};
const json = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
await op.connect();
await worker.connect();
await viewer.connect();
try {
  const identity = (await worker.query("session", {})).identity;
  unwrap(await op.wire("provision", "", { identity, roles: ["worker"] }));
  const park = tinyPark(),
    population = tinyPopulation(park, 3),
    manifest = tinyManifest(park, population);
  manifest.config.horizonMs = 360000;
  manifest.park = await op.putArtifact({
    kind: "park",
    mediaType: "application/json",
    bytes: json(park),
    scope: { runId: null, experimentId: null },
    commandId: randomUUID(),
  });
  manifest.population = await op.putArtifact({
    kind: "population",
    mediaType: "application/json",
    bytes: json(population),
    scope: { runId: null, experimentId: null },
    commandId: randomUUID(),
  });
  // Reuse the same registered immutable park revision on repeated smoke runs.
  const parks = await op.query("listParks", { cursor: null });
  const existing = parks.items.find(
    (p) => p.parkId === park.parkId && p.revision === park.revision,
  );
  if (existing) manifest.park = existing.artifact;
  else
    unwrap(
      await op.command(
        "registerPark",
        { artifact: manifest.park },
        randomUUID(),
      ),
    );
  const { runId } = unwrap(
    await op.command("createRun", { manifest }, randomUUID()),
  );
  let snapshots = 0,
    patches = 0,
    lastRevision = -1;
  const unsubscribe = op.subscribeLive(runId, {
    snapshot: (s) => {
      snapshots++;
      lastRevision = s.run.revision;
    },
    patch: (p) => {
      assert.equal(p.fromRevision, lastRevision);
      assert(p.toRevision > p.fromRevision);
      lastRevision = p.toRevision;
      patches++;
    },
    status: () => {},
    error: (e) => {
      throw new Error(e.message);
    },
  });
  const share = crypto.randomUUID() + crypto.randomUUID();
  unwrap(
    await op.command(
      "issueShare",
      {
        runId,
        access: "viewer",
        tokenHash: hash(share),
        expiresAtEpochMs: Date.now() + 120000,
      },
      randomUUID(),
    ),
  );
  unwrap(await viewer.command("redeemShare", { token: share }, randomUUID()));
  assert.equal((await viewer.query("getRun", { runId })).runId, runId);
  assert.equal(
    (await viewer.command("startRun", { runId }, randomUUID())).ok,
    false,
  );
  unwrap(await op.command("startRun", { runId }, randomUUID()));
  let lease = unwrap(
      await op.command(
        "acquireDriver",
        { runId, leaseMs: 120000 },
        randomUUID(),
      ),
    ),
    run = await op.query("getRun", { runId });
  let steps = 0;
  const stage = new Map<string, number>();
  while (run.status !== "completed") {
    assert(++steps < 1000, "Smoke iteration limit");
    const commandId = randomUUID(),
      input = {
        lease,
        expectedStep: run.stepIndex,
        expectedPhase: run.phase,
        maxSteps: 1,
      };
    const a = unwrap(await op.command("advanceRun", input, commandId));
    assert.deepEqual(
      unwrap(await op.command("advanceRun", input, commandId)),
      a,
    );
    const jobs = unwrap(
      await worker.command(
        "claimWork",
        {
          kinds: ["decision"],
          limit: 16,
          leaseMs: 30000,
          workerNonce: randomUUID(),
        },
        randomUUID(),
      ),
    ).items;
    for (const j of jobs) {
      assert.equal(j.kind, "decision");
      if (j.kind !== "decision") continue;
      const r = j.payload,
        phase = stage.get(r.groupId) ?? 0;
      const priorities =
        r.moment === "noticed" || r.moment === "stay_line"
          ? ["continue"]
          : r.moment === "closing_soon"
            ? ["leave"]
            : phase === 0
              ? ["buy_pass", "join_standard", "travel:ride"]
              : phase === 1
                ? ["order:meal", "travel:food"]
                : ["leave"];
      const chosen = priorities.find((id) =>
        r.options.some((o) => o.id === id),
      );
      assert(chosen, `No scripted choice for ${r.moment}`);
      if (chosen === "buy_pass" || chosen === "join_standard")
        stage.set(r.groupId, 1);
      if (chosen === "order:meal") stage.set(r.groupId, 2);
      const response = mockResponse(r, chosen);
      response.responseArtifact = await worker.putArtifact({
        kind: "model_response",
        mediaType: "application/json",
        bytes: json({ mock: true, probabilities: response.probabilities }),
        scope: j.scope,
        commandId: randomUUID(),
      });
      unwrap(
        await worker.command(
          "completeWork",
          { item: { kind: "decision", lease: j.lease, result: response } },
          randomUUID(),
        ),
      );
    }
    run = await op.query("getRun", { runId });
    if (lease.expiresAtEpochMs - Date.now() < 30000)
      lease = unwrap(
        await op.command(
          "renewDriver",
          { lease, leaseMs: 120000 },
          randomUUID(),
        ),
      );
  }
  const final = await op.query("getLiveSnapshot", { runId });
  assert.equal(final.metrics.admittedGuests, 3);
  assert.equal(final.metrics.guestsInPark, 0);
  assert.equal(final.metrics.measures.net_revenue_cents.value, 6000);
  assert.equal(final.metrics.measures.rides_per_guest.value, 1);
  assert.equal(final.metrics.measures.satisfaction_0_100.value, null);
  assert(snapshots > 0 && patches > 0);
  unsubscribe();
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        mode: "real SpacetimeDB + engine-owned mock provider",
        runId,
        steps,
        snapshots,
        patches,
        revenueCents: 6000,
        admitted: 3,
        departed: 3,
      },
      null,
      2,
    ),
  );
} finally {
  await op.close();
  await worker.close();
  await viewer.close();
}
