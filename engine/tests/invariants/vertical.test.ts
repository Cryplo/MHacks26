import { describe, it, expect } from "vitest";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { runMock, mockResponse } from "../../fixtures/mock-driver.js";
import { createCore } from "../../src/domain/state.js";
import {
  startCore,
  advanceCore,
  acceptDecision,
} from "../../src/sim/engine.js";
import { Navigation } from "../../src/navigation/grid.js";
import { physicalHash } from "../../src/replay/physical.js";
import { metrics, heatmap } from "../../src/accounting/metrics.js";
const setup = () => {
  const p = tinyPark(),
    pop = tinyPopulation(p),
    m = tinyManifest(p, pop);
  m.config.horizonMs = 600000;
  return createCore("run", m, p, pop);
};
describe("Real pure core with explicit mock response fixtures", () => {
  it("A-25 completes arrivals, continuous movement, rides, food purchases and physical exits", () => {
    const s = setup();
    runMock(s);
    expect(s.view.status).toBe("completed");
    expect(s.totals.admitted).toBe(12);
    expect(s.totals.departed).toBe(12);
    expect(s.totals.completedRiders).toBe(12);
    expect(s.sales).toHaveLength(8);
    expect(s.sales.reduce((n, x) => n + x.amountCents, 0)).toBe(24000);
    expect(
      Object.values(s.groups).reduce((n, g) => n + g.balanceCents, 0),
    ).toBe(56000);
    expect(s.sessions).toHaveLength(0);
    expect(s.queues).toHaveLength(0);
    expect(
      Object.values(s.persons).every(
        (p) => p.distanceM > 0 && p.state === "left",
      ),
    ).toBe(true);
    expect(s.events.filter((e) => e.kind === "service_completed")).toHaveLength(
      8,
    );
    expect(
      s.evidence.every(
        (e) => e.response.source === "mock" && e.outcome === "committed",
      ),
    ).toBe(true);
    expect(metrics(s).measures.satisfaction_0_100.value).toBeNull();
    expect(heatmap(s, "spending_cents", 0, s.view.simMs).total).toBe(24000);
    expect(
      heatmap(s, "waiting_person_minutes", 0, s.view.simMs).total,
    ).toBeCloseTo(s.totals.queuePersonMs / 60000, 8);
  });
  it("A-06 repeated blocked wakeups cannot advance physics or apply a response prefix", () => {
    const s = setup();
    for (const g of s.population.groups) g.arrivalMs = 0;
    for (const g of Object.values(s.groups)) g.manifest.arrivalMs = 0;
    startCore(s);
    const nav = new Navigation(s.park.grid);
    advanceCore(s, nav, 100);
    expect(s.view.blockedWorkIds).toHaveLength(4);
    const before = physicalHash(s),
      id = s.view.blockedWorkIds[0]!,
      r = s.decisions[id]!.request;
    acceptDecision(s, mockResponse(r, "travel:ride"));
    for (let i = 0; i < 5; i++) advanceCore(s, nav, 100);
    expect(physicalHash(s)).toBe(before);
    expect(s.evidence).toHaveLength(0);
    expect(s.view.simMs).toBe(0);
  });
  it("A-07 slow/fast budgets and reversed replies give identical physical results", () => {
    const a = setup(),
      b = setup();
    b.runId = "other";
    b.view.runId = "other";
    b.manifest.config.requestedSpeed = 100;
    runMock(a, { maxWork: 1 });
    runMock(b, { maxWork: 100, reverseResponses: true });
    expect(physicalHash(a)).toBe(physicalHash(b));
    expect(metrics(a).measures).toEqual(metrics(b).measures);
  });
});
