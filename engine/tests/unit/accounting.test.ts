import { it, expect } from "vitest";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { createCore, type QueueEntry } from "../../src/domain/state.js";
import { applyAction, refund } from "../../src/sim/actions.js";
import {
  loadVehicle,
  dispatch,
  completeSession,
} from "../../src/sim/services.js";
import { Navigation } from "../../src/navigation/grid.js";
import { quote } from "../../src/sim/observations.js";
import { releaseQueue } from "../../src/sim/common.js";
import {
  metrics,
  heatmap,
  freezeRating,
  acceptRating,
} from "../../src/accounting/metrics.js";
import { physicalHash } from "../../src/replay/physical.js";
import { moveSubstep } from "../../src/sim/motion.js";
import { fixtureRef } from "../../fixtures/tiny.js";
function setup() {
  const p = tinyPark(),
    pop = tinyPopulation(p, 3),
    s = createCore("run", tinyManifest(p, pop), p, pop),
    g = s.groups.g0!,
    nav = new Navigation(p.grid);
  for (const person of Object.values(s.persons)) {
    person.state = "deciding";
    person.position = { ...p.places[2]!.entrance };
    person.targetPlaceId = "ride";
    person.admittedAtMs = 0;
  }
  s.totals.admitted = 3;
  return { s, g, nav };
}
it("A-13 FIFO whole-party loading guards a missed lane head and does not bypass heads", () => {
  const q = (
    id: string,
    size: number,
    lane: "standard" | "pass",
    sequence: number,
    missed = 0,
  ): QueueEntry => ({
    id,
    groupId: id,
    placeId: "ride",
    agentIds: Array.from({ length: size }, (_, i) => `${id}:${i}`),
    lane,
    sequence,
    joinedAtMs: 0,
    originalJoinedAtMs: 0,
    promiseMs: null,
    missed,
    cart: null,
    waitMs: 0,
  });
  const a = q("a", 6, "standard", 1, 3),
    b = q("b", 2, "standard", 2),
    c = q("c", 4, "pass", 3);
  expect(loadVehicle([a, b, c], 8, 5000).map((x) => x.id)).toEqual(["a", "b"]);
  const d = q("d", 6, "standard", 1),
    e = q("e", 2, "standard", 2),
    f = q("f", 4, "pass", 3);
  expect(loadVehicle([d, e, f], 8, 5000).map((x) => x.id)).toEqual(["f"]);
  expect(d.missed).toBe(1);
});
it("A-15 A-16 pass upgrade charges only missing beneficiaries and keeps accrued wait", () => {
  const { s, g, nav } = setup();
  s.entitlements = ["a0"];
  applyAction(
    s,
    g,
    {
      kind: "join_queue",
      placeId: "ride",
      lane: "standard",
      riderIds: g.manifest.memberIds,
    },
    nav,
    "join",
  );
  s.view.simMs = 120000;
  s.queues[0]!.waitMs = 360000;
  const q = quote(s, g, s.park.pass.productId, 1500, ["a1", "a2"], "0");
  applyAction(
    s,
    g,
    {
      kind: "buy_pass_and_join",
      placeId: "ride",
      riderIds: g.manifest.memberIds,
      quote: q,
    },
    nav,
    "upgrade",
  );
  expect(g.balanceCents).toBe(17000);
  expect(s.queues).toHaveLength(1);
  expect(s.queues[0]!.lane).toBe("pass");
  expect(s.queues[0]!.waitMs).toBe(360000);
  expect(s.queues[0]!.originalJoinedAtMs).toBe(0);
  expect(s.totals.joinedEpisodes).toBe(3);
  expect(() =>
    applyAction(
      s,
      g,
      {
        kind: "buy_pass_and_join",
        placeId: "ride",
        riderIds: g.manifest.memberIds,
        quote: q,
      },
      nav,
      "duplicate",
    ),
  ).toThrow();
  expect(s.sales).toHaveLength(1);
  refund(s, s.sales[0]!.id, 1000);
  expect(g.balanceCents).toBe(18000);
  expect(() => refund(s, s.sales[0]!.id, 2001)).toThrow();
  expect(metrics(s).measures.net_revenue_cents.value).toBe(2000);
});
it("A-15 stale price rejects before any wallet, entitlement or queue mutation", () => {
  const { s, g, nav } = setup(),
    q = quote(s, g, s.park.pass.productId, 1500, g.manifest.memberIds, "0");
  s.passPriceCents = 2500;
  s.passRevision = 1;
  const before = physicalHash(s);
  expect(() =>
    applyAction(
      s,
      g,
      {
        kind: "buy_pass_and_join",
        placeId: "ride",
        riderIds: g.manifest.memberIds,
        quote: q,
      },
      nav,
      "stale",
    ),
  ).toThrow();
  expect(physicalHash(s)).toBe(before);
});
it("A-16 food charges at service start only and released unpaid carts cost nothing", () => {
  const { s, g, nav } = setup();
  for (const p of Object.values(s.persons)) {
    p.position = { ...s.places.food!.definition.entrance };
    p.targetPlaceId = "food";
  }
  const cart = [quote(s, g, "meal", 500, g.manifest.memberIds, "0")];
  applyAction(s, g, { kind: "order", placeId: "food", cart }, nav, "order");
  expect(g.balanceCents).toBe(20000);
  releaseQueue(s, s.queues[0]!.id, "closure");
  expect(g.balanceCents).toBe(20000);
  applyAction(s, g, { kind: "order", placeId: "food", cart }, nav, "order2");
  dispatch(s, "food");
  expect(g.balanceCents).toBe(18500);
  const session = s.sessions[0]!;
  s.view.simMs = session.endMs;
  completeSession(s, session);
  expect(s.sales).toHaveLength(1);
  expect(s.persons.a0!.needs.hunger).toBe(0);
});
it("A-19 3-person 120-second queue contributes six person-minutes with reconciled heat", () => {
  const { s, g, nav } = setup();
  applyAction(
    s,
    g,
    {
      kind: "join_queue",
      placeId: "ride",
      lane: "standard",
      riderIds: g.manifest.memberIds,
    },
    nav,
    "join",
  );
  for (let i = 0; i < 480; i++) {
    s.view.simMs = Math.floor(i / 20) * 5000;
    s.movementSubstep = i % 20;
    moveSubstep(s, nav);
  }
  s.view.simMs = 120000;
  expect(s.totals.queuePersonMs / 60000).toBe(6);
  expect(heatmap(s, "waiting_person_minutes", 0, 120000).total).toBeCloseTo(
    6,
    10,
  );
  releaseQueue(s, s.queues[0]!.id, "abandonment");
  expect(s.totals.queuePersonMs / 60000).toBe(6);
  expect(metrics(s).measures.abandonment_rate.value).toBe(1);
});
it("A-18 individual terminal rating delivery never changes physical hashes", () => {
  const { s, nav } = setup();
  freezeRating(s, "a0", "horizon", nav);
  freezeRating(s, "a1", "horizon", nav);
  const before = physicalHash(s),
    rating = Object.values(s.ratings)[0]!.request;
  acceptRating(s, {
    ratingId: rating.ratingId,
    evidenceHash: rating.evidenceHash,
    rubricVersion: rating.rubricVersion,
    scoreIndex: 3,
    probabilities: [0, 0, 0, 1, 0],
    source: "mock",
    modelReturned: "mock",
    responseArtifact: fixtureRef("model_response", {}),
    usage: {
      callId: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      priceVersion: null,
      queueMs: 0,
      httpMs: 0,
      attemptCount: 0,
    },
  });
  expect(physicalHash(s)).toBe(before);
  expect(s.persons.a1!.rating).toBeNull();
  expect(metrics(s).measures.satisfaction_0_100.value).toBe(75);
  expect(metrics(s).measures.satisfaction_0_100.coverage).toBeCloseTo(1 / 3);
});
it("A-14 a replayed or early service completion cannot duplicate rewards", () => {
  const { s, g, nav } = setup();
  applyAction(
    s,
    g,
    {
      kind: "join_queue",
      placeId: "ride",
      lane: "standard",
      riderIds: g.manifest.memberIds,
    },
    nav,
    "join",
  );
  dispatch(s, "ride");
  const session = s.sessions[0]!;
  completeSession(s, session);
  expect(s.totals.completedRiders).toBe(0);
  s.view.simMs = session.endMs;
  completeSession(s, session);
  const hash = physicalHash(s);
  completeSession(s, session);
  expect(physicalHash(s)).toBe(hash);
  expect(s.totals.completedRiders).toBe(3);
});
it("A-14 multiple vehicles respect occupied cycles and closure completes only existing sessions", () => {
  const { s, g, nav } = setup();
  const service = s.places.ride!.definition.service;
  if (service.kind !== "ride") throw new Error("fixture");
  service.vehicles = 2;
  service.dispatchMs = 60000;
  s.places.ride!.vehicleReadyMs = [0, 0];
  applyAction(
    s,
    g,
    {
      kind: "join_queue",
      placeId: "ride",
      lane: "standard",
      riderIds: g.manifest.memberIds,
    },
    nav,
    "join",
  );
  dispatch(s, "ride");
  const first = s.sessions[0]!;
  expect(first.vehicle).toBe(0);
  s.view.simMs = 60000;
  dispatch(s, "ride");
  expect(s.sessions[1]!.vehicle).toBe(1);
  expect(s.places.ride!.vehicleReadyMs).toEqual([120000, 180000]);
  s.places.ride!.closed = true;
  s.view.simMs = 90000;
  completeSession(s, first);
  expect(s.totals.completedRiders).toBe(3);
  s.view.simMs = 120000;
  dispatch(s, "ride");
  expect(s.sessions).toHaveLength(1);
});
it("A-14 unfinished occupied sessions are censored at horizon without fabricated exits or completions", async () => {
  const { startCore, advanceCore } = await import("../../src/sim/engine.js");
  const { s, g, nav } = setup();
  s.manifest.config.horizonMs = 5000;
  applyAction(
    s,
    g,
    {
      kind: "join_queue",
      placeId: "ride",
      lane: "standard",
      riderIds: g.manifest.memberIds,
    },
    nav,
    "join",
  );
  dispatch(s, "ride");
  startCore(s);
  advanceCore(s, nav, 100);
  expect(s.view.status).toBe("completed");
  expect(s.totals.completedRiders).toBe(0);
  expect(s.totals.departed).toBe(0);
  expect(s.sessions).toHaveLength(1);
  expect(Object.values(s.persons).every((p) => p.censored)).toBe(true);
  expect(Object.values(s.ratings)).toHaveLength(3);
});
